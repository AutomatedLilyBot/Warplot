import { describe, expect, test } from 'vitest';
import { fromPlaneCoords, niceStep, planeCoords, planeFrame, toRender, toWorld } from '../src/renderer/frame.js';
import { dot, length } from '../src/core/math/vec3.js';

describe('render frame', () => {
  test('floating origin keeps render coordinates small for huge world coordinates', () => {
    const origin: [number, number, number] = [1.496e11, 2e9, 1e7]; // ~1 AU away
    const p: [number, number, number] = [1.496e11 + 12_345, 2e9 - 500, 1e7 + 7];
    const r = toRender(p, origin);
    expect(r[0]).toBeCloseTo(12.345, 6);
    expect(Math.max(...r.map(Math.abs))).toBeLessThan(100);
    const back = toWorld(r, origin);
    expect(back[0]).toBeCloseTo(p[0], 3);
  });

  test('plane frame is orthonormal and round-trips', () => {
    const f = planeFrame([10, 20, 30], [0.2, -0.4, 1]);
    expect(length(f.u)).toBeCloseTo(1);
    expect(length(f.v)).toBeCloseTo(1);
    expect(dot(f.u, f.v)).toBeCloseTo(0);
    expect(dot(f.u, f.normal)).toBeCloseTo(0);
    const p = fromPlaneCoords(f, 3, -4, 5);
    const [a, b, h] = planeCoords(f, p);
    expect([a, b, h].map((x) => Math.round(x * 1e9) / 1e9)).toEqual([3, -4, 5]);
    // sea-level plane: u = east, v = north
    const sea = planeFrame([0, 0, 0], [0, 0, 1]);
    expect(sea.u).toEqual([1, 0, 0]);
    expect(sea.v.map((x) => Math.round(x))).toEqual([0, 1, 0]);
  });

  test('nice grid steps', () => {
    expect(niceStep(400)).toBe(50);
    expect(niceStep(100)).toBe(10);
    expect(niceStep(30)).toBe(2);
  });
});
