/**
 * Weapon legality and the mechanical bounds of weapon outcomes.
 * The rules compute what is *possible*; the author picks within it.
 */
import { type Vec3, distance, normalize, sub } from '../core/math/vec3.js';
import { type Explanation, check, info, allOk } from '../core/explain.js';
import { type SimTime, formatClock, parseClock } from '../core/time.js';
import type { Command } from '../events/types.js';
import { type MountDef, type WeaponDef, qualityAtLeast } from '../state/defs.js';
import type { Track, UnitState, WorldState } from '../state/types.js';
import {
  type Ctx,
  entityPosition,
  groupAirborne,
  groupPosition,
  leadAimPoint,
  mountDef,
  trackOf,
  weaponDef,
} from './world.js';
import { positionAt, maxSpeedOf } from './kinematics.js';
import { arcCheck } from './arcs.js';
import { capacityFree, checkExclusiveFree } from './resources.js';
import { earliestAligned } from './attitude.js';
import { firstWindow, rangeStep } from './search.js';

const clock = (ctx: Ctx, t: SimTime) => formatClock(t, parseClock(ctx.scenario.epoch));

interface Common {
  checks: Explanation[];
  unit?: UnitState;
  mount?: MountDef;
  weapon?: WeaponDef;
  track?: Track;
  earliest?: SimTime;
}

/** Checks shared by LAUNCH and ENGAGE: unit, mount, weapon, inventory, track knowledge. */
function commonChecks(
  ctx: Ctx,
  s: WorldState,
  unitId: string,
  mountId: string,
  weaponId: string,
  trackId: string,
  rounds: number,
  roles: WeaponDef['role'][],
): Common {
  const checks: Explanation[] = [];
  const unit = s.units[unitId];
  checks.push(check(`单位 ${unitId} 存在`, !!unit));
  if (!unit) return { checks };
  checks.push(check(`单位状态可作战（${unit.status}）`, unit.status === 'active' || unit.status === 'damaged'));
  const mount = mountDef(ctx, unit, mountId);
  checks.push(check(`发射装置 ${mountId} 存在`, !!mount));
  if (!mount) return { checks, unit };
  const wdef = ctx.catalog.weapons[weaponId];
  checks.push(check(`${mount.name} 可发射 ${weaponId}`, !!wdef && mount.weapons.includes(weaponId)));
  if (!wdef) return { checks, unit, mount };
  checks.push(check(`${wdef.name} 用途匹配（${roles.join('/')}）`, roles.includes(wdef.role)));
  const ammo = unit.mounts[mountId]?.ammo[weaponId] ?? 0;
  checks.push(check(`库存 ${wdef.name}: ${ammo} ≥ 需要 ${rounds}`, ammo >= rounds && rounds >= 1, { value: ammo }));

  const busyUntil = unit.mounts[mountId]?.busyUntil ?? 0;
  const free = busyUntil <= s.time;
  checks.push(check(free ? `${mount.name} 可用` : `${mount.name} 冷却/装填中，至 ${clock(ctx, busyUntil)}`, free));
  const earliest = free ? undefined : busyUntil;

  const track = trackOf(s, unitId, trackId);
  if (!track) {
    // Explain in side-safe terms where the track *is* on this side.
    const holders = Object.entries(s.knowledge)
      .filter(([uid, k]) => s.units[uid]?.side === unit.side && k[trackId])
      .map(([uid]) => uid);
    const inbound = s.messages.filter((m) => m.to === unitId && m.track.id === trackId);
    const children: Explanation[] = [];
    if (holders.length) children.push(info(`本方 ${holders.join(', ')} 持有该航迹，需要经数据链发送`));
    for (const m of inbound) children.push(info(`数据链报文 ${m.id} 正在途中，${clock(ctx, m.deliverAt)} 到达`, { refs: [m.sendEventId] }));
    checks.push(check(`${unitId} 本平台没有航迹 ${trackId}`, false, { children }));
    const eta = inbound.length ? Math.min(...inbound.map((m) => m.deliverAt)) : undefined;
    return { checks, unit, mount, weapon: wdef, earliest: eta ?? earliest };
  }
  checks.push(
    check(`航迹质量 ${track.quality} ≥ 需要 ${wdef.requiredQuality}`, qualityAtLeast(track.quality, wdef.requiredQuality), {
      refs: track.provenance,
    }),
  );
  const ageS = (s.time - track.lastUpdate) / 1000;
  checks.push(check(`航迹时龄 ${ageS.toFixed(1)} s ≤ ${wdef.maxTrackAgeS} s`, ageS <= wdef.maxTrackAgeS, { refs: track.provenance }));
  checks.push(check('航迹具有位置估计（非纯方位）', track.estimate.kind === 'position'));
  return { checks, unit, mount, weapon: wdef, track, earliest };
}

