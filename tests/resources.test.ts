import { describe, expect, test } from 'vitest';
import { Session } from '../src/events/session.js';
import { ddg, detectAll, miniCtx, must, pending } from './helpers.js';
import type { Command } from '../src/events/types.js';

/** Two red salvoes inbound on a blue DDG facing north (threats on the starboard beam, CIWS clear). */
function twoRaids() {
  const ctx = miniCtx([ddg('b1', 'blue', [0, 0, 0], { headingDeg: 90 }), ddg('r1', 'red', [100_000, 0, 0], { headingDeg: 180 })]);
  const s = new Session(ctx);
  must(s, { type: 'ADVANCE', until: 1 });
  detectAll(s);
  must(s, { type: 'LAUNCH', unitId: 'r1', mountId: 'vls', weaponId: 'asm-x', count: 6, trackId: 'red-T1' });
  must(s, { type: 'ADVANCE', until: 6000 }); // VLS busy 6 × 1 s after the first salvo
  must(s, { type: 'LAUNCH', unitId: 'r1', mountId: 'vls', weaponId: 'asm-x', count: 6, trackId: 'red-T1' });
  must(s, { type: 'ADVANCE' });
  detectAll(s);
  must(s, { type: 'ADVANCE' });
  detectAll(s);
  const tracks = Object.keys(s.state.knowledge['b1']!).filter((id) => s.state.truth.trackTargets[id]?.startsWith('red-MG'));
  expect(tracks).toHaveLength(2);
  return { s, tracks: tracks.sort() };
}

describe('capacity and exclusive resources', () => {
  test('fire-control channels are shared between engagements', () => {
    const { s, tracks } = twoRaids();
    must(s, { type: 'ENGAGE', unitId: 'b1', mountId: 'vls', weaponId: 'sam-std', trackId: tracks[0]!, channels: 3 });
    must(s, { type: 'ENGAGE', unitId: 'b1', mountId: 'vls', weaponId: 'sam-std', trackId: tracks[1]!, channels: 3 });
    const engs = Object.values(s.state.engagements);
    expect(engs.map((e) => e.channels)).toEqual([3, 1]); // only one channel was left
    const v = s.check({ type: 'ENGAGE', unitId: 'b1', mountId: 'vls', weaponId: 'sam-std', trackId: tracks[1]! });
    expect(v.ok).toBe(false);
    expect(JSON.stringify(v.checks)).toContain('可用火控通道 0');
  });

  test('illuminators are a separate bottleneck', () => {
    const { s, tracks } = twoRaids();
    must(s, { type: 'ENGAGE', unitId: 'b1', mountId: 'vls', weaponId: 'sam-std', trackId: tracks[0]!, channels: 1 });
    must(s, { type: 'ENGAGE', unitId: 'b1', mountId: 'vls', weaponId: 'sam-std', trackId: tracks[1]!, channels: 1 });
    const used = s.state.units['b1']!.claims.filter((c) => c.resource === 'illuminator').reduce((a, c) => a + (c.amount ?? 0), 0);
    expect(used).toBe(2);
    const v = s.check({ type: 'ENGAGE', unitId: 'b1', mountId: 'vls', weaponId: 'sam-std', trackId: tracks[0]!, channels: 1 });
    expect(v.ok).toBe(false);
    expect(JSON.stringify(v.checks)).toContain('照射器 0');
  });

  test('a turret is exclusive: one CIWS engagement at a time', () => {
    const { s, tracks } = twoRaids();
    must(s, { type: 'ENGAGE', unitId: 'b1', mountId: 'ciws', weaponId: 'ciws-burst', trackId: tracks[0]! });
    const v = s.check({ type: 'ENGAGE', unitId: 'b1', mountId: 'ciws', weaponId: 'ciws-burst', trackId: tracks[1]! });
    expect(v.ok).toBe(false);
    expect(JSON.stringify(v.checks)).toContain('ciws_stbd 已被');
  });

  test('engagement claims cannot be released by hand; they free up after the ruling', () => {
    const { s, tracks } = twoRaids();
    must(s, { type: 'ENGAGE', unitId: 'b1', mountId: 'vls', weaponId: 'sam-std', trackId: tracks[0]! });
    const claim = s.state.units['b1']!.claims[0]!;
    expect(s.check({ type: 'RELEASE_CLAIM', unitId: 'b1', claimId: claim.id }).ok).toBe(false);
    must(s, { type: 'ADVANCE' });
    const o = pending(s).find((x) => x.kind === 'intercept')!;
    if (o.kind !== 'intercept') throw new Error();
    must(s, { type: 'RESOLVE', opportunityId: o.id, decision: { kind: 'intercept', intercepted: o.bounds.min } });
    expect(s.state.units['b1']!.claims.filter((c) => c.owner.kind === 'engagement')).toHaveLength(0);
  });

  test('a maneuver holding hull_translation blocks SET_ROUTE until it ends', () => {
    const s = new Session(miniCtx([ddg('b1', 'blue', [0, 0, 0], { sensorsOn: [] })]));
    must(s, { type: 'MANEUVER', unitId: 'b1', label: '之字规避', priority: 10, durationS: 30, claimsTranslation: true });
    const route: Command = { type: 'SET_ROUTE', unitId: 'b1', waypoints: [{ position: [10_000, 0, 0] }] };
    expect(JSON.stringify(s.check(route).checks)).toContain('hull_translation 已被 之字规避');
    must(s, { type: 'ADVANCE', until: 30_000 });
    expect(s.check(route).ok).toBe(true);
  });

  test('author-released ALIGN claim frees the hull', () => {
    const ctx = miniCtx([ddg('b1', 'blue', [0, 0, 0]), ddg('r1', 'red', [0, 40_000, 0], { sensorsOn: [] })]);
    const s = new Session(ctx);
    must(s, { type: 'ADVANCE' });
    detectAll(s);
    must(s, { type: 'ALIGN', unitId: 'b1', mountId: 'rail', trackId: 'blue-T1', priority: 1 });
    // A second ALIGN on the same mount replaces the first instead of conflicting with it.
    must(s, { type: 'ALIGN', unitId: 'b1', mountId: 'rail', trackId: 'blue-T1', priority: 2 });
    const claims = s.state.units['b1']!.claims;
    expect(claims).toHaveLength(1);
    must(s, { type: 'RELEASE_CLAIM', unitId: 'b1', claimId: claims[0]!.id });
    expect(s.state.units['b1']!.claims).toHaveLength(0);
    expect(s.state.units['b1']!.attitude.goal).toBeNull();
  });
});
