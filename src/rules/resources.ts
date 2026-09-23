/**
 * Shared control resources on a unit: hull_attitude (constraint set),
 * exclusive resources (turrets, hull_translation) and capacity resources
 * (fire-control channels, illuminators).
 */
import { type Explanation, check, info } from '../core/explain.js';
import type { SimTime } from '../core/time.js';
import type { ResourceDef } from '../state/defs.js';
import type { ResourceClaim, UnitState, WorldState } from '../state/types.js';
import { type Ctx, classOf, orientationAt } from './world.js';
import { attitudeClaims, claimsFeasible } from './attitude.js';

export const resourceDefOf = (ctx: Ctx, u: UnitState, id: string): ResourceDef | undefined =>
  classOf(ctx, u).resources.find((r) => r.id === id);

export function capacityUsed(u: UnitState, resource: string): number {
  return u.claims.filter((c) => c.resource === resource && c.status === 'active').reduce((a, c) => a + (c.amount ?? 1), 0);
}

export function capacityFree(ctx: Ctx, u: UnitState, resource: string): number {
  const def = resourceDefOf(ctx, u, resource);
  if (!def || def.kind !== 'capacity') return 0;
  return Math.max(0, def.capacity - capacityUsed(u, resource));
}

export function exclusiveHolder(u: UnitState, resource: string): ResourceClaim | undefined {
  return u.claims.find((c) => c.resource === resource && c.status === 'active');
}

export function checkExclusiveFree(u: UnitState, resource: string, minPriority = -Infinity): Explanation {
  const h = exclusiveHolder(u, resource);
  const blocked = h !== undefined && h.priority >= minPriority;
  return check(blocked ? `${resource} 已被 ${h!.owner.label} 占用（优先级 ${h!.priority}）` : `${resource} 空闲`, !blocked);
}

/**
 * Evaluate adding an attitude claim. Returns which lower-priority claims it
 * would suspend, or why it is refused (a higher/equal-priority claim conflicts).
 */
export function planAttitudeClaim(
  ctx: Ctx,
  s: WorldState,
  u: UnitState,
  claim: ResourceClaim,
  t: SimTime,
): { ok: boolean; suspend: string[]; explanation: Explanation } {
  const active = attitudeClaims(u);
  const dominant = active.filter((c) => c.priority >= claim.priority);
  const base = claimsFeasible(ctx, s, u, [...dominant, claim], t);
  if (!base.ok) {
    return {
      ok: false,
      suspend: [],
      explanation: check('hull_attitude: 与同级或更高优先级约束冲突，不能进入该姿态', false, {
        children: [
          base.explanation,
          ...dominant.map((c) => info(`现有约束: ${c.owner.label}（优先级 ${c.priority}）`)),
        ],
      }),
    };
  }
  // Keep lower-priority claims in priority order while still feasible; suspend the rest.
  const kept = [...dominant, claim];
  const suspend: string[] = [];
  for (const c of active.filter((c) => c.priority < claim.priority)) {
    if (claimsFeasible(ctx, s, u, [...kept, c], t).ok) kept.push(c);
    else suspend.push(c.id);
  }
  return {
    ok: true,
    suspend,
    explanation: check('hull_attitude: 约束可满足', true, {
      children: [
        base.explanation,
        ...suspend.map((id) => info(`较低优先级约束将被挂起: ${u.claims.find((c) => c.id === id)!.owner.label}`)),
      ],
    }),
  };
}

/** Re-derive the attitude goal from the unit's active claims at time t (mutates u). */
export function refreshAttitudeGoal(ctx: Ctx, s: WorldState, u: UnitState, t: SimTime): void {
  const q = orientationAt(ctx, u, t);
  const res = claimsFeasible(ctx, s, u, attitudeClaims(u), t);
  u.attitude = { t0: t, q0: q, goal: res.ok ? res.q : null };
}

/**
 * After a claim is released, bring back suspended claims (highest priority
 * first) that are compatible again. Returns resumed claim ids (mutates u).
 */
export function resumeSuspended(ctx: Ctx, s: WorldState, u: UnitState, t: SimTime): string[] {
  const resumed: string[] = [];
  for (const c of attitudeClaims(u, 'suspended')) {
    if (claimsFeasible(ctx, s, u, [...attitudeClaims(u), c], t).ok) {
      c.status = 'active';
      resumed.push(c.id);
    }
  }
  return resumed;
}