export interface LaunchPlan {
  launchTime: SimTime;
  origin: Vec3;
  aimPoint: Vec3;
  arrivalTime: SimTime;
  busyUntil: SimTime;
  pointing?: { az: number; el: number };
}

export function checkLaunch(
  ctx: Ctx,
  s: WorldState,
  cmd: Extract<Command, { type: 'LAUNCH' }>,
): { ok: boolean; checks: Explanation[]; earliest?: SimTime; plan?: LaunchPlan } {
  const c = commonChecks(ctx, s, cmd.unitId, cmd.mountId, cmd.weaponId, cmd.trackId, cmd.count, ['anti_ship', 'gun']);
  const { checks, unit, mount, weapon, track } = c;
  checks.push(check('发射数量须为正整数', Number.isSafeInteger(cmd.count) && cmd.count > 0));
  if (!unit || !mount || !weapon || !track || track.estimate.kind !== 'position')
    return { ok: false, checks, earliest: c.earliest };

  const here = positionAt(unit.motion, s.time);
  const lead = leadAimPoint(track, here, s.time, weapon.speedMps)!;
  const dist = distance(here, lead.aim);
  checks.push(
    check(`预测命中点距离 ${(dist / 1000).toFixed(1)} km ∈ [${weapon.minRangeM / 1000}, ${weapon.maxRangeM / 1000}] km`, dist >= weapon.minRangeM && dist <= weapon.maxRangeM),
  );

  const arc = arcCheck(ctx, unit, mount, lead.aim, s.time);
  checks.push(...arc.checks);
  let earliest = c.earliest;
  if (mount.kind === 'turret') {
    checks.push(checkExclusiveFree(unit, mount.resource));
    if (arc.trainS) checks.push(info(`炮塔调转 ${arc.trainS.toFixed(1)} s 后开火`));
  }
  if (mount.kind === 'fixed' && !arc.ok) {
    const claim = unit.claims.find((cl) => cl.owner.kind === 'mount' && cl.owner.id === mount.id);
    if (!claim) checks.push(info('提示: 先下达 ALIGN 命令，让舰体姿态控制把轴线对准目标'));
    else if (claim.status === 'suspended') checks.push(info(`对准请求 ${claim.id} 被更高优先级机动挂起`));
    else {
      const eta = earliestAligned(
        ctx,
        unit,
        mount.boresight,
        mount.halfAngleDeg,
        (t) => normalize(sub(leadAimPoint(track, positionAt(unit.motion, t), t, weapon.speedMps)!.aim, positionAt(unit.motion, t))),
        s.time,
        s.time + 3_600_000,
      );
      if (eta !== null) {
        checks.push(info(`按当前转向速率，预计 ${clock(ctx, eta)} 对准`));
        earliest = Math.max(earliest ?? 0, eta);
      }
    }
  }
  const ok = allOk(checks);
  if (!ok) return { ok, checks, earliest };

  const launchTime = s.time + Math.ceil((mount.kind === 'turret' ? arc.trainS ?? 0 : 0) * 1000);
  const origin = positionAt(unit.motion, launchTime);
  const lead2 = leadAimPoint(track, origin, launchTime, weapon.speedMps)!;
  const arrivalTime = launchTime + Math.ceil(lead2.tofS * 1000);
  checks.push(
    info(`飞行时间 ${lead2.tofS.toFixed(1)} s，预计 ${clock(ctx, arrivalTime)} 到达预测点`, {
      children: [info(`距离 ${(distance(origin, lead2.aim) / 1000).toFixed(2)} km ÷ ${weapon.speedMps} m/s`)],
    }),
  );
  return {
    ok,
    checks,
    plan: {
      launchTime,
      origin,
      aimPoint: lead2.aim,
      arrivalTime,
      busyUntil: launchTime + Math.ceil(cmd.count * mount.launchIntervalS * 1000),
      pointing: mount.kind === 'turret' ? arc.body : undefined,
    },
  };
}

