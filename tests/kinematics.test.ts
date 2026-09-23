import { describe, expect, test } from 'vitest';
import { planRoute, positionAt, velocityAt } from '../src/rules/kinematics.js';
import { catalog, ddg as setupDdg, miniCtx, must } from './helpers.js';
import { distance } from '../src/core/math/vec3.js';
import { Session } from '../src/events/session.js';

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

  test('zero-speed intermediate waypoint stops before departing for the next leg', () => {
    const waypoints = [
      { position: [1000, 0, 0] as [number, number, number], speedMps: 0 },
      { position: [2000, 0, 0] as [number, number, number] },
    ];
    const plan = planRoute(0, [0, 0, 0], 0, [1, 0, 0], waypoints, ddg);
    expect(Number.isFinite(plan.arrivesAt)).toBe(true);
    expect(plan.segments.every((s) => Number.isFinite(s.t0) && (s.t1 === null || Number.isFinite(s.t1)))).toBe(true);
    const departure = plan.segments.find((s) => distance(s.p0, [1000, 0, 0]) < 0.01)!;
    expect(distance(positionAt(plan, departure.t0), [1000, 0, 0])).toBeLessThan(0.01);
    expect(velocityAt(plan, departure.t0)).toEqual([0, 0, 0]);
    expect(positionAt(plan, departure.t0 + 1000)[0]).toBeGreaterThan(1000);
    expect(distance(positionAt(plan, plan.arrivesAt!), [2000, 0, 0])).toBeLessThan(0.01);

    const session = new Session(miniCtx([setupDdg('b1', 'blue', [0, 0, 0], { sensorsOn: [] })]));
    must(session, { type: 'SET_ROUTE', unitId: 'b1', waypoints });
    const arrival = session.state.units['b1']!.motion.arrivesAt!;
    expect(Number.isFinite(arrival)).toBe(true);
    must(session, { type: 'ADVANCE', until: arrival });
    expect(session.state.time).toBe(arrival);
    expect(session.state.log.some((e) => e.kind === 'ROUTE_COMPLETE')).toBe(true);
  });

  test('zero-speed final waypoint still has a finite arrival time', () => {
    const plan = planRoute(0, [0, 0, 0], 0, [1, 0, 0], [{ position: [1000, 0, 0], speedMps: 0 }], ddg);
    expect(Number.isFinite(plan.arrivesAt)).toBe(true);
    expect(distance(positionAt(plan, plan.arrivesAt!), [1000, 0, 0])).toBeLessThan(0.01);
    expect(velocityAt(plan, plan.arrivesAt!)).toEqual([0, 0, 0]);
  });
});
