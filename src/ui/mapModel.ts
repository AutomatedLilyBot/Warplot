/**
 * Map model: a flat list of things to draw, built from EITHER the god view
 * or ONE side's projection. Side models are built only from projectSideView
 * output, so nothing the side does not know can reach the renderer.
 * Pure (no DOM / Three.js) and unit-tested.
 */
import type { Vec3 } from '../core/math/vec3.js';
import { rotate } from '../core/math/quat.js';
import type { Ctx } from '../rules/world.js';
import { groupPosition, orientationAt, trackCovarianceAt, trackPositionAt } from '../rules/world.js';
import { RAD } from '../core/math/vec3.js';
import { ellipsoid95, fmtM } from '../rules/tracks.js';
import { positionAt } from '../rules/kinematics.js';
import type { MissileGroupState, MotionPlan, Track, WorldState } from '../state/types.js';
import { projectSideView } from '../state/view.js';
import { groupLabel, trackNumber } from './labels.js';

export type ViewId = 'god' | string;

export interface MapEntity {
  /** Stable selection key: unit:<id> | group:<id> | track:<id> */
  key: string;
  kind: 'unit' | 'group' | 'track';
  /** Colour class: a side id for own/truth objects, or 'contact' for tracks. */
  tone: string;
  category: 'ship' | 'uav' | 'aew' | 'missile' | 'contact';
  label: string;
  sublabel?: string;
  /** World position (m); null for bearing-only tracks. */
  position: Vec3 | null;
  /** World-frame body forward axis (units only). */
  forward?: Vec3;
  /** Bearing-only tracks: ray from the observer. */
  bearing?: { origin: Vec3; dir: Vec3 };
  trail?: Vec3[];
  route?: Vec3[];
  flightLine?: [Vec3, Vec3];
  inactive?: boolean;
}

export interface MapModel {
  view: ViewId;
  time: number;
  entities: MapEntity[];
  obstacles: { id: string; name: string; center: Vec3; radiusM: number }[];
  /** Route being drawn: the unit's position followed by the draft waypoints. */
  draftRoute?: Vec3[];
  /** Positions are extrapolated to `time`, later than the state (nothing is committed). */
  preview?: boolean;
}

export interface MapModelOptions {
  /** In god view, also draw every side's track picture. */
  godTracks?: boolean;
  draftRoute?: Vec3[];
  /**
   * Preview time (≥ state time): positions follow the current motion plans, flights
   * and track extrapolation to this time. Future events are not simulated.
   */
  at?: number;
}

/**
 * Sample a unit's trajectory over the command history: each historical
 * state's motion plan is valid from that state's time until the next state.
 * Plans are straight constant-accel pieces, so segment boundaries suffice.
 */
function samplePlan(plan: MotionPlan, t0: number, t1: number): Vec3[] {
  const ts = new Set<number>([t0, t1]);
  for (const s of plan.segments) {
    if (s.t0 > t0 && s.t0 < t1) ts.add(s.t0);
    if (s.t1 !== null && s.t1 > t0 && s.t1 < t1) ts.add(s.t1);
  }
  return [...ts].sort((a, b) => a - b).map((t) => positionAt(plan, t));
}

export function unitTrail(history: WorldState[], unitId: string): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < history.length; i++) {
    const s = history[i]!;
    const u = s.units[unitId];
    if (!u) continue;
    const t1 = i + 1 < history.length ? history[i + 1]!.time : s.time;
    if (t1 < s.time) continue;
    for (const p of samplePlan(u.motion, s.time, t1)) {
      const last = out[out.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1] || last[2] !== p[2]) out.push(p);
    }
  }
  return out;
}

function unitRoute(plan: MotionPlan, now: number): Vec3[] | undefined {
  if (plan.arrivesAt === null || plan.arrivesAt <= now) return undefined;
  return samplePlan(plan, now, plan.arrivesAt);
}

type PictureTrack = Pick<Track, 'id' | 'spatial' | 'classification' | 'observedAt'>;

/** Short sublabel: classification if any, else the spatial structure with its current uncertainty. */
function trackSublabel(ctx: Ctx, tr: PictureTrack, now: number): string {
  const c = tr.classification;
  if (c && (c.label || c.category)) return c.label ?? c.category!;
  if (tr.spatial.kind === 'BEARING_ONLY') return `BRG ±${((tr.spatial.angleSigmaRad / RAD) * 1.96).toPrecision(2)}°`;
  const cov = trackCovarianceAt(ctx, tr, now)!;
  return `LOC ±${fmtM(ellipsoid95(cov)[0])}`;
}

