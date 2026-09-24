import { describe, expect, test } from 'vitest';
import { Session } from '../src/events/session.js';
import { projectSideView } from '../src/state/view.js';
import { CHI2_95, mahalanobis2 } from '../src/core/math/stats.js';
import { RAD, sub, type Vec3 } from '../src/core/math/vec3.js';
import { trackCovarianceAt } from '../src/rules/world.js';
import { ellipsoid95, measureTrack } from '../src/rules/tracks.js';
import { positionAt } from '../src/rules/kinematics.js';
import type { Command } from '../src/events/types.js';
import type { Scenario } from '../src/state/defs.js';
import type { Track } from '../src/state/types.js';
import { catalog, ddg, detectAll, miniCtx, must, pending, truthClassification } from './helpers.js';

/** Blue radar/ESM ship at the origin, red ship 100 km east steaming north at 10 m/s. */
function scene(blueSensors = ['mfr'], extra: Partial<Scenario> = {}, redSensors: string[] = []) {
  const ctx = miniCtx(
    [ddg('b1', 'blue', [0, 0, 0], { sensorsOn: blueSensors }), ddg('r1', 'red', [100_000, 0, 0], { sensorsOn: redSensors, velocity: [0, 10, 0] })],
    extra,
  );
  const s = new Session(ctx);
  must(s, { type: 'ADVANCE', until: 1 });
  return { ctx, s };
}

const blueOpps = (s: Session) => pending(s).filter((o) => o.kind === 'detection' && o.observerId === 'b1');
const only = (s: Session): Track => Object.values(s.state.knowledge['b1']!)[0]!;
const redPos = (s: Session): Vec3 => positionAt(s.state.units['r1']!.motion, s.state.time);

function resolve(s: Session, decision: Record<string, unknown> = {}) {
  const o = blueOpps(s)[0]!;
  must(s, { type: 'RESOLVE', opportunityId: o.id, decision: { kind: 'detection', detected: true, ...decision } } as Command);
}

describe('measurement covariance', () => {
  test('radar fix: radial σR and cross-range R·σθ, mean at truth without an offset', () => {
    const { s } = scene();
    resolve(s);
    const tr = only(s);
    expect(tr.spatial.kind).toBe('LOCALIZED');
    if (tr.spatial.kind !== 'LOCALIZED') throw new Error();
    const truth = redPos(s);
    tr.spatial.position.forEach((x, i) => expect(x).toBeCloseTo(truth[i]!, 6));
    const cross = 100_000 * 0.03 * RAD;
    // Radial axis is x here: variance σR² = 30²; cross axes R·σθ.
    expect(tr.spatial.posCov[0]).toBeCloseTo(30 ** 2, 3);
    expect(tr.spatial.posCov[4]).toBeCloseTo(cross ** 2, 3);
    expect(tr.spatial.posCov[8]).toBeCloseTo(cross ** 2, 3);
    expect(tr.observedAt).toBe(s.state.time);
    expect(tr.receivedAt).toBe(s.state.time);
  });

  test('author offset keeps its χ² inside the 95 % region as the geometry changes', () => {
    const { s } = scene();
    resolve(s, { offset: { radialM: 45, crossM: -60 } });
    const chi2At = () => {
      const tr = only(s);
      if (tr.spatial.kind !== 'LOCALIZED') throw new Error();
      return mahalanobis2(sub(tr.spatial.position, redPos(s)), tr.spatial.posCov);
    };
    const c0 = chi2At();
    const cross = 100_000 * 0.03 * RAD;
    expect(c0).toBeCloseTo((45 / 30) ** 2 + (60 / cross) ** 2, 6);
    expect(c0).toBeLessThanOrEqual(CHI2_95[3]);
    must(s, { type: 'ADVANCE', until: 600_000 });
    expect(chi2At()).toBeCloseTo(c0, 6);
  });

  test('two position sensors fuse in information form (tighter than either)', () => {
    const mfr = catalog.sensors['mfr']!;
    const uav = catalog.sensors['uav-radar']!;
    const hold = { offsetW: [0, 0, 0] };
    const target: Vec3 = [100_000, 0, 0];
    const one = measureTrack([0, 0, 0], target, [0, 0, 0], [{ sensor: uav, hold }]);
    const both = measureTrack([0, 0, 0], target, [0, 0, 0], [{ sensor: uav, hold }, { sensor: mfr, hold }]);
    if (one.kind !== 'LOCALIZED' || both.kind !== 'LOCALIZED') throw new Error();
    expect(both.posCov[0]).toBeCloseTo(1 / (1 / 100 ** 2 + 1 / 30 ** 2), 6);
    expect(both.posCov[4]).toBeLessThan(one.posCov[4]);
    // Order-independent.
    expect(measureTrack([0, 0, 0], target, [0, 0, 0], [{ sensor: mfr, hold }, { sensor: uav, hold }])).toEqual(both);
  });

  test('a bearing hold correlated onto a radar track adds no position information', () => {
    const { s } = scene(['mfr', 'esm'], {}, ['mfr']);
    const radar = blueOpps(s).find((o) => o.kind === 'detection' && o.sensorId === 'mfr')!;
    const esm = blueOpps(s).find((o) => o.kind === 'detection' && o.sensorId === 'esm')!;
    must(s, { type: 'RESOLVE', opportunityId: radar.id, decision: { kind: 'detection', detected: true } });
    const before = structuredClone(only(s).spatial);
    must(s, { type: 'RESOLVE', opportunityId: esm.id, decision: { kind: 'detection', detected: true, correlateWith: only(s).id } });
    expect(Object.keys(only(s).holds).sort()).toEqual(['esm', 'mfr']);
    expect(only(s).spatial).toEqual(before);
  });

  test('bearing-only: offset rotates the line of sight, χ² uses the angular covariance', () => {
    const { s } = scene(['esm'], {}, ['mfr']);
    resolve(s, { offset: { azDeg: 1.5 } });
    const tr = only(s);
    if (tr.spatial.kind !== 'BEARING_ONLY') throw new Error();
    // +azimuth is to the right of the line of sight (clockwise seen from above).
    const truth = redPos(s);
    const deg = (Math.atan2(truth[1], truth[0]) - Math.atan2(tr.spatial.direction[1], tr.spatial.direction[0])) / RAD;
    expect(deg).toBeCloseTo(1.5, 9);
    expect(tr.spatial.angleSigmaRad).toBeCloseTo(1 * RAD, 12);
  });

  test('extrapolated covariance grows with age: Δt²Σv + q Δt³/3', () => {
    const { ctx, s } = scene();
    resolve(s);
    const tr = only(s);
    if (tr.spatial.kind !== 'LOCALIZED') throw new Error();
    const t = tr.observedAt + 300_000;
    const cov = trackCovarianceAt(ctx, tr, t)!;
    const q = (2 ** 2 / 60) * 300 ** 3 / 3;
    expect(cov[0]).toBeCloseTo(tr.spatial.posCov[0] + 300 ** 2 * 5 ** 2 + q, 3);
    expect(ellipsoid95(cov)[0]).toBeGreaterThan(ellipsoid95(tr.spatial.posCov)[0]);
  });
});

