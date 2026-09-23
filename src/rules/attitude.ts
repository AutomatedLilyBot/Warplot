/**
 * Hull attitude as a shared control resource.
 *
 * Weapons never steer the hull. They *declare* constraints ("my bore must be
 * within 2° of Track-12"). The attitude controller collects active claims,
 * resolves them by priority, and finds one orientation satisfying all of them
 * — or reports which pair conflicts and why.
 */
import { type Vec3, angleDeg, cross, dot, normalize, sub, scale, anyPerpendicular } from '../core/math/vec3.js';
import { type Quat, quatFromAxisAngle, quatFromTo, quatMul, rotate } from '../core/math/quat.js';
import { type Explanation, check, info } from '../core/explain.js';
import type { SimTime } from '../core/time.js';
import type { AttitudeConstraint, ResourceClaim, UnitState, WorldState } from '../state/types.js';
import { type Ctx, orientationAt, trackOf, trackPositionAt } from './world.js';
import { positionAt } from './kinematics.js';

/** Constraint with its target resolved to a world direction at a given time. */
export interface ResolvedCone {
  claimId: string;
  label: string;
  bodyAxis: Vec3;
  worldDir: Vec3;
  halfAngleDeg: number;
}

const MARGIN_DEG = 0.05;

export function resolveConstraint(
  s: WorldState,
  u: UnitState,
  claim: ResourceClaim,
  t: SimTime,
): ResolvedCone | 'exclusive' | null {
  const c = claim.constraint;
  if (!c) return null;
  if (c.kind === 'exclusive') return 'exclusive';
  let dir: Vec3 | null = null;
  if (c.target.kind === 'direction') dir = normalize(c.target.dir);
  else {
    const tr = trackOf(s, u.id, c.target.trackId);
    if (tr) {
      const p = trackPositionAt(tr, t);
      if (p) dir = normalize(sub(p, positionAt(u.motion, t)));
      else if (tr.estimate.kind === 'bearing') dir = normalize(tr.estimate.direction);
    }
  }
  if (!dir) return null;
  return { claimId: claim.id, label: claim.owner.label, bodyAxis: normalize(c.bodyAxis), worldDir: dir, halfAngleDeg: c.halfAngleDeg };
}

/**
 * Pairwise feasibility of two cone constraints. The angle between the two
 * body axes is rigid, so world directions u1,u2 with ∠(u1,u2)=∠(a1,a2) exist
 * inside both cones iff |∠(d1,d2) − ∠(a1,a2)| ≤ θ1 + θ2.
 */
export function conePairFeasible(c1: ResolvedCone, c2: ResolvedCone): { ok: boolean; gapDeg: number; allowanceDeg: number } {
  const gap = Math.abs(angleDeg(c1.worldDir, c2.worldDir) - angleDeg(c1.bodyAxis, c2.bodyAxis));
  const allowance = c1.halfAngleDeg + c2.halfAngleDeg;
  return { ok: gap <= allowance, gapDeg: gap, allowanceDeg: allowance };
}

export const coneError = (q: Quat, c: ResolvedCone): number => angleDeg(rotate(q, c.bodyAxis), c.worldDir);

/**
 * Constructive solve: satisfy the highest-priority cone with minimal rotation
 * from `current`, use roll to serve the second, tilt within cone 1's slack if
 * needed, then verify every cone numerically.
 */
