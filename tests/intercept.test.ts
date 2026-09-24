import { describe, expect, test } from 'vitest';
import { Session } from '../src/events/session.js';
import { ddg, detectAll, miniCtx, must, pending } from './helpers.js';
import type { WorldState } from '../src/state/types.js';
import { renderExplanation } from '../src/core/explain.js';

/** Red fires 8 ASMs at a blue DDG 100 km east of it. Blue heading in degrees. */
function raid(blueHeading: number) {
  const ctx = miniCtx([ddg('b1', 'blue', [0, 0, 0], { headingDeg: blueHeading }), ddg('r1', 'red', [100_000, 0, 0], { headingDeg: 180 })]);
  const s = new Session(ctx);
  must(s, { type: 'ADVANCE', until: 1 });
  detectAll(s);
  const redTrack = Object.keys(s.state.knowledge['r1']!)[0]!;
  must(s, { type: 'LAUNCH', unitId: 'r1', mountId: 'vls', weaponId: 'asm-x', count: 8, trackId: redTrack });
  must(s, { type: 'ADVANCE' });
  const opp = pending(s)[0]!;
  expect(opp.kind).toBe('detection');
  if (opp.kind !== 'detection') throw new Error();
  expect(opp.observerId).toBe('b1');
  must(s, { type: 'RESOLVE', opportunityId: opp.id, decision: { kind: 'detection', detected: true, classification: { category: 'missile', identity: 'hostile', confidence: 1 } } });
  const missileTrack = Object.values(s.state.knowledge['b1']!).find((t) => s.state.truth.trackTargets[t.id] === 'red-MG1')!.id;
  return { ctx, s, missileTrack };
}

function inventory(st: WorldState): number {
  let n = 0;
  for (const u of Object.values(st.units)) for (const m of Object.values(u.mounts)) for (const c of Object.values(m.ammo)) n += c;
  for (const g of Object.values(st.groups)) n += g.count + g.intercepted + g.hits + g.misses;
  for (const e of Object.values(st.engagements)) n += e.roundsCommitted;
  return n;
}