function trackEntity(ctx: Ctx, tr: PictureTrack, now: number, tone: string, extra = ''): MapEntity {
  const num = trackNumber(tr.id);
  const pos = trackPositionAt(tr, now);
  const age = Math.round((now - tr.observedAt) / 1000);
  return {
    key: `track:${tr.id}`,
    kind: 'track',
    tone,
    category: 'contact',
    label: `${extra}${num}`,
    sublabel: `${trackSublabel(ctx, tr, now)}${age > 0 ? ` · ${age}s` : ''}`,
    position: pos,
    ...(tr.spatial.kind === 'BEARING_ONLY' ? { bearing: { origin: tr.spatial.origin, dir: tr.spatial.direction } } : {}),
  };
}

/** Freshest copy of each track across a set of platforms. */
function mergePicture<T extends PictureTrack>(tracksByPlatform: T[][]): T[] {
  const best = new Map<string, T>();
  for (const list of tracksByPlatform)
    for (const tr of list) {
      const cur = best.get(tr.id);
      if (!cur || tr.observedAt > cur.observedAt) best.set(tr.id, tr);
    }
  return [...best.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * @param history states along the current branch, root first, ending with the current state
 */
export function buildMapModel(ctx: Ctx, history: WorldState[], view: ViewId, opts: MapModelOptions = {}): MapModel {
  const s = history[history.length - 1]!;
  const now = s.time;
  const t = Math.max(now, opts.at ?? now);
  const obstacles = ctx.scenario.obstacles.map((o) => ({ ...o }));
  const categoryOf = (classId: string) => ctx.catalog.unitClasses[classId]?.category ?? 'ship';
  const entities: MapEntity[] = [];
  const extra = {
    ...(opts.draftRoute ? { draftRoute: opts.draftRoute } : {}),
    ...(t > now ? { preview: true } : {}),
  };
  // A salvo is drawn while in flight at the displayed time.
  const flying = (g: MissileGroupState) => g.status === 'flying' && t >= g.launchTime && t < g.arrivalTime;

  if (view === 'god') {
    for (const u of Object.values(s.units)) {
      entities.push({
        key: `unit:${u.id}`,
        kind: 'unit',
        tone: u.side,
        category: categoryOf(u.classId),
        label: u.name,
        sublabel: u.status !== 'active' ? u.status : undefined,
        position: positionAt(u.motion, t),
        forward: rotate(orientationAt(ctx, u, t), [1, 0, 0]),
        trail: unitTrail(history, u.id),
        route: unitRoute(u.motion, now),
        inactive: u.status === 'destroyed',
      });
    }
    for (const g of Object.values(s.groups)) {
      // At the state time an arrived salvo awaiting its ruling is still drawn.
      if (t === now ? g.status === 'expended' || now < g.launchTime : !flying(g)) continue;
      entities.push({
        key: `group:${g.id}`,
        kind: 'group',
        tone: g.side,
        category: 'missile',
        label: `${groupLabel(g.id)} ×${g.count}`,
        sublabel: g.weaponId,
        position: groupPosition(g, t),
        flightLine: [g.origin, g.aimPoint],
      });
    }
    if (opts.godTracks)
      for (const side of ctx.scenario.sides) {
        const own = Object.values(s.units).filter((u) => u.side === side.id);
        for (const tr of mergePicture(own.map((u) => Object.values(s.knowledge[u.id] ?? {}))))
          entities.push({ ...trackEntity(ctx, tr, t, 'contact', `${side.name} `), key: `track:${tr.id}` });
      }
    return { view, time: t, entities, obstacles, ...extra };
  }

  // Side view: ONLY from the projection (plus the side's own motion plans / launches for previews).
  const sv = projectSideView(ctx, s, view);
  for (const u of sv.units) {
    const own = s.units[u.id]!;
    entities.push({
      key: `unit:${u.id}`,
      kind: 'unit',
      tone: view,
      category: categoryOf(u.classId),
      label: u.name,
      sublabel: u.status !== 'active' ? u.status : undefined,
      position: t === now ? u.position : positionAt(own.motion, t),
      forward: rotate(t === now ? u.orientation : orientationAt(ctx, own, t), [1, 0, 0]),
      trail: unitTrail(history, u.id),
      route: unitRoute(own.motion, now),
      inactive: u.status === 'destroyed',
    });
  }
  for (const g of sv.groups) {
    if (g.status !== 'flying' || now < g.launchTime) continue;
    const truth = s.groups[g.id]!; // own group: origin / aim point / timing are the side's own launch data
    if (t >= truth.arrivalTime) continue;
    entities.push({
      key: `group:${g.id}`,
      kind: 'group',
      tone: view,
      category: 'missile',
      label: `${groupLabel(g.id)} ×${g.count}`,
      sublabel: g.weaponId,
      position: t === now ? g.position : groupPosition(truth, t),
      flightLine: [truth.origin, truth.aimPoint],
    });
  }
  for (const tr of mergePicture(Object.values(sv.tracks))) entities.push(trackEntity(ctx, tr, t, 'contact'));
  return { view, time: t, entities, obstacles, ...extra };
}
