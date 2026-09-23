import { describe, expect, test } from 'vitest';
import { Session } from '../src/events/session.js';
import { ddg, detectAll, miniCtx, must, pending } from './helpers.js';

/** Blue DDG at the origin, red DDG 100 km east, both stationary with radars on. */
function duel(distanceM = 100_000) {
  const ctx = miniCtx([ddg('b1', 'blue', [0, 0, 0]), ddg('r1', 'red', [distanceM, 0, 0], { headingDeg: 180 })]);
  const s = new Session(ctx);
  must(s, { type: 'ADVANCE', until: 1000 });
  detectAll(s);
  return { ctx, s };
}

describe('missile group flight', () => {
  test('flight time = distance / speed, impact is surfaced at arrival time', () => {
    const { s } = duel();
    const r = must(s, { type: 'LAUNCH', unitId: 'b1', mountId: 'vls', weaponId: 'asm-x', count: 4, trackId: 'blue-T1' });
    const g = s.state.groups['blue-MG1']!;
    expect(g.launchTime).toBe(0);
    expect(g.arrivalTime).toBe(Math.ceil((100_000 / 290) * 1000));
    expect(r.events[0]!.kind).toBe('LAUNCH');

    must(s, { type: 'ADVANCE', until: 3_600_000 });
    // Red's radar can see the inbound group, so its detection chance comes first.
    while (pending(s).some((o) => o.kind === 'detection')) {
      for (const o of pending(s))
        if (o.kind === 'detection') must(s, { type: 'RESOLVE', opportunityId: o.id, decision: { kind: 'detection', detected: false, reason: 'clutter' } });
      must(s, { type: 'ADVANCE', until: 3_600_000 });
    }
    const imp = pending(s)[0]!;
    expect(imp.kind).toBe('impact');
    expect(s.state.time).toBe(g.arrivalTime);
    if (imp.kind !== 'impact') throw new Error();
    expect(imp.bounds).toEqual({ min: 0, max: 4 });

    must(s, { type: 'RESOLVE', opportunityId: imp.id, decision: { kind: 'impact', hits: 2 } });
    expect(s.state.units['r1']!.hitsTaken).toBe(2);
    expect(s.state.groups['blue-MG1']!.status).toBe('expended');
    expect(s.state.groups['blue-MG1']!.misses).toBe(2);
  });

  test('target reverses course after launch → outside seeker basket → mechanical miss, no author prompt', () => {
    const ctx = miniCtx([
      ddg('b1', 'blue', [0, 0, 0]),
      ddg('r1', 'red', [140_000, 0, 0], { sensorsOn: [], velocity: [0, 16, 0] }),
    ]);
    const s = new Session(ctx);
    must(s, { type: 'ADVANCE', until: 1000 });
    detectAll(s);
    must(s, { type: 'SET_SENSOR', unitId: 'b1', sensorId: 'mfr', on: false }); // stop refreshing the track
    must(s, { type: 'LAUNCH', unitId: 'b1', mountId: 'vls', weaponId: 'asm-x', count: 2, trackId: 'blue-T1' });
    must(s, { type: 'SET_ROUTE', unitId: 'r1', waypoints: [{ position: [140_000, -80_000, 0] }] });
    must(s, { type: 'ADVANCE', until: 3_600_000 });

    const g = s.state.groups['blue-MG1']!;
    const opp = Object.values(s.state.opportunities).find((o) => o.kind === 'impact')!;
    expect(opp.status).toBe('resolved');
    expect(opp.kind === 'impact' && opp.bounds).toEqual({ min: 0, max: 0 });
    expect(g.hits).toBe(0);
    expect(g.misses).toBe(2);
    expect(JSON.stringify(opp.explanation)).toContain('导引头捕获范围');
  });
});

export { duel };
