/**
 * The scheduler answers one question: "what is the next thing that happens?"
 * It returns every item at the earliest time ≤ horizon. Time then jumps
 * straight there — no fixed tick.
 */
import type { SimTime } from '../core/time.js';
import type { EntityId, WorldState } from '../state/types.js';
import { type Ctx, allEntityIds, classOf, entityInfo, sensorDef } from '../rules/world.js';
import { nextDetectable, nextUndetectable } from '../rules/detection.js';

export type Scheduled =
  | { kind: 'delivery'; time: SimTime; messageId: string }
  | { kind: 'claim_expire'; time: SimTime; unitId: string; claimId: string }
  | { kind: 'engagement_end'; time: SimTime; engagementId: string }
  | { kind: 'group_arrival'; time: SimTime; groupId: string }
  | { kind: 'track_lost'; time: SimTime; unitId: string; sensorId: string; trackId: string }
  | { kind: 'detection'; time: SimTime; unitId: string; sensorId: string; target: EntityId }
  | { kind: 'route_complete'; time: SimTime; unitId: string };

/** Same-time ordering: resolve deliveries and intercepts before impacts, losses before new chances. */
const ORDER: Record<Scheduled['kind'], number> = {
  delivery: 0,
  claim_expire: 1,
  engagement_end: 2,
  group_arrival: 3,
  track_lost: 4,
  detection: 5,
  route_complete: 6,
};

export const pairKey = (unitId: string, sensorId: string, target: EntityId) => `${unitId}|${sensorId}|${target}`;

const keyOf = (x: Scheduled): string => JSON.stringify(x);

/** Entities this unit currently holds, with the holding sensors per entity. */
export function heldEntities(s: WorldState, unitId: string): Map<EntityId, { trackId: string; sensors: string[] }> {
  const out = new Map<EntityId, { trackId: string; sensors: string[] }>();
  for (const tr of Object.values(s.knowledge[unitId] ?? {})) {
    const target = s.truth.trackTargets[tr.id];
    if (!target) continue;
    const sensors = Object.keys(tr.holds);
    if (!sensors.length) continue;
    const cur = out.get(target);
    out.set(target, { trackId: tr.id, sensors: [...(cur?.sensors ?? []), ...sensors] });
  }
  return out;
}

export function scheduleNext(ctx: Ctx, s: WorldState, horizon: SimTime): Scheduled[] {
  const now = s.time;
  const items: Scheduled[] = [];

  for (const m of s.messages) items.push({ kind: 'delivery', time: m.deliverAt, messageId: m.id });

  for (const u of Object.values(s.units)) {
    for (const c of u.claims) if (c.until !== null) items.push({ kind: 'claim_expire', time: c.until, unitId: u.id, claimId: c.id });
    const arr = u.motion.arrivesAt;
    if (arr !== null && arr >= now && s.reportedArrivals[u.id] !== arr) items.push({ kind: 'route_complete', time: arr, unitId: u.id });
  }

  for (const e of Object.values(s.engagements))
    if (e.status === 'scheduled') items.push({ kind: 'engagement_end', time: e.window.end, engagementId: e.id });

  for (const g of Object.values(s.groups)) if (g.status === 'flying') items.push({ kind: 'group_arrival', time: g.arrivalTime, groupId: g.id });

  // Held contacts: when does each hold break?
  for (const [unitId, tracks] of Object.entries(s.knowledge)) {
    const u = s.units[unitId]!;
    for (const tr of Object.values(tracks)) {
      const target = s.truth.trackTargets[tr.id];
      if (!target) continue;
      for (const sensorId of Object.keys(tr.holds).sort()) {
        const t = nextUndetectable(ctx, s, u, sensorId, target, now, horizon);
        if (t !== null) items.push({ kind: 'track_lost', time: t, unitId, sensorId, trackId: tr.id });
      }
    }
  }

  // Detection chances.
  const pendingPairs = new Set(
    Object.values(s.opportunities)
      .filter((o) => o.status === 'pending' && o.kind === 'detection')
      .map((o) => (o.kind === 'detection' ? pairKey(o.observerId, o.sensorId, o.target) : '')),
  );
  const entities = allEntityIds(s);
  for (const u of Object.values(s.units).sort((a, b) => a.id.localeCompare(b.id))) {
    if (u.status === 'destroyed' || u.status === 'disabled') continue;
    const held = heldEntities(s, u.id);
    for (const sensorId of classOf(ctx, u).sensors) {
      if (!u.sensorsOn[sensorId]) continue;
      const sd = sensorDef(ctx, sensorId);
      for (const target of entities) {
        const info = entityInfo(ctx, s, target)!;
        if (info.side === u.side) continue;
        const h = held.get(target);
        if (h?.sensors.includes(sensorId)) continue;
        // Already held with at least this sensor's structure (a bearing sensor adds nothing to a held
        // contact; a position sensor adds nothing once another position sensor holds it) → no pause.
        if (h && (sd.measurement.kind === 'bearing' || h.sensors.some((sid) => sensorDef(ctx, sid).measurement.kind === 'position'))) continue;
        const key = pairKey(u.id, sensorId, target);
        if (pendingPairs.has(key)) continue;
        const last = s.lastOffered[key];
        const from = last === undefined ? now : Math.max(now, last + sd.reofferIntervalS * 1000);
        if (from > horizon) continue;
        const t = nextDetectable(ctx, s, u, sensorId, target, from, horizon);
        if (t !== null) items.push({ kind: 'detection', time: t, unitId: u.id, sensorId, target });
      }
    }
  }

  const eligible = items.filter((i) => i.time <= horizon && i.time >= now);
  if (!eligible.length) return [];
  const tMin = Math.min(...eligible.map((i) => i.time));
  return eligible
    .filter((i) => i.time === tMin)
    .sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || keyOf(a).localeCompare(keyOf(b)));
}
