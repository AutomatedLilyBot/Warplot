/**
 * Legal-action catalogue for one unit: every command the author could give it
 * right now, with the engine's verdict. Pure (no React / DOM); the actions
 * panel only renders this list.
 */
import type { Explanation } from '../core/explain.js';
import type { Command, Verdict } from '../events/types.js';
import { validate } from '../events/engine.js';
import type { Ctx } from '../rules/world.js';
import type { UnitStatus, WorldState } from '../state/types.js';
import { IDENTITIES, TARGET_CATEGORIES } from '../state/defs.js';
import type { ViewId } from './mapModel.js';

export type ActionGroup = 'sensor' | 'weapon' | 'info' | 'maneuver' | 'status';

export interface ActionParam {
  key: string;
  label: string;
  type: 'number' | 'text' | 'select';
  default: string;
  options?: [string, string][];
}

export interface ActionItem {
  /** Stable id (used to keep parameter values between renders). */
  id: string;
  group: ActionGroup;
  label: string;
  params: ActionParam[];
  command: Command;
  verdict: Verdict;
  /** Some failing checks were referee-level and are hidden in this side view. */
  hiddenFailures: boolean;
}

export type ParamValues = Record<string, Record<string, string>>;

export const GROUP_ZH: Record<ActionGroup, string> = { sensor: '传感器', weapon: '武器', info: '信息', maneuver: '机动与资源', status: '状态与备注' };

const STATUSES: [UnitStatus, string][] = [
  ['active', '正常'],
  ['damaged', '受损'],
  ['disabled', '失能'],
  ['destroyed', '被毁'],
];

/** Checks that consult the referee's truth; not shown in a side view. */
const isRefereeCheck = (c: Explanation) => c.label.includes('裁判层');

function sideSafe(v: Verdict, view: ViewId): { verdict: Verdict; hidden: boolean } {
  if (view === 'god') return { verdict: v, hidden: false };
  const checks = v.checks.filter((c) => !isRefereeCheck(c));
  const hidden = v.checks.some((c) => isRefereeCheck(c) && c.ok === false);
  return { verdict: { ...v, checks }, hidden };
}

const n = (x: string | undefined, d: number) => {
  const v = Number(x);
  return x === undefined || x.trim() === '' || !Number.isFinite(v) ? d : v;
};

interface Spec {
  id: string;
  group: ActionGroup;
  label: string;
  params?: ActionParam[];
  build: (p: Record<string, string>) => Command;
}

/**
 * @param trackId the target track for weapon / datalink / classification actions
 *                (must be one of the unit's own tracks; others are ignored)
 */