export interface EngagementPlan {
  window: { start: SimTime; end: SimTime };
  channels: number;
  engagements: number;
  rounds: number;
  illuminators: number;
  bounds: { min: number; max: number };
  explanation: Explanation;
  groupId: string | null;
}

/**
 * Interceptor engagement. Engagement count E is the min of several
 * capacities; the binding one is flagged. Kill bounds are E × [lo, hi].
 */
export function checkEngage(
  ctx: Ctx,
  s: WorldState,
  cmd: Extract<Command, { type: 'ENGAGE' }>,
): { ok: boolean; checks: Explanation[]; earliest?: SimTime; plan?: EngagementPlan } {
  const c = commonChecks(ctx, s, cmd.unitId, cmd.mountId, cmd.weaponId, cmd.trackId, 1, ['sam', 'ciws']);
  const { checks, unit, mount, weapon, track } = c;
  if (!unit || !mount || !weapon || !track) return { ok: false, checks, earliest: c.earliest };

  // Referee side: the physical target behind the track.
  const truthId = s.truth.trackTargets[track.id];
  const group = truthId ? s.groups[truthId] : undefined;
  const interceptable = !!group && groupAirborne(group, s.time);
  checks.push(check('目标为飞行中的弹群（裁判层判定）', interceptable));

  const fcPer = weapon.fireControlChannels ?? 0;
  let channels = 1;
  if (cmd.channels !== undefined) checks.push(check('申请的火控通道数须为正整数', Number.isSafeInteger(cmd.channels) && cmd.channels > 0));
  if (fcPer > 0) {
    const free = Math.floor(capacityFree(ctx, unit, 'fire_control') / fcPer);
    channels = Math.min(cmd.channels ?? free, free);
    checks.push(check(`可用火控通道 ${free}，本次使用 ${channels}`, channels >= 1));
  }
  if (mount.kind === 'turret') checks.push(checkExclusiveFree(unit, mount.resource));
  if (!allOk(checks) || !group) return { ok: false, checks, earliest: c.earliest };

  // Engagement window: group inside [min, max] range (and inside turret arc) before it arrives.
  const probe = (t: SimTime) => {
    if (!groupAirborne(group, t)) return { ok: false, safeStepMs: Infinity };
    const pu = positionAt(unit.motion, t);
    const pg = groupPosition(group, t);
    const d = distance(pu, pg);
    const closing = maxSpeedOf(unit.motion) + group.speedMps;
    let ok = d >= weapon.minRangeM && d <= weapon.maxRangeM;
    let step = Math.min(rangeStep(d, weapon.minRangeM, closing), rangeStep(d, weapon.maxRangeM, closing));
    if (ok && mount.kind !== 'vls') {
      ok = arcCheck(ctx, unit, mount, pg, t).ok;
      step = Math.min(step, 250);
    }
    return { ok, safeStepMs: step };
  };
  const w = firstWindow(probe, s.time, group.arrivalTime);
  const arcNote = mount.kind === 'turret' ? arcCheck(ctx, unit, mount, groupPosition(group, s.time), s.time) : null;
  checks.push(
    check(w ? `交战窗口 ${clock(ctx, w.start)} – ${clock(ctx, w.end)}` : '弹群到达前不会进入交战包线/射界', !!w, {
      children: arcNote && !arcNote.ok ? arcNote.checks : undefined,
    }),
  );
  if (!w) return { ok: false, checks };

  const windowS = (w.end - w.start) / 1000;
  const cycleS = weapon.engagementCycleS ?? 5;
  const salvo = weapon.salvoPerEngagement ?? 1;
  const cycles = Math.floor(windowS / cycleS);
  const ammo = unit.mounts[mount.id]?.ammo[weapon.id] ?? 0;
  const factors: { label: string; cap: number; detail: Explanation[] }[] = [
    {
      label: `火控/交战通道 ${channels} × 交战周期 ${cycles}`,
      cap: channels * cycles,
      detail: [info(`有效交战窗口 ${windowS.toFixed(1)} s`), info(`每次交战循环 ${cycleS} s`)],
    },
    { label: `库存 ${ammo} ÷ 每目标齐射 ${salvo}`, cap: Math.floor(ammo / salvo), detail: [] },
    { label: `弹群剩余数量`, cap: group.count, detail: [] },
  ];
  let illuminators = 0;
  if (weapon.illuminatorTimeS) {
    const freeIl = capacityFree(ctx, unit, 'illuminator');
    const perIl = Math.floor(windowS / weapon.illuminatorTimeS);
    factors.push({
      label: `照射器 ${freeIl} × 每部可支持 ${perIl} 次`,
      cap: freeIl * perIl,
      detail: [info(`每次末段照射 ${weapon.illuminatorTimeS} s`)],
    });
    illuminators = freeIl;
  }
  const E = Math.max(0, Math.min(...factors.map((f) => f.cap)));
  const [lo, hi] = weapon.killBounds ?? [0, 1];
  const max = Math.min(group.count, Math.floor(E * hi + 1e-9));
  const min = Math.min(max, Math.floor(E * lo + 1e-9));
  if (weapon.illuminatorTimeS) {
    const perIl = Math.floor(windowS / weapon.illuminatorTimeS);
    illuminators = Math.min(illuminators, perIl > 0 ? Math.ceil(E / perIl) : 0);
  }

  const explanation: Explanation = info(`合法拦截区间 [${min}, ${max}]`, {
    children: [
      info(`可完成交战次数 E = ${E}`, {
        children: factors.map((f) => info(f.label, { value: f.cap, binding: f.cap === E, children: f.detail })),
      }),
      info(`每次交战击毁界 [${lo}, ${hi}] → 最少 ⌊${E}×${lo}⌋ = ${min}，最多 min(⌊${E}×${hi}⌋, 剩余 ${group.count}) = ${max}`),
      info(`消耗拦截弹 ${E * salvo} 发（${E} 次 × 每次 ${salvo} 发）`),
    ],
  });
  checks.push(check(`至少可完成一次交战`, E >= 1, { children: [explanation] }));
  const ok = allOk(checks);
  return {
    ok,
    checks,
    plan: ok
      ? { window: w, channels, engagements: E, rounds: E * salvo, illuminators, bounds: { min, max }, explanation, groupId: group.id }
      : undefined,
  };
}