describe('interception bounds', () => {
  test('fractional fire-control channels are refused without reserving resources', () => {
    const { s, missileTrack } = raid(0);
    const before = JSON.stringify(s.state);
    const cmd = { type: 'ENGAGE', unitId: 'b1', mountId: 'vls', weaponId: 'sam-std', trackId: missileTrack, channels: 1.5 } as const;
    expect(s.check(cmd).ok).toBe(false);
    expect(s.dispatch(cmd).ok).toBe(false);
    expect(JSON.stringify(s.state)).toBe(before);
  });

  test('SAM engagement: legal interval with a binding factor and explanation', () => {
    const { s, missileTrack } = raid(0);
    const r = must(s, { type: 'ENGAGE', unitId: 'b1', mountId: 'vls', weaponId: 'sam-std', trackId: missileTrack });
    const eng = Object.values(s.state.engagements)[0]!;
    // window: 22.5 km (detect) → 3 km (min range) at 290 m/s ≈ 67 s
    expect((eng.window.end - eng.window.start) / 1000).toBeCloseTo((22_500 - 3000) / 290, 0);
    // E = min(4 ch × 8 cycles, 40/2 rounds, 8 missiles, 2 illum × 11) = 8 → [⌊2.4⌋, ⌊6.4⌋]
    expect(eng.engagements).toBe(8);
    expect(eng.bounds).toEqual({ min: 2, max: 6 });
    expect(eng.roundsCommitted).toBe(16);
    const text = renderExplanation(eng.explanation);
    expect(text).toContain('弹群剩余数量: 8  [瓶颈/binding]');
    expect(text).toContain('有效交战窗口');
    expect(r.events.some((e) => e.kind === 'CLAIM_ADDED' || e.kind === 'ENGAGE')).toBe(true);
    expect(s.state.units['b1']!.claims.filter((c) => c.resource === 'fire_control')[0]!.amount).toBe(4);
  });

  test('channels limit becomes the bottleneck when fewer are assigned', () => {
    const { s, missileTrack } = raid(0);
    must(s, { type: 'ENGAGE', unitId: 'b1', mountId: 'vls', weaponId: 'sam-std', trackId: missileTrack, channels: 1 });
    const eng = Object.values(s.state.engagements)[0]!;
    expect(eng.engagements).toBe(8); // 1 channel × 8 cycles = 8 — ties with raid size
    expect(renderExplanation(eng.explanation)).toContain('火控/交战通道 1 × 交战周期 8: 8  [瓶颈/binding]');
  });

  test('CIWS masked by the bridge when the threat is dead ahead; clear when broadside', () => {
    const ahead = raid(0);
    const v = ahead.s.check({ type: 'ENGAGE', unitId: 'b1', mountId: 'ciws', weaponId: 'ciws-burst', trackId: ahead.missileTrack });
    expect(v.ok).toBe(false);
    expect(JSON.stringify(v.checks)).toContain('舰桥遮挡');

    const side = raid(90); // threat now on the starboard beam (body az ≈ −90°)
    must(side.s, { type: 'ENGAGE', unitId: 'b1', mountId: 'ciws', weaponId: 'ciws-burst', trackId: side.missileTrack });
    const eng = Object.values(side.s.state.engagements)[0]!;
    expect((eng.window.end - eng.window.start) / 1000).toBeCloseTo((3500 - 300) / 290, 0);
  });

  test('weapons without fire-control channels refuse more than one engagement channel', () => {
    const { s, missileTrack } = raid(90);
    const cmd = { type: 'ENGAGE', unitId: 'b1', mountId: 'ciws', weaponId: 'ciws-burst', trackId: missileTrack } as const;
    const v = s.check({ ...cmd, channels: 3 });
    expect(v.ok).toBe(false);
    expect(JSON.stringify(v.checks)).toContain('每个发射装置只有 1 个交战通道');
    expect(s.check({ ...cmd, channels: 1 }).ok).toBe(true);
  });

  test('full raid: intercept then impact, author picks within bounds; inventory is conserved', () => {
    const { s, missileTrack } = raid(0);
    const total0 = inventory(s.state);
    must(s, { type: 'ENGAGE', unitId: 'b1', mountId: 'vls', weaponId: 'sam-std', trackId: missileTrack });
    expect(inventory(s.state)).toBe(total0);

    must(s, { type: 'ADVANCE' });
    const io = pending(s)[0]!;
    expect(io.kind).toBe('intercept');
    expect(s.dispatch({ type: 'RESOLVE', opportunityId: io.id, decision: { kind: 'intercept', intercepted: 7 } }).ok).toBe(false);
    must(s, { type: 'RESOLVE', opportunityId: io.id, decision: { kind: 'intercept', intercepted: 5 } });
    expect(s.state.groups['red-MG1']!.count).toBe(3);
    expect(s.state.units['b1']!.claims.filter((c) => c.resource === 'fire_control')).toHaveLength(0);
    expect(inventory(s.state)).toBe(total0);

    must(s, { type: 'ADVANCE' });
    // Track loss / other chances may come first; step until the impact prompt.
    for (let i = 0; i < 5 && !pending(s).some((o) => o.kind === 'impact'); i++) {
      detectAll(s);
      must(s, { type: 'ADVANCE' });
    }
    const imp = pending(s).find((o) => o.kind === 'impact')!;
    if (imp.kind !== 'impact') throw new Error();
    expect(imp.bounds).toEqual({ min: 0, max: 3 });
    must(s, { type: 'RESOLVE', opportunityId: imp.id, decision: { kind: 'impact', hits: 1 } });
    expect(s.state.units['b1']!.hitsTaken).toBe(1);
    expect(inventory(s.state)).toBe(total0);
  });
});