describe('detection ruling validation', () => {
  test('existence and classification inputs are range-checked', () => {
    const { s } = scene();
    const o = blueOpps(s)[0]!;
    const R = (decision: Record<string, unknown>): Command => ({ type: 'RESOLVE', opportunityId: o.id, decision: { kind: 'detection', detected: true, ...decision } } as Command);
    expect(s.check(R({ existence: 0 })).ok).toBe(false);
    expect(s.check(R({ existence: 0.6 })).ok).toBe(true);
    expect(s.check(R({ classification: { category: 'tank', confidence: 0.5 } })).ok).toBe(false);
    expect(s.check(R({ classification: { category: 'ship', confidence: 1.2 } })).ok).toBe(false);
    expect(s.check(R({ classification: { identity: 'enemy', confidence: 0.5 } })).ok).toBe(false);
    must(s, R({ existence: 0.6, classification: { category: 'ship', confidence: 0.7 } }));
    expect(only(s).existence).toBe(0.6);
    expect(only(s).classification).toEqual({ category: 'ship', identity: 'unknown', confidence: 0.7 });
  });
});

describe('rules of engagement and target identification', () => {
  const launch = (trackId: string): Command => ({ type: 'LAUNCH', unitId: 'b1', mountId: 'vls', weaponId: 'asm-x', count: 1, trackId });
  const failing = (s: Session, cmd: Command) => JSON.stringify(s.check(cmd).checks.filter((c) => c.ok === false));

  test('weapon target category and minimum confidence', () => {
    const { s } = scene();
    resolve(s);
    const id = only(s).id;
    expect(failing(s, launch(id))).toContain('只用于 ship');
    must(s, { type: 'CLASSIFY', unitId: 'b1', trackId: id, classification: { category: 'missile', confidence: 1 } });
    expect(failing(s, launch(id))).toContain('只用于 ship');
    must(s, { type: 'CLASSIFY', unitId: 'b1', trackId: id, classification: { category: 'ship', confidence: 0.4 } });
    expect(failing(s, launch(id))).toContain('置信度 ≥ 0.5');
    must(s, { type: 'CLASSIFY', unitId: 'b1', trackId: id, classification: { category: 'ship', confidence: 0.5 } });
    expect(s.check(launch(id)).ok).toBe(true);
  });

  test('tight ROE needs a hostile identification; free ROE does not', () => {
    const { s } = scene(['mfr'], { roe: { blue: { weaponsRelease: 'tight', minHostileConfidence: 0.8 } } });
    resolve(s, { classification: { category: 'ship', identity: 'unknown', confidence: 0.9 } });
    const id = only(s).id;
    expect(failing(s, launch(id))).toContain('交战规则 tight');
    must(s, { type: 'CLASSIFY', unitId: 'b1', trackId: id, classification: { category: 'ship', identity: 'hostile', confidence: 0.7 } });
    expect(failing(s, launch(id))).toContain('交战规则 tight');
    must(s, { type: 'CLASSIFY', unitId: 'b1', trackId: id, classification: { category: 'ship', identity: 'hostile', confidence: 0.85 } });
    expect(s.check(launch(id)).ok).toBe(true);

    const free = scene();
    resolve(free.s, { classification: { category: 'ship', confidence: 0.9 } });
    expect(free.s.check(launch(only(free.s).id)).ok).toBe(true);
  });

  test('scenario ROE entries are validated', () => {
    expect(() => scene(['mfr'], { roe: { green: { weaponsRelease: 'free' } } })).toThrow(/unknown side/);
    expect(() => scene(['mfr'], { roe: { blue: { weaponsRelease: 'hold' as never } } })).toThrow(/weaponsRelease/);
  });

  test('CLASSIFY records a side-visible event, can clear, and refuses unknown tracks', () => {
    const { s } = scene();
    resolve(s, { classification: { category: 'ship', confidence: 0.9 } });
    const id = only(s).id;
    expect(s.check({ type: 'CLASSIFY', unitId: 'b1', trackId: 'blue-T99', classification: null }).ok).toBe(false);
    const r = must(s, { type: 'CLASSIFY', unitId: 'b1', trackId: id, classification: null, note: '重新评估' });
    expect(r.events[0]!.kind).toBe('TRACK_CLASSIFIED');
    expect(r.events[0]!.sides['blue']).toBeDefined();
    expect(r.events[0]!.sides['red']).toBeUndefined();
    expect(only(s).classification).toBeNull();
    expect(only(s).provenance).toContain(r.events[0]!.id);
  });

  test('capture probability is advisory only', () => {
    const { s } = scene();
    resolve(s, { classification: { category: 'ship', confidence: 1 } });
    const v = s.check(launch(only(s).id));
    expect(v.ok).toBe(true);
    const hint = v.checks.find((c) => c.label.startsWith('（提示）'))!;
    expect(hint.ok).toBeUndefined();
    expect(hint.label).toMatch(/概率 ≈/);
  });
});

