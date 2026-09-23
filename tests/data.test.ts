import { describe, expect, test } from 'vitest';
import sensors from '../data/sensors.json';
import weapons from '../data/weapons.json';
import unitClasses from '../data/units.json';
import { buildCatalog } from '../src/state/load.js';
import { createInitialState } from '../src/events/engine.js';
import { ddg, miniCtx } from './helpers.js';

const clone = <T>(x: T): T => structuredClone(x);

describe('catalog validation', () => {
  test('shipped data is valid', () => {
    expect(() => buildCatalog({ sensors, weapons, unitClasses })).not.toThrow();
  });

  test.each([
    ['duplicate id', () => ({ sensors: [...sensors, sensors[0]], weapons, unitClasses }), /duplicate sensor/],
    ['bad sensor quality', () => ({ sensors: [{ ...sensors[0], maxQuality: 'GOOD' }], weapons, unitClasses }), /maxQuality/],
    ['bad weapon quality', () => ({ sensors, weapons: [{ ...weapons[0], requiredQuality: 'X' }], unitClasses }), /requiredQuality/],
    ['unknown sensor on class', () => ({ sensors: sensors.slice(1), weapons, unitClasses }), /unknown sensor/],
    ['unknown weapon on mount', () => ({ sensors, weapons: weapons.slice(1), unitClasses }), /unknown weapon/],
    [
      'turret resource not declared',
      () => {
        const c = clone(unitClasses);
        c[0]!.resources = c[0]!.resources.filter((r) => r.id !== 'ciws_stbd');
        return { sensors, weapons, unitClasses: c };
      },
      /not declared/,
    ],
  ])('%s is rejected', (_name, raw, err) => {
    expect(() => buildCatalog(raw() as never)).toThrow(err);
  });

  test.each([
    ['zero acceleration', () => ({ unitClasses: [{ ...unitClasses[0], maxAccelMps2: 0 }] }), /maxAccelMps2/],
    ['zero sensor reoffer time', () => ({ sensors: [{ ...sensors[0], reofferIntervalS: 0 }] }), /reofferIntervalS/],
    ['zero weapon speed', () => ({ weapons: [{ ...weapons[0], speedMps: 0 }] }), /speedMps/],
    ['invalid outcome bounds', () => ({ weapons: [{ ...weapons[0], terminalBounds: [0.8, 1.2] }] }), /terminalBounds/],
    ['fractional mount capacity', () => ({ unitClasses: [{ ...unitClasses[0], mounts: [{ ...unitClasses[0]!.mounts[0], capacity: 1.5 }] }] }), /capacity/],
  ])('%s is rejected', (_name, changed, err) => {
    expect(() => buildCatalog({ sensors, weapons, unitClasses, ...changed() } as never)).toThrow(err);
  });
});

describe('scenario validation', () => {
  test.each([
    ['unknown class', ddg('b1', 'blue', [0, 0, 0], { classId: 'frigate' }), /unknown class/],
    ['unknown side', ddg('b1', 'green', [0, 0, 0]), /unknown side/],
    ['over capacity', ddg('b1', 'blue', [0, 0, 0], { loadout: { vls: { 'sam-std': 60, 'asm-x': 10 } } }), /exceeds capacity/],
    ['weapon not allowed on mount', ddg('b1', 'blue', [0, 0, 0], { loadout: { vls: { 'rail-slug': 4 } } }), /cannot carry/],
    ['unknown mount', ddg('b1', 'blue', [0, 0, 0], { loadout: { torpedo: { 'asm-x': 1 } } }), /no mount/],
  ])('%s', (_n, unit, err) => {
    expect(() => createInitialState(miniCtx([unit]))).toThrow(err);
  });

  test('heading from initial velocity when no heading is given', () => {
    const s = createInitialState(miniCtx([ddg('b1', 'blue', [0, 0, 0], { velocity: [0, 10, 0] })]));
    const q = s.units['b1']!.attitude.q0;
    // 90° about +Z
    expect(q[2]).toBeCloseTo(Math.sin(Math.PI / 4));
    expect(q[3]).toBeCloseTo(Math.cos(Math.PI / 4));
  });

  test.each([
    ['zero signal speed', { signalSpeedMps: 0 }, /signalSpeedMps/],
    ['negative datalink latency', { datalinks: [{ id: 'L', name: 'L', side: 'blue', members: ['b1'], latencyS: -1 }] }, /latencyS/],
    ['zero plane normal', { referencePlanes: [{ id: 'sea', name: 'sea', origin: [0, 0, 0], normal: [0, 0, 0] }] }, /normal/],
  ])('%s is rejected', (_name, extra, err) => {
    expect(() => createInitialState(miniCtx([ddg('b1', 'blue', [0, 0, 0])], extra as never))).toThrow(err);
  });

  test('negative or fractional loadout and non-finite route speed are rejected', () => {
    for (const rounds of [-1, 1.5])
      expect(() => createInitialState(miniCtx([ddg('b1', 'blue', [0, 0, 0], { loadout: { vls: { 'asm-x': rounds } } })]))).toThrow(/loadout/);
    expect(() => createInitialState(miniCtx([ddg('b1', 'blue', [0, 0, 0], {
      route: [{ position: [1000, 0, 0], speedMps: Infinity }],
    })]))).toThrow(/speedMps/);
  });
});
