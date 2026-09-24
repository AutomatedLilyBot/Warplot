/**
 * Timeline marks: already-scheduled things in (t0, t1] that the current view
 * may know about. Pure. A side sees only its own salvos, messages, routes and
 * engagements — never the other side's schedule.
 */
import type { Ctx } from '../rules/world.js';
import type { WorldState } from '../state/types.js';
import type { ViewId } from './mapModel.js';
import { groupLabel } from './labels.js';

export interface TimelineMark {
  time: number;
  kind: 'arrival' | 'delivery' | 'route' | 'engagement';
  label: string;
}

export function timelineMarks(ctx: Ctx, s: WorldState, view: ViewId, t0: number, t1: number): TimelineMark[] {
  const mine = (side: string) => view === 'god' || side === view;
  const out: TimelineMark[] = [];
  const add = (m: TimelineMark) => {
    if (m.time > t0 && m.time <= t1) out.push(m);
  };
  for (const g of Object.values(s.groups))
    if (g.status === 'flying' && mine(g.side)) add({ time: g.arrivalTime, kind: 'arrival', label: `${groupLabel(g.id)} 到达` });
  for (const m of s.messages)
    if (mine(m.side)) add({ time: m.deliverAt, kind: 'delivery', label: `报文送达 ${s.units[m.to]?.name ?? m.to}` });
  for (const u of Object.values(s.units))
    if (mine(u.side) && u.motion.arrivesAt !== null) add({ time: u.motion.arrivesAt, kind: 'route', label: `${u.name} 到达航路终点` });
  for (const e of Object.values(s.engagements))
    if (e.status === 'scheduled' && mine(e.side))
      add({ time: e.window.end, kind: 'engagement', label: `${s.units[e.unitId]?.name ?? e.unitId} ${ctx.catalog.weapons[e.weaponId]?.name ?? e.weaponId} 交战窗口结束` });
  return out.sort((a, b) => a.time - b.time || a.label.localeCompare(b.label));
}
