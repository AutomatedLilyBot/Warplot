import { describe, expect, test } from 'vitest';
import { planRoute, positionAt, velocityAt } from '../src/rules/kinematics.js';
import { catalog } from './helpers.js';
import { distance } from '../src/core/math/vec3.js';

const ddg = catalog.unitClasses['ddg']!;

describe('kinematics', () => {
  test('from rest: accelerate, cruise, brake to stop exactly at the final waypoint', () => {
    const plan = planRoute(0, [0, 0, 0], 0, [1, 0, 0], [{ position: [10000, 0, 0] }], ddg);
    // a=0.3, v=16: accel/brake 53.33 s & 426.67 m each; cruise 9146.67 m / 16 = 571.67 s
    const expected = 2 * (16 / 0.3) + (10000 - 2 * (256 / 0.6)) / 16;
    expect(plan.arrivesAt! / 1000).toBeCloseTo(expected, 2);
    expect(distance(positionAt(plan, plan.arrivesAt!), [10000, 0, 0])).toBeLessThan(0.01);
    expect(velocityAt(plan, plan.arrivesAt! + 1000)).toEqual([0, 0, 0]);
  });

  test('never exceeds class max speed even if the waypoint asks for more', () => {
    const plan = planRoute(0, [0, 0, 0], 0, [1, 0, 0], [{ position: [50000, 0, 0], speedMps: 100 }], ddg);
    for (let t = 0; t < plan.arrivesAt!; t += 5000) {
      const v = velocityAt(plan, t);
      expect(Math.hypot(...v)).toBeLessThanOrEqual(16 + 1e-9);
    }
  });

  test('multi-leg route passes through intermediate waypoints', () => {
    const wps = [{ position: [5000, 0, 0] as [number, number, number] }, { position: [5000, 5000, 0] as [number, number, number] }];
    const plan = planRoute(0, [0, 0, 0], 16, [1, 0, 0], wps, ddg);
    const hitsCorner = plan.segments.some((s) => distance(s.p0, [5000, 0, 0]) < 0.01);
    expect(hitsCorner).toBe(true);
    expect(distance(positionAt(plan, plan.arrivesAt!), [5000, 5000, 0])).toBeLessThan(0.01);
  });
});
