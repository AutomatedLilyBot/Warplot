/**
 * Detection is never rolled. The rules only answer: "from when is detection
 * physically/rule-wise possible?" The author then rules detected / not.
 */
import { distance } from '../core/math/vec3.js';
import { pointSegmentDistance } from '../core/math/geometry.js';
import { type Explanation, check } from '../core/explain.js';
import type { SimTime } from '../core/time.js';
import type { EntityId, UnitState, WorldState } from '../state/types.js';
import { type Ctx, entityExists, entityInfo, entityPosition, isEmitting, sensorDef } from './world.js';
import { positionAt, maxSpeedOf } from './kinematics.js';
import { type Probe, firstFlip, rangeStep } from './search.js';

export interface DetectabilityResult extends Probe {
  checks: Explanation[];
  rangeM: number;
  dist: number;
}

export function detectability(
  ctx: Ctx,
  s: WorldState,
  observer: UnitState,
  sensorId: string,
  target: EntityId,
  t: SimTime,
): DetectabilityResult {
  const sd = sensorDef(ctx, sensorId);
  const info = entityInfo(ctx, s, target)!;
  const on = observer.sensorsOn[sensorId] === true && observer.status !== 'destroyed' && observer.status !== 'disabled';
  const exists = entityExists(s, target, t);
  const rangeM = sd.rangeM * info.signature;
  const po = positionAt(observer.motion, t);
  const pt = entityPosition(s, target, t);
  const dist = distance(po, pt);
  const inRange = dist <= rangeM;
  // Sight line clearance per obstacle (negative = blocked).
  const clearances = ctx.scenario.obstacles.map((o) => ({ o, c: pointSegmentDistance(o.center, po, pt) - o.radiusM }));
  const blocker = clearances.find((x) => x.c < 0)?.o;
  const emitting = sd.requiresTargetEmission ? isEmitting(ctx, s, target) : true;

  const checks = [
    check(`${sd.name} 开机`, on),
    check('目标存在', exists),
    check(`距离 ${(dist / 1000).toFixed(1)} km ≤ 探测范围 ${(rangeM / 1000).toFixed(1)} km`, inRange),
    check(blocker ? `视线被 ${blocker.name} 遮挡` : '视线无遮挡', !blocker),
  ];
  if (sd.requiresTargetEmission) checks.push(check('目标正在辐射（被动侦察需要）', emitting));
  const ok = on && exists && inRange && !blocker && emitting;

  // Conservative step. Sensor/emission switches only change via commands (which re-run the search).
  const vObs = maxSpeedOf(observer.motion);
  const closing = vObs + info.maxSpeed;
  let step = rangeStep(dist, rangeM, closing);
  // Each end of the sight line moves at most max(v) per second, so its distance
  // to an obstacle centre cannot change faster than that.
  const vLine = Math.max(vObs, info.maxSpeed);
  for (const { c } of clearances) step = Math.min(step, vLine > 0 ? (Math.abs(c) / vLine) * 1000 : Infinity);
  if (!exists) {
    const g = s.groups[target];
    step = Math.min(step, g && t < g.launchTime ? g.launchTime - t : Infinity);
  }
  return { ok, safeStepMs: step, checks, rangeM, dist };
}

/** Earliest time in [t0, tMax] when the pair is detectable. */
export function nextDetectable(
  ctx: Ctx,
  s: WorldState,
  observer: UnitState,
  sensorId: string,
  target: EntityId,
  t0: SimTime,
  tMax: SimTime,
): SimTime | null {
  return firstFlip((t) => detectability(ctx, s, observer, sensorId, target, t), t0, tMax, true);
}

/** Earliest time in (t0, tMax] when a currently-held contact stops being detectable. */
export function nextUndetectable(
  ctx: Ctx,
  s: WorldState,
  observer: UnitState,
  sensorId: string,
  target: EntityId,
  t0: SimTime,
  tMax: SimTime,
): SimTime | null {
  return firstFlip((t) => detectability(ctx, s, observer, sensorId, target, t), t0, tMax, false);
}
