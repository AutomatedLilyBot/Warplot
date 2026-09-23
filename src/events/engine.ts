/**
 * Deterministic state transition: (state, command) → (state', events).
 *
 * - Every command is validated first; illegal commands change nothing and
 *   come back with a reason tree (Verdict).
 * - Uncertain outcomes are never decided here: they become Opportunities
 *   which halt time until the author RESOLVEs them.
 * - No randomness, no wall clock, ids from counters → replay is exact.
 */
import { type Explanation, check, info, allOk } from '../core/explain.js';
import { type SimTime, formatClock, parseClock } from '../core/time.js';
import { length, normalize, sub } from '../core/math/vec3.js';
import { quatFromHeading, type Quat } from '../core/math/quat.js';
import { type TrackQuality, TRACK_QUALITIES, qualityAtLeast, qualityRank } from '../state/defs.js';
import type { MissileGroupState, ResourceClaim, Track, UnitState, WorldState } from '../state/types.js';
import type {
  ApplyResult,
  Command,
  Decision,
  EventBody,
  EventKind,
  Opportunity,
  SimEvent,
  Verdict,
} from './types.js';
import {
  type Ctx,
  RuleError,
  classOf,
  entityPosition,
  entityVelocity,
  mountDef,
  sensorDef,
  trackOf,
  weaponDef,
} from '../rules/world.js';
import { planRoute, positionAt, stationaryPlan, velocityAt } from '../rules/kinematics.js';
import { detectability } from '../rules/detection.js';
import { checkTransmit } from '../rules/comms.js';
import { checkEngage, checkLaunch, impactBounds } from '../rules/weapons.js';
import { checkExclusiveFree, planAttitudeClaim, refreshAttitudeGoal, resumeSuspended } from '../rules/resources.js';
import { attitudeClaims } from '../rules/attitude.js';
import { type Scheduled, pairKey, scheduleNext } from './scheduler.js';

export const DEFAULT_ADVANCE_MS = 3_600_000;

const clk = (ctx: Ctx, t: SimTime) => formatClock(t, parseClock(ctx.scenario.epoch));

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