export function unitActions(
  ctx: Ctx,
  s: WorldState,
  view: ViewId,
  unitId: string,
  trackId: string | null,
  values: ParamValues = {},
): ActionItem[] {
  const u = s.units[unitId];
  if (!u || (view !== 'god' && u.side !== view)) return [];
  const cls = ctx.catalog.unitClasses[u.classId]!;
  const track = trackId && s.knowledge[u.id]?.[trackId] ? trackId : null;
  const specs: Spec[] = [];

  for (const sid of cls.sensors) {
    const on = !!u.sensorsOn[sid];
    specs.push({
      id: `sensor:${sid}`,
      group: 'sensor',
      label: `${ctx.catalog.sensors[sid]!.name}：${on ? '关机' : '开机'}`,
      build: () => ({ type: 'SET_SENSOR', unitId, sensorId: sid, on: !on }),
    });
  }

  if (track) {
    for (const m of cls.mounts) {
      for (const wid of m.weapons) {
        const w = ctx.catalog.weapons[wid]!;
        const ammo = u.mounts[m.id]?.ammo[wid] ?? 0;
        const label = `${m.name} · ${w.name}（${ammo}）`;
        if (w.role === 'anti_ship' || w.role === 'gun')
          specs.push({
            id: `launch:${m.id}:${wid}`,
            group: 'weapon',
            label: `发射 ${label}`,
            params: [{ key: 'count', label: '数量', type: 'number', default: '1' }],
            build: (p) => ({ type: 'LAUNCH', unitId, mountId: m.id, weaponId: wid, count: n(p.count, 1), trackId: track }),
          });
        else
          specs.push({
            id: `engage:${m.id}:${wid}`,
            group: 'weapon',
            label: `拦截 ${label}`,
            params: (w.fireControlChannels ?? 0) > 0 ? [{ key: 'channels', label: '通道', type: 'number', default: '' }] : [],
            build: (p) => ({
              type: 'ENGAGE',
              unitId,
              mountId: m.id,
              weaponId: wid,
              trackId: track,
              ...(p.channels?.trim() ? { channels: n(p.channels, 1) } : {}),
            }),
          });
      }
      if (m.kind === 'fixed')
        specs.push({
          id: `align:${m.id}`,
          group: 'weapon',
          label: `${m.name} 对准（舰体转向）`,
          params: [{ key: 'priority', label: '优先级', type: 'number', default: '1' }],
          build: (p) => ({ type: 'ALIGN', unitId, mountId: m.id, trackId: track, priority: n(p.priority, 1) }),
        });
    }
    for (const link of ctx.scenario.datalinks.filter((l) => l.members.includes(unitId)))
      for (const to of link.members.filter((x) => x !== unitId))
        specs.push({
          id: `transmit:${link.id}:${to}`,
          group: 'info',
          label: `经 ${link.name} 发送给 ${s.units[to]?.name ?? to}`,
          build: () => ({ type: 'TRANSMIT', linkId: link.id, from: unitId, to, trackId: track }),
        });
    specs.push({
      id: 'classify',
      group: 'info',
      label: '分类航迹',
      params: [
        { key: 'category', label: '类别', type: 'select', default: '', options: [['', '未定'], ...TARGET_CATEGORIES.map((c) => [c, c] as [string, string])] },
        { key: 'label', label: '名称', type: 'text', default: '' },
        { key: 'identity', label: '敌我', type: 'select', default: 'unknown', options: IDENTITIES.map((c) => [c, c] as [string, string]) },
        { key: 'confidence', label: '置信度', type: 'number', default: '0.8' },
      ],
      build: (p) => ({
        type: 'CLASSIFY',
        unitId,
        trackId: track,
        classification: {
          ...(p.category ? { category: p.category as (typeof TARGET_CATEGORIES)[number] } : {}),
          ...(p.label?.trim() ? { label: p.label.trim() } : {}),
          identity: (p.identity || 'unknown') as (typeof IDENTITIES)[number],
          confidence: n(p.confidence, 0.8),
        },
      }),
    });
  }

  specs.push({
    id: 'evade',
    group: 'maneuver',
    label: '规避机动（独占舰体姿态）',
    params: [
      { key: 'durationS', label: '时长 s', type: 'number', default: '60' },
      { key: 'priority', label: '优先级', type: 'number', default: '10' },
    ],
    build: (p) => ({ type: 'MANEUVER', unitId, label: 'EVADE', priority: n(p.priority, 10), durationS: n(p.durationS, 60) }),
  });
  for (const c of u.claims.filter((x) => x.owner.kind !== 'engagement'))
    specs.push({
      id: `release:${c.id}`,
      group: 'maneuver',
      label: `释放 ${c.resource}（${c.owner.label}）`,
      build: () => ({ type: 'RELEASE_CLAIM', unitId, claimId: c.id }),
    });

  specs.push({
    id: 'status',
    group: 'status',
    label: '设置单位状态',
    params: [
      { key: 'status', label: '状态', type: 'select', default: u.status, options: STATUSES },
      { key: 'note', label: '说明', type: 'text', default: '' },
    ],
    build: (p) => ({ type: 'SET_UNIT_STATUS', unitId, status: (p.status || u.status) as UnitStatus, ...(p.note?.trim() ? { note: p.note.trim() } : {}) }),
  });
  specs.push({
    id: 'note',
    group: 'status',
    label: '写入备注',
    params: [{ key: 'text', label: '内容', type: 'text', default: '' }],
    build: (p) => ({ type: 'NOTE', text: p.text ?? '' }),
  });

  return specs.map((sp) => {
    const params = sp.params ?? [];
    const vals = Object.fromEntries(params.map((p) => [p.key, values[sp.id]?.[p.key] ?? p.default]));
    const command = sp.build(vals);
    const { verdict, hidden } = sideSafe(validate(ctx, s, command), view);
    return { id: sp.id, group: sp.group, label: sp.label, params, command, verdict, hiddenFailures: hidden };
  });
}