/** Terminal-phase bounds when a salvo reaches its aim point. */
export function impactBounds(
  ctx: Ctx,
  s: WorldState,
  groupId: string,
): { targetId: string | null; bounds: { min: number; max: number }; explanation: Explanation } {
  const g = s.groups[groupId]!;
  const w = weaponDef(ctx, g.weaponId);
  const targetId = s.truth.trackTargets[g.targetTrackId] ?? null;
  const basket = w.seekerBasketM ?? 500;
  if (!targetId || !s.units[targetId] || s.units[targetId]!.status === 'destroyed') {
    return { targetId, bounds: { min: 0, max: 0 }, explanation: check('目标已不存在或不是舰艇 → 全部落空', false) };
  }
  const miss = distance(entityPosition(s, targetId, g.arrivalTime), g.aimPoint);
  const inBasket = miss <= basket;
  const [lo, hi] = w.terminalBounds ?? [0, 1];
  const max = inBasket ? Math.floor(g.count * hi + 1e-9) : 0;
  const min = inBasket ? Math.min(max, Math.floor(g.count * lo + 1e-9)) : 0;
  return {
    targetId,
    bounds: { min, max },
    explanation: info(`合法命中区间 [${min}, ${max}]`, {
      children: [
        check(`目标距预测点 ${(miss / 1000).toFixed(2)} km ≤ 导引头捕获范围 ${(basket / 1000).toFixed(2)} km`, inBasket),
        info(`到达弹数 ${g.count}，每发末段界 [${lo}, ${hi}]`),
      ],
    }),
  };
}