export function createInitialState(ctx: Ctx): WorldState {
  const s: WorldState = {
    scenarioId: ctx.scenario.id,
    time: 0,
    seq: {},
    units: {},
    groups: {},
    knowledge: {},
    truth: { trackTargets: {} },
    messages: [],
    engagements: {},
    opportunities: {},
    lastOffered: {},
    reportedArrivals: {},
    log: [],
  };
  for (const setup of ctx.scenario.units) {
    const cls = ctx.catalog.unitClasses[setup.classId];
    if (!cls) throw new RuleError(`scenario: unit ${setup.id} has unknown class ${setup.classId}`);
    if (!ctx.scenario.sides.some((sd) => sd.id === setup.side)) throw new RuleError(`scenario: unit ${setup.id} has unknown side`);
    const speed = setup.velocity ? length(setup.velocity) : 0;
    const motion = setup.route?.length
      ? planRoute(0, setup.position, speed, setup.velocity ?? [1, 0, 0], setup.route, cls)
      : stationaryPlan(0, setup.position, setup.velocity);
    let q: Quat = setup.orientation ?? quatFromHeading(setup.headingDeg ?? 0);
    if (!setup.orientation && setup.headingDeg === undefined && setup.velocity && speed > 0)
      q = quatFromHeading((Math.atan2(setup.velocity[1], setup.velocity[0]) * 180) / Math.PI);
    const mounts: UnitState['mounts'] = {};
    for (const m of cls.mounts) {
      const load = setup.loadout[m.id] ?? {};
      const total = Object.values(load).reduce((a, b) => a + b, 0);
      if (total > m.capacity) throw new RuleError(`scenario: ${setup.id}.${m.id} loadout ${total} exceeds capacity ${m.capacity}`);
      for (const w of Object.keys(load))
        if (!m.weapons.includes(w)) throw new RuleError(`scenario: ${setup.id}.${m.id} cannot carry ${w}`);
      mounts[m.id] = { ammo: { ...load }, busyUntil: 0, ...(m.kind === 'turret' ? { pointing: { az: 0, el: 0 } } : {}) };
    }
    for (const mid of Object.keys(setup.loadout))
      if (!cls.mounts.some((m) => m.id === mid)) throw new RuleError(`scenario: ${setup.id} has no mount ${mid}`);
    s.units[setup.id] = {
      id: setup.id,
      name: setup.name,
      side: setup.side,
      classId: setup.classId,
      status: 'active',
      motion,
      attitude: { t0: 0, q0: q, goal: null },
      sensorsOn: Object.fromEntries(cls.sensors.map((sid) => [sid, (setup.sensorsOn ?? []).includes(sid)])),
      mounts,
      claims: [],
      hitsTaken: 0,
    };
    s.knowledge[setup.id] = {};
  }
  const body: EventBody = { action: 'SCENARIO_START', summary: `想定开始: ${ctx.scenario.name}`, requires: [], produces: [] };
  emit(s, -1, { kind: 'SCENARIO_START', truth: body, sides: allSides(ctx, body) });
  return s;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nextId(s: WorldState, key: string): number {
  const n = (s.seq[key] ?? 0) + 1;
  s.seq[key] = n;
  return n;
}

const allSides = (ctx: Ctx, body: EventBody): Record<string, EventBody> =>
  Object.fromEntries(ctx.scenario.sides.map((sd) => [sd.id, body]));

function emit(
  s: WorldState,
  commandIndex: number,
  e: { kind: EventKind; truth: EventBody; sides?: Record<string, EventBody>; causedBy?: string[]; notable?: boolean; time?: SimTime },
): SimEvent {
  const ev: SimEvent = {
    id: `E${nextId(s, 'global:event')}`,
    time: e.time ?? s.time,
    kind: e.kind,
    commandIndex,
    causedBy: e.causedBy ?? [],
    truth: e.truth,
    sides: e.sides ?? {},
    ...(e.notable ? { notable: true } : {}),
  };
  s.log.push(ev);
  return ev;
}

const body = (action: string, summary: string, extra: Partial<EventBody> = {}): EventBody => ({
  action,
  summary,
  requires: [],
  produces: [],
  ...extra,
});

function effectiveQuality(tr: Track): TrackQuality {
  const qs = Object.values(tr.holds);
  if (!qs.length) return tr.quality;
  return qs.reduce((a, b) => (qualityRank(b) > qualityRank(a) ? b : a));
}

/** Re-derive a held track's estimate from truth at the current time. */
function refreshTrack(ctx: Ctx, s: WorldState, observer: UnitState, tr: Track): void {
  const target = s.truth.trackTargets[tr.id];
  if (!target || !Object.keys(tr.holds).length) return;
  tr.quality = effectiveQuality(tr);
  const pos = entityPosition(s, target, s.time);
  if (qualityAtLeast(tr.quality, 'LOCALIZED')) {
    const unc = Math.min(...Object.keys(tr.holds).map((sid) => sensorDef(ctx, sid).uncertaintyM));
    tr.estimate = { kind: 'position', position: pos, velocity: entityVelocity(s, target, s.time), uncertaintyM: unc };
  } else {
    const origin = positionAt(observer.motion, s.time);
    tr.estimate = { kind: 'bearing', origin, direction: normalize(sub(pos, origin)) };
  }
  tr.lastUpdate = s.time;
}

/** Jump to time t: refresh held tracks and attitude goals (the only time-dependent stored data). */
function moveTo(ctx: Ctx, s: WorldState, t: SimTime): void {
  s.time = t;
  for (const [uid, tracks] of Object.entries(s.knowledge)) {
    const u = s.units[uid]!;
    for (const tr of Object.values(tracks)) refreshTrack(ctx, s, u, tr);
  }
  for (const u of Object.values(s.units))
    if (attitudeClaims(u).some((c) => c.constraint?.kind === 'axis_cone')) refreshAttitudeGoal(ctx, s, u, t);
}

function draft(s: WorldState): WorldState {
  const d = structuredClone({ ...s, log: [] as SimEvent[] });
  d.log = s.log.slice();
  return d;
}

const unitUsable = (u: UnitState | undefined) => !!u && (u.status === 'active' || u.status === 'damaged');

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function pendingOpportunities(s: WorldState): Opportunity[] {
  return Object.values(s.opportunities).filter((o) => o.status === 'pending');
}

export function validate(ctx: Ctx, s: WorldState, cmd: Command): Verdict {
  try {
    return validateInner(ctx, s, cmd);
  } catch (e) {
    if (e instanceof RuleError) return { ok: false, checks: [check(e.message, false)] };
    throw e;
  }
}

function verdict(checks: Explanation[], earliest?: SimTime): Verdict {
  return { ok: allOk(checks), checks, ...(earliest !== undefined ? { earliest } : {}) };
}

function unitChecks(s: WorldState, unitId: string): Explanation[] {
  const u = s.units[unitId];
  return [check(`单位 ${unitId} 存在`, !!u), ...(u ? [check(`单位状态可执行命令（${u.status}）`, unitUsable(u))] : [])];
}

function validateInner(ctx: Ctx, s: WorldState, cmd: Command): Verdict {
  switch (cmd.type) {
    case 'ADVANCE': {
      const pend = pendingOpportunities(s);
      return verdict([
        check(pend.length ? `有 ${pend.length} 个待裁定机会，必须先裁定` : '没有待裁定机会', pend.length === 0, {
          children: pend.map((o) => info(`${o.id} (${o.kind})`)),
        }),
        check('目标时间晚于当前时间', cmd.until === undefined || cmd.until > s.time),
      ]);
    }
    case 'SET_ROUTE': {
      const c = unitChecks(s, cmd.unitId);
      const u = s.units[cmd.unitId];
      if (u) {
        const tr = u.claims.find((cl) => cl.resource === 'hull_translation' && cl.status === 'active');
        c.push(check(tr ? `hull_translation 已被 ${tr.owner.label} 占用` : 'hull_translation 空闲', !tr));
      }
      c.push(check('航路点速度非负', cmd.waypoints.every((w) => (w.speedMps ?? 0) >= 0)));
      return verdict(c);
    }
    case 'SET_SENSOR': {
      const u = s.units[cmd.unitId];
      const c = [check(`单位 ${cmd.unitId} 存在`, !!u)];
      if (u) {
        c.push(check(`单位装有传感器 ${cmd.sensorId}`, classOf(ctx, u).sensors.includes(cmd.sensorId)));
        if (cmd.on) c.push(check(`单位状态允许开机（${u.status}）`, unitUsable(u)));
      }
      return verdict(c);
    }
    case 'TRANSMIT': {
      const r = checkTransmit(ctx, s, cmd);
      return verdict(r.checks);
    }
    case 'LAUNCH': {
      const r = checkLaunch(ctx, s, cmd);
      return verdict(r.checks, r.earliest);
    }
    case 'ENGAGE': {
      const r = checkEngage(ctx, s, cmd);
      return verdict(r.checks, r.earliest);
    }
    case 'ALIGN': {
      const c = unitChecks(s, cmd.unitId);
      const u = s.units[cmd.unitId];
      if (!u) return verdict(c);
      const m = mountDef(ctx, u, cmd.mountId);
      c.push(check(`${cmd.mountId} 是固定武器（需舰体姿态）`, m?.kind === 'fixed'));
      const tr = trackOf(s, u.id, cmd.trackId);
      c.push(check(`${u.id} 掌握航迹 ${cmd.trackId}`, !!tr));
      if (!allOk(c) || m?.kind !== 'fixed') return verdict(c);
      const claim = alignClaim(u, m.id, m.name, m.boresight, m.halfAngleDeg, cmd.trackId, cmd.priority, s.time, 'probe');
      const shadow: UnitState = { ...u, claims: u.claims.filter((cl) => !(cl.owner.kind === 'mount' && cl.owner.id === m.id)) };
      const p = planAttitudeClaim(ctx, s, shadow, claim, s.time);
      c.push(p.explanation);
      return verdict(c);
    }
    case 'MANEUVER': {
      const c = unitChecks(s, cmd.unitId);
      const u = s.units[cmd.unitId];
      c.push(check('持续时间 > 0', cmd.durationS > 0));
      if (!u || !allOk(c)) return verdict(c);
      const claim = maneuverClaim(cmd, s.time, 'probe');
      c.push(planAttitudeClaim(ctx, s, u, claim, s.time).explanation);
      if (cmd.claimsTranslation) c.push(checkExclusiveFree(u, 'hull_translation', cmd.priority));
      return verdict(c);
    }
    case 'RELEASE_CLAIM': {
      const u = s.units[cmd.unitId];
      const cl = u?.claims.find((c) => c.id === cmd.claimId);
      return verdict([
        check(`单位 ${cmd.unitId} 存在`, !!u),
        check(`占用 ${cmd.claimId} 存在`, !!cl),
        ...(cl ? [check('交战占用由交战结束自动释放', cl.owner.kind !== 'engagement')] : []),
      ]);
    }
    case 'RESOLVE':
      return validateResolve(ctx, s, cmd.opportunityId, cmd.decision);
    case 'SET_UNIT_STATUS':
      return verdict([check(`单位 ${cmd.unitId} 存在`, !!s.units[cmd.unitId])]);
    case 'NOTE':
      return verdict([check('备注非空', cmd.text.trim().length > 0)]);
  }
}

function validateResolve(ctx: Ctx, s: WorldState, oppId: string, d: Decision): Verdict {
  const o = s.opportunities[oppId];
  const c = [check(`机会 ${oppId} 存在`, !!o)];
  if (!o) return verdict(c);
  c.push(check('机会尚未裁定', o.status === 'pending'));
  c.push(check(`裁定类型匹配（${o.kind}）`, o.kind === d.kind));
  if (!allOk(c)) return verdict(c);
  if (o.kind === 'detection' && d.kind === 'detection' && d.detected) {
    c.push(
      check(
        `航迹质量 ${d.quality} ∈ [DETECTED, ${o.maxQuality}]`,
        TRACK_QUALITIES.includes(d.quality) && qualityAtLeast(d.quality, 'DETECTED') && qualityAtLeast(o.maxQuality, d.quality),
      ),
    );
    if (d.correlateWith) c.push(check(`关联航迹 ${d.correlateWith} 属于观测平台`, !!trackOf(s, o.observerId, d.correlateWith)));
  }
  const inBounds = (n: number, b: { min: number; max: number }) =>
    check(`${n} ∈ 合法区间 [${b.min}, ${b.max}]`, Number.isInteger(n) && n >= b.min && n <= b.max, { children: [o.explanation] });
  if (o.kind === 'intercept' && d.kind === 'intercept') c.push(inBounds(d.intercepted, currentInterceptBounds(s, o)));
  if (o.kind === 'impact' && d.kind === 'impact') c.push(inBounds(d.hits, o.bounds));
  return verdict(c);
}

/** Intercept bounds re-clamped to the group's count at resolution time. */
function currentInterceptBounds(s: WorldState, o: Extract<Opportunity, { kind: 'intercept' }>) {
  const left = o.groupId ? s.groups[o.groupId]?.count ?? 0 : 0;
  const max = Math.min(o.bounds.max, left);
  return { min: Math.min(o.bounds.min, max), max };
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

function alignClaim(
  u: UnitState,
  mountId: string,
  mountName: string,
  boresight: [number, number, number],
  halfAngleDeg: number,
  trackId: string,
  priority: number,
  t: SimTime,
  id: string,
): ResourceClaim {
  return {
    id,
    resource: 'hull_attitude',
    owner: { kind: 'mount', id: mountId, label: `${u.name}.${mountName} ALIGN_TO ${trackId}` },
    priority,
    constraint: { kind: 'axis_cone', bodyAxis: boresight, target: { kind: 'track', trackId }, halfAngleDeg },
    since: t,
    until: null,
    status: 'active',
  };
}

function maneuverClaim(cmd: Extract<Command, { type: 'MANEUVER' }>, t: SimTime, id: string): ResourceClaim {
  return {
    id,
    resource: 'hull_attitude',
    owner: { kind: 'maneuver', id, label: cmd.label },
    priority: cmd.priority,
    constraint: cmd.attitude ?? { kind: 'exclusive' },
    since: t,
    until: t + Math.round(cmd.durationS * 1000),
    status: 'active',
  };
}

function addAttitudeClaim(ctx: Ctx, s: WorldState, u: UnitState, claim: ResourceClaim, ci: number, causedBy: string[]): void {
  const plan = planAttitudeClaim(ctx, s, u, claim, s.time);
  u.claims.push(claim);
  const own = (b: EventBody) => ({ [u.side]: b });
  const b = body('CLAIM_ADDED', `${claim.owner.label} 占用 ${claim.resource}（优先级 ${claim.priority}）`, {
    actor: u.id,
    produces: [{ label: `claim ${claim.id}` }],
    data: { claimId: claim.id },
  });
  const ev = emit(s, ci, { kind: 'CLAIM_ADDED', truth: b, sides: own(b), causedBy });
  for (const id of plan.suspend) {
    const c = u.claims.find((x) => x.id === id)!;
    c.status = 'suspended';
    const sb = body('CLAIM_SUSPENDED', `${c.owner.label} 被 ${claim.owner.label} 挂起（优先级 ${c.priority} < ${claim.priority}）`, {
      actor: u.id,
      data: { claimId: c.id, by: claim.id },
    });
    emit(s, ci, { kind: 'CLAIM_SUSPENDED', truth: sb, sides: own(sb), causedBy: [ev.id], notable: true });
  }
  refreshAttitudeGoal(ctx, s, u, s.time);
}

function releaseClaim(ctx: Ctx, s: WorldState, u: UnitState, claimId: string, ci: number, why: string, causedBy: string[]): void {
  const c = u.claims.find((x) => x.id === claimId);
  if (!c) return;
  u.claims = u.claims.filter((x) => x.id !== claimId);
  const own = (b: EventBody) => ({ [u.side]: b });
  const b = body('CLAIM_RELEASED', `${c.owner.label} 释放 ${c.resource}（${why}）`, { actor: u.id, data: { claimId } });
  const ev = emit(s, ci, { kind: 'CLAIM_RELEASED', truth: b, sides: own(b), causedBy });
  if (c.resource === 'hull_attitude') {
    for (const id of resumeSuspended(ctx, s, u, s.time)) {
      const r = u.claims.find((x) => x.id === id)!;
      const rb = body('CLAIM_RESUMED', `${r.owner.label} 恢复`, { actor: u.id, data: { claimId: id } });
      emit(s, ci, { kind: 'CLAIM_RESUMED', truth: rb, sides: own(rb), causedBy: [ev.id], notable: true });
    }
    refreshAttitudeGoal(ctx, s, u, s.time);
  }
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export function applyCommand(ctx: Ctx, s: WorldState, cmd: Command, ci: number): { state: WorldState; result: ApplyResult } {
  const v = validate(ctx, s, cmd);
  if (!v.ok) return { state: s, result: { ok: false, verdict: v, events: [] } };
  const d = draft(s);
  const before = d.log.length;
  HANDLERS[cmd.type](ctx, d, cmd as never, ci);
  return { state: d, result: { ok: true, verdict: v, events: d.log.slice(before) } };
}

type Handler<T extends Command['type']> = (ctx: Ctx, s: WorldState, cmd: Extract<Command, { type: T }>, ci: number) => void;

const HANDLERS: { [K in Command['type']]: Handler<K> } = {
  ADVANCE: advance,

  SET_ROUTE(ctx, s, cmd, ci) {
    const u = s.units[cmd.unitId]!;
    const v = velocityAt(u.motion, s.time);
    u.motion = planRoute(s.time, positionAt(u.motion, s.time), length(v), v, cmd.waypoints, classOf(ctx, u));
    delete s.reportedArrivals[u.id];
    const eta = u.motion.arrivesAt;
    const b = body('SET_ROUTE', `${u.name} 新航路 ${cmd.waypoints.length} 个航路点${eta !== null ? `，预计 ${clk(ctx, eta)} 到达终点` : ''}`, {
      actor: u.id,
      data: { waypoints: cmd.waypoints, arrivesAt: eta },
    });
    emit(s, ci, { kind: 'ROUTE_SET', truth: b, sides: { [u.side]: b } });
  },

  SET_SENSOR(ctx, s, cmd, ci) {
    const u = s.units[cmd.unitId]!;
    u.sensorsOn[cmd.sensorId] = cmd.on;
    const lost: string[] = [];
    if (!cmd.on)
      for (const tr of Object.values(s.knowledge[u.id]!))
        if (tr.holds[cmd.sensorId]) {
          delete tr.holds[cmd.sensorId];
          lost.push(tr.id);
        }
    const b = body('SET_SENSOR', `${u.name} ${sensorDef(ctx, cmd.sensorId).name} ${cmd.on ? '开机' : '关机'}`, {
      actor: u.id,
      data: { sensorId: cmd.sensorId, on: cmd.on, releasedTracks: lost },
    });
    emit(s, ci, { kind: 'SENSOR_SET', truth: b, sides: { [u.side]: b } });
  },

  TRANSMIT(ctx, s, cmd, ci) {
    const r = checkTransmit(ctx, s, cmd);
    const from = s.units[cmd.from]!;
    const tr = trackOf(s, cmd.from, cmd.trackId)!;
    const snapshot: Track = { ...structuredClone(tr), holds: {}, quality: effectiveQuality(tr) };
    const b = body('TRANSMIT', `${from.name} 经 ${cmd.linkId} 向 ${s.units[cmd.to]!.name} 发送航迹 ${tr.id}（${snapshot.quality}），${clk(ctx, r.deliverAt!)} 到达`, {
      actor: from.id,
      target: cmd.to,
      requires: [{ label: `${from.id} 掌握 ${tr.id}` }, ...tr.provenance.map((ref) => ({ label: `航迹来源`, ref }))],
      produces: [{ label: `报文在途，${clk(ctx, r.deliverAt!)} 到达` }],
      data: { linkId: cmd.linkId, trackId: tr.id, deliverAt: r.deliverAt },
    });
    const ev = emit(s, ci, { kind: 'TRANSMIT', truth: b, sides: { [from.side]: b }, causedBy: tr.provenance.slice() });
    s.messages.push({
      id: `${from.side}-M${nextId(s, `${from.side}:msg`)}`,
      side: from.side,
      linkId: cmd.linkId,
      from: cmd.from,
      to: cmd.to,
      sentAt: s.time,
      deliverAt: r.deliverAt!,
      track: snapshot,
      sendEventId: ev.id,
    });
  },

  LAUNCH(ctx, s, cmd, ci) {
    const r = checkLaunch(ctx, s, cmd);
    const plan = r.plan!;
    const u = s.units[cmd.unitId]!;
    const w = weaponDef(ctx, cmd.weaponId);
    const tr = trackOf(s, u.id, cmd.trackId)!;
    const ms = u.mounts[cmd.mountId]!;
    const before = ms.ammo[cmd.weaponId]!;
    ms.ammo[cmd.weaponId] = before - cmd.count;
    ms.busyUntil = plan.busyUntil;
    if (plan.pointing) ms.pointing = plan.pointing;
    const gid = `${u.side}-MG${nextId(s, `${u.side}:group`)}`;
    const b = body('LAUNCH', `${u.name} ${mountDef(ctx, u, cmd.mountId)!.name} 向航迹 ${tr.id} 发射 ${cmd.count} × ${w.name}，${clk(ctx, plan.arrivalTime)} 到达`, {
      actor: u.id,
      target: tr.id,
      requires: [
        ...tr.provenance.map((ref) => ({ label: '航迹来源', ref })),
        { label: `航迹质量 ${tr.quality} ≥ ${w.requiredQuality}` },
        { label: `库存 ${before} → ${before - cmd.count}` },
        { label: `${cmd.mountId} 可用` },
      ],
      produces: [{ label: `弹群 ${gid}` }],
      data: { groupId: gid, count: cmd.count, launchTime: plan.launchTime, arrivalTime: plan.arrivalTime, checks: r.checks },
    });
    const ev = emit(s, ci, { kind: 'LAUNCH', truth: b, sides: { [u.side]: b }, causedBy: tr.provenance.slice() });
    const g: MissileGroupState = {
      id: gid,
      side: u.side,
      weaponId: w.id,
      initialCount: cmd.count,
      count: cmd.count,
      launcherId: u.id,
      mountId: cmd.mountId,
      targetTrackId: tr.id,
      launchTime: plan.launchTime,
      origin: plan.origin,
      aimPoint: plan.aimPoint,
      speedMps: w.speedMps,
      arrivalTime: plan.arrivalTime,
      status: 'flying',
      intercepted: 0,
      hits: 0,
      misses: 0,
      launchEventId: ev.id,
    };
    s.groups[gid] = g;
  },

  ENGAGE(ctx, s, cmd, ci) {
    const r = checkEngage(ctx, s, cmd);
    const plan = r.plan!;
    const u = s.units[cmd.unitId]!;
    const w = weaponDef(ctx, cmd.weaponId);
    const m = mountDef(ctx, u, cmd.mountId)!;
    const tr = trackOf(s, u.id, cmd.trackId)!;
    const ms = u.mounts[cmd.mountId]!;
    ms.ammo[w.id] = ms.ammo[w.id]! - plan.rounds;
    const eid = `${u.side}-ENG${nextId(s, `${u.side}:eng`)}`;
    const claims: ResourceClaim[] = [];
    const mk = (resource: string, amount?: number): ResourceClaim => ({
      id: `${u.side}-C${nextId(s, `${u.side}:claim`)}`,
      resource,
      owner: { kind: 'engagement', id: eid, label: `${eid} ${w.name}` },
      priority: 0,
      ...(amount !== undefined ? { amount } : {}),
      since: s.time,
      until: null,
      status: 'active',
    });
    if ((w.fireControlChannels ?? 0) > 0) claims.push(mk('fire_control', plan.channels * w.fireControlChannels!));
    if (plan.illuminators > 0) claims.push(mk('illuminator', plan.illuminators));
    if (m.kind === 'turret') claims.push(mk(m.resource));
    u.claims.push(...claims);
    const b = body('ENGAGE', `${u.name} 以 ${w.name} 拦截航迹 ${tr.id}：窗口 ${clk(ctx, plan.window.start)}–${clk(ctx, plan.window.end)}，${plan.engagements} 次交战，合法区间 [${plan.bounds.min}, ${plan.bounds.max}]`, {
      actor: u.id,
      target: tr.id,
      requires: [...tr.provenance.map((ref) => ({ label: '航迹来源', ref })), { label: `消耗 ${plan.rounds} × ${w.name}` }],
      produces: [{ label: `交战 ${eid}` }, ...claims.map((c) => ({ label: `占用 ${c.resource}${c.amount ? ` ×${c.amount}` : ''}` }))],
      data: { engagementId: eid, explanation: plan.explanation },
    });
    // The side sees its fire plan; the bounds depend on the true raid size, so they stay author-only.
    const sideBody = body('ENGAGE', `${u.name} 以 ${w.name} 拦截航迹 ${tr.id}：窗口 ${clk(ctx, plan.window.start)}–${clk(ctx, plan.window.end)}，消耗 ${plan.rounds} 发`, {
      actor: u.id,
      target: tr.id,
      requires: b.requires,
      produces: b.produces,
    });
    const ev = emit(s, ci, { kind: 'ENGAGE', truth: b, sides: { [u.side]: sideBody }, causedBy: tr.provenance.slice() });
    s.engagements[eid] = {
      id: eid,
      side: u.side,
      unitId: u.id,
      mountId: cmd.mountId,
      weaponId: w.id,
      trackId: tr.id,
      channels: plan.channels,
      window: plan.window,
      engagements: plan.engagements,
      roundsCommitted: plan.rounds,
      bounds: plan.bounds,
      explanation: plan.explanation,
      status: 'scheduled',
      claimIds: claims.map((c) => c.id),
      commandEventId: ev.id,
    };
  },

  ALIGN(ctx, s, cmd, ci) {
    const u = s.units[cmd.unitId]!;
    const m = mountDef(ctx, u, cmd.mountId)!;
    if (m.kind !== 'fixed') return;
    const old = u.claims.find((c) => c.owner.kind === 'mount' && c.owner.id === m.id);
    if (old) releaseClaim(ctx, s, u, old.id, ci, '被新的 ALIGN 取代', []);
    const tr = trackOf(s, u.id, cmd.trackId)!;
    const claim = alignClaim(u, m.id, m.name, m.boresight, m.halfAngleDeg, tr.id, cmd.priority, s.time, `${u.side}-C${nextId(s, `${u.side}:claim`)}`);
    addAttitudeClaim(ctx, s, u, claim, ci, tr.provenance.slice());
  },

  MANEUVER(ctx, s, cmd, ci) {
    const u = s.units[cmd.unitId]!;
    const claim = maneuverClaim(cmd, s.time, `${u.side}-C${nextId(s, `${u.side}:claim`)}`);
    addAttitudeClaim(ctx, s, u, claim, ci, []);
    if (cmd.claimsTranslation) {
      u.claims.push({
        ...claim,
        id: `${u.side}-C${nextId(s, `${u.side}:claim`)}`,
        resource: 'hull_translation',
        constraint: undefined,
      } as ResourceClaim);
    }
  },

  RELEASE_CLAIM(ctx, s, cmd, ci) {
    releaseClaim(ctx, s, s.units[cmd.unitId]!, cmd.claimId, ci, '作者释放', []);
  },

  RESOLVE(ctx, s, cmd, ci) {
    const o = s.opportunities[cmd.opportunityId]!;
    o.status = 'resolved';
    o.resolution = cmd.decision;
    if (o.kind === 'detection') resolveDetection(ctx, s, o, cmd.decision as Extract<Decision, { kind: 'detection' }>, ci);
    else if (o.kind === 'intercept') resolveIntercept(ctx, s, o, (cmd.decision as Extract<Decision, { kind: 'intercept' }>).intercepted, cmd.decision, ci);
    else resolveImpact(ctx, s, o, (cmd.decision as Extract<Decision, { kind: 'impact' }>).hits, cmd.decision, ci);
  },

  SET_UNIT_STATUS(ctx, s, cmd, ci) {
    const u = s.units[cmd.unitId]!;
    const prev = u.status;
    u.status = cmd.status;
    if (cmd.status === 'destroyed' || cmd.status === 'disabled') {
      for (const sid of Object.keys(u.sensorsOn)) u.sensorsOn[sid] = false;
      for (const tr of Object.values(s.knowledge[u.id]!)) tr.holds = {};
    }
    if (cmd.status === 'destroyed') u.motion = stationaryPlan(s.time, positionAt(u.motion, s.time));
    const b = body('UNIT_STATUS', `${u.name} 状态 ${prev} → ${cmd.status}${cmd.note ? `（${cmd.note}）` : ''}`, { actor: u.id });
    emit(s, ci, { kind: 'UNIT_STATUS', truth: b, sides: { [u.side]: b } });
  },

  NOTE(_ctx, s, cmd, ci) {
    emit(s, ci, { kind: 'NOTE', truth: body('NOTE', cmd.text) });
  },
};

// ---------------------------------------------------------------------------
// Time advance
// ---------------------------------------------------------------------------

function advance(ctx: Ctx, s: WorldState, cmd: Extract<Command, { type: 'ADVANCE' }>, ci: number): void {
  const start = s.time;
  const until = cmd.until ?? s.time + DEFAULT_ADVANCE_MS;
  let stoppedBy = '到达目标时间';
  for (let guard = 0; guard < 100_000; guard++) {
    const items = scheduleNext(ctx, s, until);
    if (!items.length) {
      moveTo(ctx, s, until);
      break;
    }
    moveTo(ctx, s, items[0]!.time);
    let opp = false;
    let notable = false;
    for (const it of items) {
      // Once the author owes a ruling, later same-time items (e.g. an impact right after an
      // intercept window) must wait for it. All items are re-derived from state next time;
      // independent detection chances at the same instant are batched together.
      if (opp && it.kind !== 'detection') continue;
      const r = processScheduled(ctx, s, it, ci);
      opp ||= r.opportunity;
      notable ||= r.notable;
    }
    if (opp) {
      stoppedBy = '出现待裁定机会';
      break;
    }
    if (cmd.stopAtNotable && notable) {
      stoppedBy = '出现值得注意的确定事件';
      break;
    }
    if (s.time >= until) break;
  }
  const b = body('ADVANCE', `时间推进 ${clk(ctx, start)} → ${clk(ctx, s.time)}（${stoppedBy}）`, { data: { from: start, to: s.time } });
  emit(s, ci, { kind: 'TIME_ADVANCED', truth: b, sides: allSides(ctx, b) });
}

function processScheduled(ctx: Ctx, s: WorldState, it: Scheduled, ci: number): { opportunity: boolean; notable: boolean } {
  switch (it.kind) {
    case 'delivery': {
      const m = s.messages.find((x) => x.id === it.messageId)!;
      s.messages = s.messages.filter((x) => x.id !== m.id);
      const to = s.units[m.to]!;
      const kb = s.knowledge[to.id]!;
      const existing = kb[m.track.id];
      const stale = !!existing && existing.lastUpdate >= m.track.lastUpdate;
      const b = body(
        'DELIVERY',
        stale
          ? `${to.name} 收到航迹 ${m.track.id}，但本地数据更新，忽略`
          : `${to.name} 收到航迹 ${m.track.id}（${m.track.quality}，数据时刻 ${clk(ctx, m.track.lastUpdate)}）`,
        {
          actor: m.to,
          target: m.track.id,
          requires: [{ label: `报文 ${m.id}`, ref: m.sendEventId }],
          produces: stale ? [] : [{ label: `${to.id} 获得 ${m.track.id}` }],
        },
      );
      const ev = emit(s, ci, { kind: 'DELIVERY', truth: b, sides: { [to.side]: b }, causedBy: [m.sendEventId], notable: true });
      if (!stale) {
        kb[m.track.id] = {
          ...structuredClone(m.track),
          holds: existing?.holds ?? {},
          provenance: [...new Set([...(existing?.provenance ?? []), ...m.track.provenance, m.sendEventId, ev.id])],
        };
      }
      return { opportunity: false, notable: true };
    }
    case 'claim_expire': {
      const u = s.units[it.unitId]!;
      releaseClaim(ctx, s, u, it.claimId, ci, '到时', []);
      return { opportunity: false, notable: true };
    }
    case 'route_complete': {
      const u = s.units[it.unitId]!;
      s.reportedArrivals[u.id] = it.time;
      const b = body('ROUTE_COMPLETE', `${u.name} 到达航路终点`, { actor: u.id });
      emit(s, ci, { kind: 'ROUTE_COMPLETE', truth: b, sides: { [u.side]: b }, notable: true });
      return { opportunity: false, notable: true };
    }
    case 'track_lost': {
      const u = s.units[it.unitId]!;
      const tr = s.knowledge[u.id]![it.trackId]!;
      const target = s.truth.trackTargets[tr.id]!;
      const why = detectability(ctx, s, u, it.sensorId, target, s.time).checks.filter((c) => c.ok === false);
      delete tr.holds[it.sensorId];
      tr.quality = effectiveQuality(tr);
      const sd = sensorDef(ctx, it.sensorId);
      const b = body('TRACK_LOST', `${u.name} ${sd.name} 失去对 ${tr.id} 的保持`, {
        actor: u.id,
        target: tr.id,
        data: { sensorId: it.sensorId, remainingHolds: Object.keys(tr.holds) },
      });
      // The own side learns the contact faded, not the truth reason.
      emit(s, ci, {
        kind: 'TRACK_LOST',
        truth: { ...b, data: { ...b.data, reasons: why } },
        sides: { [u.side]: b },
        causedBy: tr.provenance.slice(-1),
        notable: true,
      });
      return { opportunity: false, notable: true };
    }
    case 'detection':
      return { opportunity: createDetectionOpportunity(ctx, s, it, ci), notable: true };
    case 'engagement_end':
      return { opportunity: createInterceptOpportunity(ctx, s, it.engagementId, ci), notable: true };
    case 'group_arrival':
      return { opportunity: createImpactOpportunity(ctx, s, it.groupId, ci), notable: true };
  }
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

function newOppId(s: WorldState, side: string) {
  return `${side}-OPP${nextId(s, `${side}:opp`)}`;
}

function createDetectionOpportunity(ctx: Ctx, s: WorldState, it: Extract<Scheduled, { kind: 'detection' }>, ci: number): boolean {
  const u = s.units[it.unitId]!;
  const sd = sensorDef(ctx, it.sensorId);
  const det = detectability(ctx, s, u, it.sensorId, it.target, s.time);
  s.lastOffered[pairKey(u.id, it.sensorId, it.target)] = s.time;
  const same = Object.values(s.knowledge[u.id]!)
    .filter((tr) => s.truth.trackTargets[tr.id] === it.target)
    .map((tr) => tr.id);
  const targetName = s.units[it.target]?.name ?? it.target;
  const explanation = info(`${u.name} 的 ${sd.name} 现在有可能探测到 ${targetName}`, {
    children: [...det.checks, info(`可建立的最高航迹质量: ${sd.maxQuality}`), ...(same.length ? [info(`（作者提示）真值上与本平台航迹 ${same.join(', ')} 为同一目标`)] : [])],
  });
  const id = newOppId(s, u.side);
  const ev = emit(s, ci, {
    kind: 'DETECTION_OPPORTUNITY',
    truth: body('DETECTION_OPPORTUNITY', `${clk(ctx, s.time)} ${u.name} 有可能探测到 ${targetName}（${sd.name}）`, {
      actor: u.id,
      target: it.target,
      data: { opportunityId: id },
    }),
    notable: true,
  });
  s.opportunities[id] = {
    id,
    kind: 'detection',
    side: u.side,
    time: s.time,
    status: 'pending',
    explanation,
    eventId: ev.id,
    observerId: u.id,
    sensorId: it.sensorId,
    target: it.target,
    maxQuality: sd.maxQuality,
    sameAsTracks: same,
  };
  return true;
}

function resolveDetection(
  ctx: Ctx,
  s: WorldState,
  o: Extract<Opportunity, { kind: 'detection' }>,
  d: Extract<Decision, { kind: 'detection' }>,
  ci: number,
): void {
  const u = s.units[o.observerId]!;
  const sd = sensorDef(ctx, o.sensorId);
  if (!d.detected) {
    const b = body('DETECTION_DECLINED', `作者裁定: ${u.name} ${sd.name} 未探测到目标（${d.reason}${d.note ? `: ${d.note}` : ''}）`, {
      actor: u.id,
      target: o.target,
      data: { reason: d.reason, note: d.note, reofferAfterS: sd.reofferIntervalS },
    });
    emit(s, ci, { kind: 'DETECTION_DECLINED', truth: b, causedBy: [o.eventId] });
    return;
  }
  const kb = s.knowledge[u.id]!;
  const trackId = d.correlateWith ?? `${u.side}-T${nextId(s, `${u.side}:track`)}`;
  const existing = kb[trackId];
  const tr: Track = existing ?? {
    id: trackId,
    side: u.side,
    quality: d.quality,
    estimate: { kind: 'bearing', origin: [0, 0, 0], direction: [1, 0, 0] },
    lastUpdate: s.time,
    holds: {},
    provenance: [],
  };
  tr.holds[o.sensorId] = d.quality;
  if (d.classification && qualityAtLeast(d.quality, 'CLASSIFIED')) tr.classification = d.classification;
  kb[trackId] = tr;
  s.truth.trackTargets[trackId] = o.target;
  refreshTrack(ctx, s, u, tr);
  const b = body('DETECTION', `${u.name} ${sd.name} ${existing ? '更新' : '建立'}航迹 ${trackId}（${tr.quality}）`, {
    actor: u.id,
    target: trackId,
    requires: [{ label: `${sd.name} 开机且几何可探测`, ref: o.eventId }, { label: '作者裁定: 探测成功' }],
    produces: [{ label: `${u.id} 航迹 ${trackId} (${tr.quality})` }],
    data: { sensorId: o.sensorId, quality: tr.quality, classification: tr.classification },
  });
  const ev = emit(s, ci, {
    kind: 'DETECTION',
    truth: { ...b, summary: `${b.summary} = ${s.units[o.target]?.name ?? o.target}`, data: { ...b.data, truthTarget: o.target } },
    sides: { [u.side]: b },
    causedBy: [o.eventId],
  });
  tr.provenance = [...tr.provenance, ev.id];
}

function createInterceptOpportunity(ctx: Ctx, s: WorldState, engId: string, ci: number): boolean {
  const e = s.engagements[engId]!;
  const groupId = s.truth.trackTargets[e.trackId] ?? null;
  const g = groupId ? s.groups[groupId] : undefined;
  const id = newOppId(s, e.side);
  const left = g?.count ?? 0;
  const bounds = { max: Math.min(e.bounds.max, left), min: Math.min(e.bounds.min, e.bounds.max, left) };
  const explanation = info(`${engId} 交战窗口结束，裁定拦截数量`, {
    children: [e.explanation, info(`弹群当前剩余 ${left}`)],
  });
  const ev = emit(s, ci, {
    kind: 'INTERCEPT_OPPORTUNITY',
    truth: body('INTERCEPT_OPPORTUNITY', `${engId} 拦截结果待裁定，合法区间 [${bounds.min}, ${bounds.max}]`, {
      actor: e.unitId,
      target: groupId ?? undefined,
      data: { opportunityId: id },
    }),
    causedBy: [e.commandEventId],
    notable: true,
  });
  const o: Opportunity = { id, kind: 'intercept', side: e.side, time: s.time, status: 'pending', explanation, eventId: ev.id, engagementId: engId, groupId, bounds };
  s.opportunities[id] = o;
  if (bounds.min === bounds.max) {
    // No real choice: resolve mechanically, but keep the record.
    o.status = 'resolved';
    o.resolution = { kind: 'intercept', intercepted: bounds.min, note: '区间退化为单点，自动裁定' };
    resolveIntercept(ctx, s, o, bounds.min, o.resolution, ci);
    return false;
  }
  return true;
}

function resolveIntercept(
  ctx: Ctx,
  s: WorldState,
  o: Extract<Opportunity, { kind: 'intercept' }>,
  k: number,
  d: Decision,
  ci: number,
): void {
  const e = s.engagements[o.engagementId]!;
  const u = s.units[e.unitId]!;
  e.status = 'resolved';
  e.interceptedCount = k;
  const g = o.groupId ? s.groups[o.groupId] : undefined;
  if (g) {
    g.count -= k;
    g.intercepted += k;
  }
  const note = 'note' in d && d.note ? `（${d.note}）` : '';
  const b = body('INTERCEPT', `${u.name} ${e.id} 拦截 ${k} 枚${note}`, {
    actor: u.id,
    target: e.trackId,
    requires: [{ label: `交战 ${e.id}`, ref: e.commandEventId }, { label: `作者裁定 ${k} ∈ [${o.bounds.min}, ${o.bounds.max}]`, ref: o.eventId }],
    produces: [{ label: `来袭弹群 -${k}` }],
    data: { intercepted: k },
  });
  const ev = emit(s, ci, {
    kind: 'INTERCEPT',
    truth: { ...b, summary: `${b.summary}，${g?.id ?? '?'} 剩余 ${g?.count ?? 0}` },
    sides: { [u.side]: b },
    causedBy: [e.commandEventId, o.eventId],
  });
  for (const cid of e.claimIds) releaseClaim(ctx, s, u, cid, ci, '交战结束', [ev.id]);
  if (g && g.count === 0 && g.status === 'flying') expireGroup(ctx, s, g, ci, '全部被拦截', [ev.id]);
}

function createImpactOpportunity(ctx: Ctx, s: WorldState, groupId: string, ci: number): boolean {
  const g = s.groups[groupId]!;
  g.status = 'arrived';
  const r = impactBounds(ctx, s, groupId);
  const id = newOppId(s, g.side);
  const ev = emit(s, ci, {
    kind: 'IMPACT_OPPORTUNITY',
    truth: body('IMPACT_OPPORTUNITY', `${g.id}（${g.count} 枚）到达，合法命中区间 [${r.bounds.min}, ${r.bounds.max}]`, {
      actor: g.id,
      target: r.targetId ?? undefined,
      data: { opportunityId: id },
    }),
    causedBy: [g.launchEventId],
    notable: true,
  });
  const o: Opportunity = {
    id,
    kind: 'impact',
    side: g.side,
    time: s.time,
    status: 'pending',
    explanation: r.explanation,
    eventId: ev.id,
    groupId,
    target: r.targetId ?? '',
    bounds: r.bounds,
  };
  s.opportunities[id] = o;
  if (r.bounds.min === r.bounds.max) {
    o.status = 'resolved';
    o.resolution = { kind: 'impact', hits: r.bounds.min, note: '区间退化为单点，自动裁定' };
    resolveImpact(ctx, s, o, r.bounds.min, o.resolution, ci);
    return false;
  }
  return true;
}

function resolveImpact(ctx: Ctx, s: WorldState, o: Extract<Opportunity, { kind: 'impact' }>, k: number, d: Decision, ci: number): void {
  const g = s.groups[o.groupId]!;
  const target = s.units[o.target];
  g.hits = k;
  g.misses = g.count - k;
  g.count = 0;
  if (target) target.hitsTaken += k;
  const note = 'note' in d && d.note ? `（${d.note}）` : '';
  const truth = body('IMPACT', `${g.id} 命中 ${target?.name ?? '无目标'} ${k} 枚，落空 ${g.misses} 枚${note}`, {
    actor: g.id,
    target: o.target,
    requires: [{ label: `发射`, ref: g.launchEventId }, { label: `作者裁定 ${k} ∈ [${o.bounds.min}, ${o.bounds.max}]`, ref: o.eventId }],
    produces: target ? [{ label: `${target.id} 被命中 ${k}` }] : [],
    data: { hits: k, misses: g.misses },
  });
  const sides: Record<string, EventBody> = {
    [g.side]: body('IMPACT', `${g.id} 到达目标区，战果需另行确认`, { actor: g.id, target: g.targetTrackId }),
  };
  if (target && target.side !== g.side)
    sides[target.side] = body('IMPACT', `${target.name} 被来袭弹药命中 ${k} 枚`, { target: target.id, data: { hits: k } });
  const ev = emit(s, ci, { kind: 'IMPACT', truth, sides, causedBy: [g.launchEventId, o.eventId], notable: true });
  expireGroup(ctx, s, g, ci, '已到达目标', [ev.id]);
}

function expireGroup(_ctx: Ctx, s: WorldState, g: MissileGroupState, ci: number, why: string, causedBy: string[]): void {
  g.status = 'expended';
  const b = body('GROUP_EXPENDED', `${g.id} 结束（${why}）`, { actor: g.id });
  emit(s, ci, { kind: 'GROUP_EXPENDED', truth: b, sides: { [g.side]: b }, causedBy });
}

/** Pure replay: fold a command list over the initial state. Throws on an illegal command. */
export function replay(ctx: Ctx, commands: Command[]): WorldState {
  let s = createInitialState(ctx);
  commands.forEach((c, i) => {
    const r = applyCommand(ctx, s, c, i);
    if (!r.result.ok) throw new RuleError(`replay: command #${i} (${c.type}) is illegal`);
    s = r.state;
  });
  return s;
}