export function solveCones(current: Quat, cones: ResolvedCone[]): { ok: boolean; q: Quat; explanation: Explanation } {
  if (cones.length === 0) return { ok: true, q: current, explanation: info('无姿态约束 / no attitude constraints') };
  const [c1, c2] = cones as [ResolvedCone, ResolvedCone | undefined];

  const reasons: Explanation[] = [];
  for (let i = 0; i < cones.length; i++)
    for (let j = i + 1; j < cones.length; j++) {
      const p = conePairFeasible(cones[i]!, cones[j]!);
      reasons.push(
        check(`${cones[i]!.label} ∩ ${cones[j]!.label}`, p.ok, {
          value: `需要偏差 ${p.gapDeg.toFixed(2)}° / 允许 ${p.allowanceDeg.toFixed(2)}°`,
        }),
      );
    }
  if (reasons.some((r) => r.ok === false))
    return { ok: false, q: current, explanation: check('姿态约束无交集 / attitude constraints conflict', false, { children: reasons }) };

  // Direction for body axis 1: aim at d1, tilted toward/away from d2 if cone 2 needs slack.
  let u1 = c1.worldDir;
  if (c2) {
    const need = angleDeg(c1.worldDir, c2.worldDir) - angleDeg(c1.bodyAxis, c2.bodyAxis);
    const excess = Math.abs(need) - Math.max(0, c2.halfAngleDeg - MARGIN_DEG);
    if (excess > 0) {
      const tilt = Math.min(excess + MARGIN_DEG, Math.max(0, c1.halfAngleDeg - MARGIN_DEG));
      let axis = cross(c1.worldDir, c2.worldDir);
      if (Math.hypot(...axis) < 1e-9) axis = anyPerpendicular(c1.worldDir);
      u1 = rotate(quatFromAxisAngle(axis, need > 0 ? tilt : -tilt), c1.worldDir);
    }
  }
  const cur1 = rotate(current, c1.bodyAxis);
  let q = quatMul(quatFromTo(cur1, u1), current);

  if (c2) {
    // Roll about u1 so body axis 2 lands as close as possible to d2.
    const a2w = rotate(q, c2.bodyAxis);
    const pa = sub(a2w, scale(u1, dot(a2w, u1)));
    const pd = sub(c2.worldDir, scale(u1, dot(c2.worldDir, u1)));
    if (Math.hypot(...pa) > 1e-9 && Math.hypot(...pd) > 1e-9) {
      const sign = dot(cross(pa, pd), u1) >= 0 ? 1 : -1;
      q = quatMul(quatFromAxisAngle(u1, sign * angleDeg(pa, pd)), q);
    }
  }

  const verify = cones.map((c) => {
    const e = coneError(q, c);
    return check(`${c.label}`, e <= c.halfAngleDeg + 1e-6, { value: `误差 ${e.toFixed(2)}° ≤ ${c.halfAngleDeg}°` });
  });
  const ok = verify.every((v) => v.ok);
  return {
    ok,
    q,
    explanation: check(ok ? '找到满足全部约束的姿态' : '未能构造满足全部约束的姿态（保守判定为冲突）', ok, {
      children: [...reasons, ...verify],
    }),
  };
}

/** Active attitude claims of a unit, highest priority first (ties: older first). */
export function attitudeClaims(u: UnitState, status: 'active' | 'suspended' = 'active'): ResourceClaim[] {
  return u.claims
    .filter((c) => c.resource === 'hull_attitude' && c.status === status)
    .sort((a, b) => b.priority - a.priority || a.since - b.since || a.id.localeCompare(b.id));
}

/**
 * Check whether a set of attitude claims is jointly satisfiable at time t.
 * Exclusive claims (e.g. an evasive maneuver) are compatible with nothing else.
 */
export function claimsFeasible(
  ctx: Ctx,
  s: WorldState,
  u: UnitState,
  claims: ResourceClaim[],
  t: SimTime,
): { ok: boolean; q: Quat | null; explanation: Explanation } {
  const excl = claims.filter((c) => c.constraint?.kind === 'exclusive');
  if (excl.length > 0 && claims.length > 1) {
    return {
      ok: false,
      q: null,
      explanation: check(`hull_attitude 被独占机动占用: ${excl.map((c) => `${c.owner.label} (优先级 ${c.priority})`).join(', ')}`, false),
    };
  }
  if (excl.length === 1) return { ok: true, q: null, explanation: info(`独占机动 ${excl[0]!.owner.label} 控制舰体姿态`) };
  const cones: ResolvedCone[] = [];
  for (const c of claims) {
    const r = resolveConstraint(s, u, c, t);
    if (r && r !== 'exclusive') cones.push(r);
  }
  const res = solveCones(orientationAt(ctx, u, t), cones);
  return { ok: res.ok, q: res.ok ? res.q : null, explanation: res.explanation };
}

/**
 * Earliest time ≥ t at which body axis `bodyAxis` is within halfAngle of the
 * direction `dirAt(time)` given the unit's current slew. Null if never within
 * the current slew plan.
 */
export function earliestAligned(
  ctx: Ctx,
  u: UnitState,
  bodyAxis: Vec3,
  halfAngleDeg: number,
  dirAt: (t: SimTime) => Vec3,
  t: SimTime,
  horizon: SimTime,
): SimTime | null {
  const err = (tt: SimTime) => angleDeg(rotate(orientationAt(ctx, u, tt), bodyAxis), dirAt(tt));
  if (err(t) <= halfAngleDeg) return t;
  const step = 250;
  let prev = t;
  for (let tt = t + step; tt <= horizon; tt += step) {
    if (err(tt) <= halfAngleDeg) {
      let lo = prev;
      let hi = tt;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (err(mid) <= halfAngleDeg) hi = mid;
        else lo = mid;
      }
      return hi;
    }
    prev = tt;
  }
  return null;
}
