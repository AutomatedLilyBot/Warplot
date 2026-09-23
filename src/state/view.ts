/**
 * Views. The god view is the truth; a side view is a *projection* that only
 * contains what that side's platforms actually know. Built by whitelisting
 * fields — never by copying truth and deleting.
 */
import type { Vec3 } from '../core/math/vec3.js';
import type { Quat } from '../core/math/quat.js';
import type { SimTime } from '../core/time.js';
import type { SideId } from './defs.js';
import type { Engagement, PendingMessage, ResourceClaim, Track, UnitStatus, WorldState } from './types.js';
import type { EventBody, EventKind, Opportunity } from '../events/types.js';
import { type Ctx, groupPosition, orientationAt, trackPositionAt } from '../rules/world.js';
import { positionAt, velocityAt } from '../rules/kinematics.js';

export interface OwnUnitView {
  id: string;
  name: string;
  classId: string;
  status: UnitStatus;
  position: Vec3;
  velocity: Vec3;
  orientation: Quat;
  arrivesAt: SimTime | null;
  sensorsOn: Record<string, boolean>;
  ammo: Record<string, Record<string, number>>;
  claims: ResourceClaim[];
  hitsTaken: number;
}

export interface OwnGroupView {
  id: string;
  weaponId: string;
  count: number;
  targetTrackId: string;
  launchTime: SimTime;
  arrivalTime: SimTime;
  position: Vec3;
  status: string;
}

export interface TrackView extends Track {
  /** Dead-reckoned position at view time (null for bearing tracks). */
  positionNow: Vec3 | null;
  ageS: number;
}

export interface SideEventView extends EventBody {
  id: string;
  time: SimTime;
  kind: EventKind;
  causedBy: string[];
}

export interface SideView {
  side: SideId;
  time: SimTime;
  units: OwnUnitView[];
  groups: OwnGroupView[];
  /** platform id → its tracks */
  tracks: Record<string, TrackView[]>;
  messages: Pick<PendingMessage, 'id' | 'linkId' | 'from' | 'to' | 'sentAt' | 'deliverAt'>[];
  /** Own fire plans. Bounds/explanations stay author-only (they depend on the true raid size). */
  engagements: Pick<Engagement, 'id' | 'unitId' | 'mountId' | 'weaponId' | 'trackId' | 'channels' | 'window' | 'roundsCommitted' | 'status' | 'interceptedCount'>[];
  events: SideEventView[];
}

export function projectSideView(ctx: Ctx, s: WorldState, side: SideId): SideView {
  const units = Object.values(s.units)
    .filter((u) => u.side === side)
    .map<OwnUnitView>((u) => ({
      id: u.id,
      name: u.name,
      classId: u.classId,
      status: u.status,
      position: positionAt(u.motion, s.time),
      velocity: velocityAt(u.motion, s.time),
      orientation: orientationAt(ctx, u, s.time),
      arrivesAt: u.motion.arrivesAt,
      sensorsOn: { ...u.sensorsOn },
      ammo: Object.fromEntries(Object.entries(u.mounts).map(([m, ms]) => [m, { ...ms.ammo }])),
      claims: structuredClone(u.claims),
      hitsTaken: u.hitsTaken,
    }));

  const groups = Object.values(s.groups)
    .filter((g) => g.side === side)
    .map<OwnGroupView>((g) => ({
      id: g.id,
      weaponId: g.weaponId,
      // The launching side knows how many it fired, not how many survived.
      count: g.initialCount,
      targetTrackId: g.targetTrackId,
      launchTime: g.launchTime,
      arrivalTime: g.arrivalTime,
      position: groupPosition(g, s.time),
      status: g.status === 'flying' && s.time < g.arrivalTime ? 'flying' : 'arrived',
    }));

  const tracks: Record<string, TrackView[]> = {};
  for (const u of units) {
    tracks[u.id] = Object.values(s.knowledge[u.id] ?? {}).map((tr) => ({
      ...structuredClone(tr),
      positionNow: trackPositionAt(tr, s.time),
      ageS: (s.time - tr.lastUpdate) / 1000,
    }));
  }

  // Re-number visible events so gaps in ids don't reveal hidden activity.
  const visible = s.log.filter((e) => e.sides[side]);
  const remap = new Map(visible.map((e, i) => [e.id, `${side}-E${i + 1}`]));
  const events = visible.map<SideEventView>((e) => {
    const b = e.sides[side]!;
    return {
      id: remap.get(e.id)!,
      time: e.time,
      kind: e.kind,
      causedBy: e.causedBy.filter((c) => remap.has(c)).map((c) => remap.get(c)!),
      ...structuredClone(b),
      requires: b.requires.filter((f) => !f.ref || remap.has(f.ref)).map((f) => (f.ref ? { ...f, ref: remap.get(f.ref)! } : { ...f })),
      produces: b.produces.map((f) => ({ label: f.label })),
    };
  });
  // Track provenance refs point at global event ids; rewrite / drop them.
  for (const list of Object.values(tracks))
    for (const tr of list) tr.provenance = tr.provenance.filter((p) => remap.has(p)).map((p) => remap.get(p)!);

  return {
    side,
    time: s.time,
    units,
    groups,
    tracks,
    messages: s.messages.filter((m) => m.side === side).map((m) => ({ id: m.id, linkId: m.linkId, from: m.from, to: m.to, sentAt: m.sentAt, deliverAt: m.deliverAt })),
    engagements: Object.values(s.engagements)
      .filter((e) => e.side === side)
      .map((e) => ({
        id: e.id,
        unitId: e.unitId,
        mountId: e.mountId,
        weaponId: e.weaponId,
        trackId: e.trackId,
        channels: e.channels,
        window: { ...e.window },
        roundsCommitted: e.roundsCommitted,
        status: e.status,
        interceptedCount: e.interceptedCount,
      })),
    events,
  };
}

/** God view: everything, with positions evaluated at the current time. */
export function projectGodView(ctx: Ctx, s: WorldState) {
  return {
    time: s.time,
    units: Object.values(s.units).map((u) => ({
      ...structuredClone(u),
      position: positionAt(u.motion, s.time),
      velocity: velocityAt(u.motion, s.time),
      orientation: orientationAt(ctx, u, s.time),
    })),
    groups: Object.values(s.groups).map((g) => ({ ...structuredClone(g), position: groupPosition(g, s.time) })),
    knowledge: structuredClone(s.knowledge),
    truth: structuredClone(s.truth),
    opportunities: Object.values(s.opportunities).filter((o: Opportunity) => o.status === 'pending'),
    events: s.log,
  };
}
