/** Read-only queries over WorldState + static context. Pure functions. */
import { type Vec3, lerp, sub, normalize, scale, length } from '../core/math/vec3.js';
import { type Quat, quatAngleDeg, slerp } from '../core/math/quat.js';
import type { SimTime } from '../core/time.js';
import type { Catalog, MountDef, Scenario, SensorDef, UnitClassDef, WeaponDef } from '../state/defs.js';
import type { EntityId, MissileGroupState, Track, UnitState, WorldState } from '../state/types.js';
import { maxSpeedOf, positionAt, velocityAt } from './kinematics.js';
import type { Mat3 } from '../core/math/mat3.js';
import { DEFAULT_VELOCITY_DRIFT_MPS_PER_MIN, type TrackEstimate, predictedCovariance, predictedPosition } from './tracks.js';

export interface Ctx {
  scenario: Scenario;
  catalog: Catalog;
}

export class RuleError extends Error {}

export function must<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new RuleError(`unknown ${what}`);
  return v;
}

export const classOf = (ctx: Ctx, u: UnitState): UnitClassDef => must(ctx.catalog.unitClasses[u.classId], `class ${u.classId}`);
export const sensorDef = (ctx: Ctx, id: string): SensorDef => must(ctx.catalog.sensors[id], `sensor ${id}`);
export const weaponDef = (ctx: Ctx, id: string): WeaponDef => must(ctx.catalog.weapons[id], `weapon ${id}`);
export const mountDef = (ctx: Ctx, u: UnitState, mountId: string): MountDef | undefined =>
  classOf(ctx, u).mounts.find((m) => m.id === mountId);

// --- Missile groups --------------------------------------------------------

export function groupPosition(g: MissileGroupState, t: SimTime): Vec3 {
  if (t <= g.launchTime) return g.origin;
  if (t >= g.arrivalTime) return g.aimPoint;
  return lerp(g.origin, g.aimPoint, (t - g.launchTime) / (g.arrivalTime - g.launchTime));
}

export function groupVelocity(g: MissileGroupState, t: SimTime): Vec3 {
  if (t < g.launchTime || t >= g.arrivalTime) return [0, 0, 0];
  return scale(normalize(sub(g.aimPoint, g.origin)), g.speedMps);
}

/** Group is physically in the air at t. */
export const groupAirborne = (g: MissileGroupState, t: SimTime): boolean =>
  g.status === 'flying' && g.count > 0 && t >= g.launchTime && t < g.arrivalTime;

// --- Entities (units + groups) --------------------------------------------

export interface EntityInfo {
  id: EntityId;
  side: string;
  kind: 'unit' | 'group';
  signature: number;
  maxSpeed: number;
}

export function entityInfo(ctx: Ctx, s: WorldState, id: EntityId): EntityInfo | undefined {
  const u = s.units[id];
  if (u) return { id, side: u.side, kind: 'unit', signature: classOf(ctx, u).signature, maxSpeed: Math.max(classOf(ctx, u).maxSpeedMps, maxSpeedOf(u.motion)) };
  const g = s.groups[id];
  if (g) return { id, side: g.side, kind: 'group', signature: weaponDef(ctx, g.weaponId).signature ?? 0.1, maxSpeed: g.speedMps };
  return undefined;
}

export function entityPosition(s: WorldState, id: EntityId, t: SimTime): Vec3 {
  const u = s.units[id];
  if (u) return positionAt(u.motion, t);
  const g = s.groups[id];
  if (g) return groupPosition(g, t);
  throw new RuleError(`unknown entity ${id}`);
}

export function entityVelocity(s: WorldState, id: EntityId, t: SimTime): Vec3 {
  const u = s.units[id];
  if (u) return velocityAt(u.motion, t);
  const g = s.groups[id];
  if (g) return groupVelocity(g, t);
  return [0, 0, 0];
}

/** Whether the entity physically exists (can be sensed / hit) at t. */
export function entityExists(s: WorldState, id: EntityId, t: SimTime): boolean {
  const u = s.units[id];
  if (u) return u.status !== 'destroyed';
  const g = s.groups[id];
  return g ? groupAirborne(g, t) : false;
}

export function allEntityIds(s: WorldState): EntityId[] {
  return [...Object.keys(s.units), ...Object.keys(s.groups)].sort();
}

/** Unit has an emitting sensor switched on. */
export function isEmitting(ctx: Ctx, s: WorldState, id: EntityId): boolean {
  const u = s.units[id];
  if (!u || u.status === 'destroyed') return false;
  return Object.entries(u.sensorsOn).some(([sid, on]) => on && sensorDef(ctx, sid).emits);
}

// --- Attitude --------------------------------------------------------------

export function orientationAt(ctx: Ctx, u: UnitState, t: SimTime): Quat {
  const a = u.attitude;
  if (!a.goal) return a.q0;
  const total = quatAngleDeg(a.q0, a.goal);
  if (total < 1e-9) return a.goal;
  const rate = classOf(ctx, u).maxSlewRateDegS;
  const f = Math.min(1, (((t - a.t0) / 1000) * rate) / total);
  return f >= 1 ? a.goal : slerp(a.q0, a.goal, f);
}

/** Time at which the current slew finishes (or t0 if none). */
export function slewCompleteAt(ctx: Ctx, u: UnitState): SimTime {
  const a = u.attitude;
  if (!a.goal) return a.t0;
  const rate = classOf(ctx, u).maxSlewRateDegS;
  return a.t0 + Math.ceil((quatAngleDeg(a.q0, a.goal) / rate) * 1000);
}

// --- Tracks ----------------------------------------------------------------

export const trackOf = (s: WorldState, unitId: string, trackId: string): Track | undefined => s.knowledge[unitId]?.[trackId];

/** Best-guess (mean) position of a track at time t (dead-reckoned). Null for bearing-only tracks. */
export const trackPositionAt = (tr: TrackEstimate, t: SimTime): Vec3 | null => predictedPosition(tr, t);

/** Scenario-wide unknown-manoeuvre level used for track extrapolation. */
export const velocityDrift = (ctx: Ctx): number => ctx.scenario.trackPrediction?.velocityDriftMpsPerMin ?? DEFAULT_VELOCITY_DRIFT_MPS_PER_MIN;

/** Position covariance of a track extrapolated to time t. Null for bearing-only tracks. */
export const trackCovarianceAt = (ctx: Ctx, tr: TrackEstimate, t: SimTime): Mat3 | null => predictedCovariance(tr, t, velocityDrift(ctx));

/**
 * Lead-pursuit aim point: where the track is predicted to be when a projectile
 * of `speed` launched from `from` at `t` arrives. Fixed-point iteration.
 */
export function leadAimPoint(tr: Track, from: Vec3, t: SimTime, speed: number): { aim: Vec3; tofS: number } | null {
  let aim = trackPositionAt(tr, t);
  if (!aim) return null;
  let tof = length(sub(aim, from)) / speed;
  for (let i = 0; i < 8; i++) {
    aim = trackPositionAt(tr, t + tof * 1000)!;
    tof = length(sub(aim, from)) / speed;
  }
  return { aim, tofS: tof };
}
