import { describe, expect, test } from 'vitest';
import { Session } from '../src/events/session.js';
import { projectSideView } from '../src/state/view.js';
import { exportLog } from '../src/events/export.js';
import { demoCtx, ddg, detectAll, miniCtx, must, pending } from './helpers.js';
import type { Ctx } from '../src/rules/world.js';

/** Every string that would reveal the other side's truth. */
function secretsOf(ctx: Ctx, s: Session, side: string): string[] {
  const out: string[] = [];
  for (const u of ctx.scenario.units) if (u.side !== side) out.push(u.id, u.name);
  for (const g of Object.values(s.state.groups)) if (g.side !== side) out.push(g.id);
  return out;
}

function assertNoLeak(ctx: Ctx, s: Session, side: string) {
  const json = JSON.stringify(projectSideView(ctx, s.state, side));
  for (const secret of secretsOf(ctx, s, side)) expect(json, `leaked "${secret}"`).not.toContain(secret);
  expect(json).not.toContain('trackTargets');
  expect(json).not.toContain('OPP'); // opportunities are author-level only
  const exported = exportLog(ctx, s, side);
  for (const secret of secretsOf(ctx, s, side)) expect(exported).not.toContain(secret);
}

describe('side views do not leak truth', () => {
  test('before any detection the blue view contains no red identity or position', () => {
    const ctx = demoCtx();
    const s = new Session(ctx);
    assertNoLeak(ctx, s, 'blue');
    assertNoLeak(ctx, s, 'red');
    const blue = projectSideView(ctx, s.state, 'blue');
    expect(Object.values(blue.tracks).flat()).toHaveLength(0);
    expect(JSON.stringify(blue)).not.toContain('260000');
  });

  test('pending detection chances are invisible to the side', () => {
    const ctx = demoCtx();
    const s = new Session(ctx);
    must(s, { type: 'ADVANCE' });
    expect(pending(s).length).toBeGreaterThan(0);
    assertNoLeak(ctx, s, 'blue');
    const blue = projectSideView(ctx, s.state, 'blue');
    expect(Object.values(blue.tracks).flat()).toHaveLength(0);
  });

  test('after detections, launches, intercepts: still only side-local identifiers', () => {
    const ctx = miniCtx([ddg('b1', 'blue', [0, 0, 0], { headingDeg: 90 }), ddg('r1', 'red', [100_000, 0, 0], { headingDeg: 180 })]);
    const s = new Session(ctx);
    must(s, { type: 'ADVANCE', until: 1 });
    detectAll(s);
    const redTrack = Object.keys(s.state.knowledge['r1']!)[0]!;
    must(s, { type: 'LAUNCH', unitId: 'r1', mountId: 'vls', weaponId: 'asm-x', count: 6, trackId: redTrack });
    must(s, { type: 'ADVANCE' });
    detectAll(s);
    const mt = Object.keys(s.state.knowledge['b1']!).find((id) => s.state.truth.trackTargets[id] === 'red-MG1')!;
    must(s, { type: 'ENGAGE', unitId: 'b1', mountId: 'vls', weaponId: 'sam-std', trackId: mt });
    must(s, { type: 'ADVANCE' });
    const io = pending(s)[0]!;
    must(s, { type: 'RESOLVE', opportunityId: io.id, decision: { kind: 'intercept', intercepted: 3 } });

    assertNoLeak(ctx, s, 'blue');
    assertNoLeak(ctx, s, 'red');

    const red = projectSideView(ctx, s.state, 'red');
    // Red knows it fired 6, not that 3 were shot down.
    expect(red.groups[0]!.count).toBe(6);
    expect(JSON.stringify(red.events)).not.toContain('拦截');
    // Event ids are renumbered per side so gaps don't reveal hidden events.
    expect(red.events.map((e) => e.id)).toEqual(red.events.map((_, i) => `red-E${i + 1}`));
  });
});

describe('a salvo wiped out by interception', () => {
  test('its owner still sees it flying until the planned arrival, and gets no expended event', () => {
    const ctx = miniCtx([ddg('b1', 'blue', [0, 0, 0], { headingDeg: 90 }), ddg('r1', 'red', [100_000, 0, 0], { headingDeg: 180 })]);
    const s = new Session(ctx);
    must(s, { type: 'ADVANCE', until: 1 });
    detectAll(s);
    must(s, { type: 'LAUNCH', unitId: 'r1', mountId: 'vls', weaponId: 'asm-x', count: 2, trackId: 'red-T1' });
    must(s, { type: 'ADVANCE' });
    detectAll(s);
    const mt = Object.keys(s.state.knowledge['b1']!).find((id) => s.state.truth.trackTargets[id] === 'red-MG1')!;
    // Two layers: SAM takes one, CIWS takes the last one.
    must(s, { type: 'ENGAGE', unitId: 'b1', mountId: 'vls', weaponId: 'sam-std', trackId: mt });
    must(s, { type: 'ENGAGE', unitId: 'b1', mountId: 'ciws', weaponId: 'ciws-burst', trackId: mt });
    for (let i = 0; i < 2; i++) {
      must(s, { type: 'ADVANCE' });
      const io = pending(s)[0]!;
      if (io.kind !== 'intercept') throw new Error(io.kind);
      must(s, { type: 'RESOLVE', opportunityId: io.id, decision: { kind: 'intercept', intercepted: io.bounds.max } });
    }
    expect(s.state.groups['red-MG1']!.status).toBe('expended');
    expect(s.state.time).toBeLessThan(s.state.groups['red-MG1']!.arrivalTime);
    const red = projectSideView(ctx, s.state, 'red');
    expect(red.groups[0]!.status).toBe('flying');
    expect(red.events.some((e) => e.kind === 'GROUP_EXPENDED')).toBe(false);
  });
});
