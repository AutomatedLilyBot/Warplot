import { describe, expect, test } from 'vitest';
import { Session } from '../src/events/session.js';
import { ddg, detectAll, miniCtx, must } from './helpers.js';
import { conePairFeasible, solveCones, coneError, type ResolvedCone } from '../src/rules/attitude.js';
import { IDENTITY } from '../src/core/math/quat.js';
import type { Vec3 } from '../src/core/math/vec3.js';

const dirDeg = (deg: number): Vec3 => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0];
const cone = (id: string, axis: Vec3, dir: Vec3, half: number): ResolvedCone => ({ claimId: id, label: id, bodyAxis: axis, worldDir: dir, halfAngleDeg: half });

describe('orientation constraint sets', () => {
  test('two forward-axis cones intersect iff their separation ≤ θ1 + θ2', () => {
    const a = cone('gun2deg', [1, 0, 0], dirDeg(0), 2);
    const b = cone('gun3deg', [1, 0, 0], dirDeg(4.5), 3);
    const c = cone('gun3deg', [1, 0, 0], dirDeg(5.5), 3);
    expect(conePairFeasible(a, b).ok).toBe(true);
    expect(conePairFeasible(a, c).ok).toBe(false);
    const sol = solveCones(IDENTITY, [a, b]);
    expect(sol.ok).toBe(true);
    expect(coneError(sol.q, a)).toBeLessThanOrEqual(2);
    expect(coneError(sol.q, b)).toBeLessThanOrEqual(3);
    expect(solveCones(IDENTITY, [a, c]).ok).toBe(false);
  });

  test('different body axes: bow gun + broadside mount can both be served when geometry matches', () => {
    const bow = cone('bow', [1, 0, 0], dirDeg(30), 2);
    const port = cone('port', [0, 1, 0], dirDeg(121), 2); // port axis is +90° from bow; 91° apart in world
    const sol = solveCones(IDENTITY, [bow, port]);
    expect(sol.ok).toBe(true);
    expect(coneError(sol.q, bow)).toBeLessThanOrEqual(2);
    expect(coneError(sol.q, port)).toBeLessThanOrEqual(2);
    const bad = cone('port', [0, 1, 0], dirDeg(30), 2); // wants port axis where bow must point
    expect(solveCones(IDENTITY, [bow, bad]).ok).toBe(false);
  });
});

/** Blue DDG facing east; red DDG 40 km due north (90° off the bow). */
function broadside() {
  const ctx = miniCtx([ddg('b1', 'blue', [0, 0, 0], { headingDeg: 0 }), ddg('r1', 'red', [0, 40_000, 0], { headingDeg: 0 })]);
  const s = new Session(ctx);
  must(s, { type: 'ADVANCE', until: 1 });
  detectAll(s);
  const trackId = Object.keys(s.state.knowledge['b1']!)[0]!;
  return { s, trackId };
}

describe('axial gun needs hull attitude', () => {
  test('refused when off-axis; ALIGN slews the hull; legal once within the cone', () => {
    const { s, trackId } = broadside();
    const fire = { type: 'LAUNCH', unitId: 'b1', mountId: 'rail', weaponId: 'rail-slug', count: 1, trackId } as const;

    const v0 = s.check(fire);
    expect(v0.ok).toBe(false);
    expect(JSON.stringify(v0.checks)).toContain('轴线误差');
    expect(JSON.stringify(v0.checks)).toContain('ALIGN');

    must(s, { type: 'ALIGN', unitId: 'b1', mountId: 'rail', trackId, priority: 1 });
    const v1 = s.check(fire);
    expect(v1.ok).toBe(false);
    // ~88° to go at 3°/s ≈ 29.3 s
    expect(v1.earliest! - s.state.time).toBeGreaterThan(28_000);
    expect(v1.earliest! - s.state.time).toBeLessThan(31_000);

    must(s, { type: 'ADVANCE', until: v1.earliest! });
    expect(s.check(fire).ok).toBe(true);
    must(s, fire);
  });

  test('a higher-priority EVADE blocks ALIGN (hull_attitude occupied)', () => {
    const { s, trackId } = broadside();
    must(s, { type: 'MANEUVER', unitId: 'b1', label: 'EVADE missile_group_04', priority: 10, durationS: 60 });
    const v = s.check({ type: 'ALIGN', unitId: 'b1', mountId: 'rail', trackId, priority: 1 });
    expect(v.ok).toBe(false);
    expect(JSON.stringify(v.checks)).toContain('EVADE missile_group_04');
  });

  test('EVADE suspends an existing lower-priority ALIGN and it resumes when EVADE ends', () => {
    const { s, trackId } = broadside();
    must(s, { type: 'ALIGN', unitId: 'b1', mountId: 'rail', trackId, priority: 1 });
    const align = s.state.units['b1']!.claims[0]!;
    must(s, { type: 'MANEUVER', unitId: 'b1', label: 'EVADE', priority: 10, durationS: 30 });
    expect(s.state.units['b1']!.claims.find((c) => c.id === align.id)!.status).toBe('suspended');
    must(s, { type: 'ADVANCE', until: s.state.time + 30_001 });
    const u = s.state.units['b1']!;
    expect(u.claims.find((c) => c.id === align.id)!.status).toBe('active');
    expect(u.claims.some((c) => c.owner.label === 'EVADE')).toBe(false);
    expect(s.state.log.some((e) => e.kind === 'CLAIM_RESUMED')).toBe(true);
  });

  test('turret mount does not need hull attitude (VLS neither)', () => {
    const { s, trackId } = broadside();
    must(s, { type: 'MANEUVER', unitId: 'b1', label: 'EVADE', priority: 10, durationS: 60 });
    expect(s.check({ type: 'LAUNCH', unitId: 'b1', mountId: 'vls', weaponId: 'asm-x', count: 1, trackId }).ok).toBe(true);
  });
});