describe('interceptor guidance needs a held track', () => {
  test('ENGAGE is refused once the own sensor stops holding the missile track', () => {
    const ctx = miniCtx([ddg('b1', 'blue', [0, 0, 0], { headingDeg: 90 }), ddg('r1', 'red', [100_000, 0, 0], { headingDeg: 180 })]);
    const s = new Session(ctx);
    must(s, { type: 'ADVANCE', until: 1 });
    detectAll(s);
    const redTrack = Object.keys(s.state.knowledge['r1']!)[0]!;
    must(s, { type: 'LAUNCH', unitId: 'r1', mountId: 'vls', weaponId: 'asm-x', count: 4, trackId: redTrack });
    must(s, { type: 'ADVANCE' });
    const o = pending(s).find((x) => x.kind === 'detection' && x.observerId === 'b1')!;
    if (o.kind !== 'detection') throw new Error();
    must(s, { type: 'RESOLVE', opportunityId: o.id, decision: { kind: 'detection', detected: true, classification: truthClassification(s, o.target) } });
    const mt = Object.values(s.state.knowledge['b1']!).find((t) => s.state.truth.trackTargets[t.id] === 'red-MG1')!.id;
    const engage: Command = { type: 'ENGAGE', unitId: 'b1', mountId: 'vls', weaponId: 'sam-std', trackId: mt };
    expect(s.check(engage).ok).toBe(true);
    must(s, { type: 'SET_SENSOR', unitId: 'b1', sensorId: 'mfr', on: false });
    const v = s.check(engage);
    expect(v.ok).toBe(false);
    expect(JSON.stringify(v.checks)).toContain('持续跟踪');
  });
});

describe('side view', () => {
  test('track holds are listed by sensor without the author offset; σ is reported', () => {
    const { ctx, s } = scene();
    resolve(s, { offset: { radialM: 45 } });
    const tv = projectSideView(ctx, s.state, 'blue').tracks['b1']![0]!;
    expect(tv.holds).toEqual(['mfr']);
    expect(JSON.stringify(tv)).not.toContain('offsetW');
    expect(tv.sigma95NowM).not.toBeNull();
  });
});
