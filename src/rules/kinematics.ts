/**
 * Simplified translation: straight legs between waypoints, constant-acceleration
 * speed changes limited by maxAccel, cruise at min(waypoint speed, maxSpeed),
 * stop at the final waypoint. No turning radius, no dynamics.
 * Positions are pure functions of time, so nothing needs ticking.
 */
import { type Vec3, add, scale, sub, length, normalize } from '../core/math/vec3.js';
import type { SimTime } from '../core/time.js';
import type { UnitClassDef, Waypoint } from '../state/defs.js';
import type { MotionPlan, MotionSegment } from '../state/types.js';

const EPS = 1e-6;

export function segmentAt(plan: MotionPlan, t: SimTime): MotionSegment | undefined {
  const segs = plan.segments;
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i]!;
    if (t >= s.t0) return s;
  }
  return segs[0];
}

function evalSegment(s: MotionSegment, t: SimTime): { p: Vec3; v: number } {
  const end = s.t1 ?? Infinity;
  const dt = (Math.max(s.t0, Math.min(t, end)) - s.t0) / 1000;
  const dist = s.v0 * dt + 0.5 * s.a * dt * dt;
  return { p: add(s.p0, scale(s.dir, dist)), v: Math.max(0, s.v0 + s.a * dt) };
}

export function positionAt(plan: MotionPlan, t: SimTime): Vec3 {
  const s = segmentAt(plan, t);
  return s ? evalSegment(s, t).p : [0, 0, 0];
}

export function velocityAt(plan: MotionPlan, t: SimTime): Vec3 {
  const s = segmentAt(plan, t);
  if (!s) return [0, 0, 0];
  if (s.t1 !== null && t >= s.t1) return [0, 0, 0];
  return scale(s.dir, evalSegment(s, t).v);
}

/** A plan that just sits at p (or drifts at constant velocity v) forever. */
export function stationaryPlan(t0: SimTime, p: Vec3, velocity?: Vec3): MotionPlan {
  const v = velocity ? length(velocity) : 0;
  return {
    segments: [{ t0, t1: null, p0: p, dir: v > 0 ? normalize(velocity!) : [1, 0, 0], v0: v, a: 0 }],
    route: [],
    arrivesAt: null,
  };
}

/** Builder that appends constant-acceleration pieces along one direction. */
class PlanBuilder {
  segments: MotionSegment[] = [];
  constructor(
    public t: number,
    public p: Vec3,
  ) {}

  /** Move `dist` metres along dir starting at speed v0 with accel a. Returns exit speed. */
  piece(dir: Vec3, v0: number, a: number, dist: number): number {
    if (dist <= EPS) return v0;
    let dt: number;
    if (Math.abs(a) < EPS) dt = dist / v0;
    else {
      const disc = Math.max(0, v0 * v0 + 2 * a * dist);
      dt = (-v0 + Math.sqrt(disc)) / a;
    }
    const t1 = this.t + dt * 1000;
    this.segments.push({ t0: this.t, t1, p0: this.p, dir, v0, a });
    this.t = t1;
    this.p = add(this.p, scale(dir, dist));
    return Math.max(0, v0 + a * dt);
  }
}

/**
 * Plan a route from the current kinematic state. Intermediate waypoints carry
 * speed through; the unit brakes to a stop exactly at the final waypoint.
 */
export function planRoute(
  t0: SimTime,
  start: Vec3,
  startSpeed: number,
  startDir: Vec3,
  waypoints: Waypoint[],
  cls: UnitClassDef,
): MotionPlan {
  const acc = cls.maxAccelMps2;
  const b = new PlanBuilder(t0, start);
  let u = startSpeed;

  if (waypoints.length === 0) {
    // Stop along the current direction.
    if (u > EPS) {
      const d = (u * u) / (2 * acc);
      b.piece(normalize(startDir), u, -acc, d);
    }
    return finish(b, [], null);
  }

  let from = start;
  waypoints.forEach((wp, i) => {
    const legVec = sub(wp.position, from);
    const L = length(legVec);
    from = wp.position;
    if (L <= EPS) return;
    const dir = normalize(legVec);
    const v = Math.min(wp.speedMps ?? cls.maxSpeedMps, cls.maxSpeedMps);
    const last = i === waypoints.length - 1;

    if (!last && v > 0) {
      const dA = Math.abs(v * v - u * u) / (2 * acc);
      if (dA >= L) {
        u = b.piece(dir, u, v > u ? acc : -acc, L);
      } else {
        u = b.piece(dir, u, v > u ? acc : -acc, dA);
        u = b.piece(dir, v, 0, L - dA);
      }
      return;
    }

    // The final waypoint and any zero-speed waypoint must be reached at rest.
    // Zero specifies the arrival speed, so use the class speed as the leg's cruise cap.
    const cruise = v > 0 ? v : cls.maxSpeedMps;
    const brakeFrom = (w: number) => (w * w) / (2 * acc);
    if (brakeFrom(u) > L) {
      // Cannot stop in time at max decel: brake harder (simplification, logged via plan only).
      const aHard = (u * u) / (2 * L);
      b.piece(dir, u, -aHard, L);
      u = 0;
      return;
    }
    if (u <= cruise) {
      const dA = (cruise * cruise - u * u) / (2 * acc);
      const dB = brakeFrom(cruise);
      if (dA + dB <= L) {
        b.piece(dir, u, acc, dA);
        b.piece(dir, cruise, 0, L - dA - dB);
        b.piece(dir, cruise, -acc, dB);
      } else {
        const vp = Math.sqrt((2 * acc * L + u * u) / 2);
        const d1 = (vp * vp - u * u) / (2 * acc);
        b.piece(dir, u, acc, d1);
        b.piece(dir, vp, -acc, L - d1);
      }
    } else {
      const dA = (u * u - cruise * cruise) / (2 * acc);
      const dB = brakeFrom(cruise);
      if (dA + dB <= L) {
        b.piece(dir, u, -acc, dA);
        b.piece(dir, cruise, 0, L - dA - dB);
        b.piece(dir, cruise, -acc, dB);
      } else {
        const dB2 = brakeFrom(u);
        b.piece(dir, u, 0, L - dB2);
        b.piece(dir, u, -acc, dB2);
      }
    }
    u = 0;
  });

  return finish(b, waypoints, b.t);
}

function finish(b: PlanBuilder, route: Waypoint[], arrivesAt: number | null): MotionPlan {
  // Terminal rest segment.
  b.segments.push({ t0: b.t, t1: null, p0: b.p, dir: [1, 0, 0], v0: 0, a: 0 });
  return { segments: b.segments, route, arrivesAt: arrivesAt === null ? null : Math.ceil(arrivesAt) };
}

/** Upper bound on speed along a plan (used for conservative time-stepping). */
export function maxSpeedOf(plan: MotionPlan): number {
  let m = 0;
  for (const s of plan.segments) {
    m = Math.max(m, s.v0);
    if (s.t1 !== null) m = Math.max(m, s.v0 + (s.a * (s.t1 - s.t0)) / 1000);
  }
  return m;
}
