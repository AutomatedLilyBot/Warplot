import { describe, expect, test } from 'vitest';
import { Session } from '../src/events/session.js';
import { exportLog } from '../src/events/export.js';
import { projectGodView } from '../src/state/view.js';
import { chronicle } from '../src/events/chronicle.js';
import { planRoute, positionAt, velocityAt } from '../src/rules/kinematics.js';
import { catalog, ddg, detectAll, miniCtx, must, pending } from './helpers.js';
import { quatAngleDeg, quatFromAxisAngle, quatFromTo, rotate, slerp, IDENTITY } from '../src/core/math/quat.js';
import { heightAbovePlane, projectOntoPlane } from '../src/core/math/geometry.js';
import { distance } from '../src/core/math/vec3.js';
import { formatClock, parseClock } from '../src/core/time.js';
import type { UnitSetup } from '../src/state/defs.js';

const cls = catalog.unitClasses['ddg']!;

describe('kinematics braking branches', () => {
  test('arriving too fast: cruise at current speed, then brake at max decel onto the waypoint', () => {
    const plan = planRoute(0, [0, 0, 0], 16, [1, 0, 0], [{ position: [1000, 0, 0], speedMps: 5 }], cls);
    expect(distance(positionAt(plan, plan.arrivesAt!), [1000, 0, 0])).toBeLessThan(0.01);
    expect(Math.hypot(...velocityAt(plan, plan.arrivesAt! - 1))).toBeLessThan(0.01);
  });

  test('too short to stop at max decel: brakes harder and still stops on the waypoint', () => {
    const plan = planRoute(0, [0, 0, 0], 16, [1, 0, 0], [{ position: [100, 0, 0] }], cls);
    // 100 m at 16 m/s → a = 1.28 m/s², t = 12.5 s
    expect(plan.arrivesAt).toBe(12_500);
    expect(distance(positionAt(plan, plan.arrivesAt!), [100, 0, 0])).toBeLessThan(0.01);
  });

  test('short leg from rest: triangular profile, never reaches cruise speed', () => {
    const plan = planRoute(0, [0, 0, 0], 0, [1, 0, 0], [{ position: [200, 0, 0] }], cls);
    const peak = Math.max(...plan.segments.map((s) => s.v0));
    expect(peak).toBeCloseTo(Math.sqrt(0.3 * 200), 6);
    expect(distance(positionAt(plan, plan.arrivesAt!), [200, 0, 0])).toBeLessThan(0.01);
  });

  test('empty route = brake to a stop along the current heading', () => {
    const ctx = miniCtx([ddg('b1', 'blue', [0, 0, 0], { velocity: [12, 0, 0], sensorsOn: [] })]);
    const s = new Session(ctx);
    must(s, { type: 'SET_ROUTE', unitId: 'b1', waypoints: [] });
    must(s, { type: 'ADVANCE', until: 60_000 });
    const m = s.state.units['b1']!.motion;
    expect(velocityAt(m, 60_000)).toEqual([0, 0, 0]);
    expect(positionAt(m, 60_000)[0]).toBeCloseTo((12 * 12) / (2 * 0.3), 3);
  });
});

describe('datalink failures', () => {
  const uav = (id: string, position: [number, number, number]): UnitSetup => ({ id, name: id, side: 'blue', classId: 'uav', position, sensorsOn: ['uav-radar'], loadout: {} });
  function scene(maxRangeM?: number) {
    const ctx = miniCtx([ddg('b1', 'blue', [0, 0, 0], { sensorsOn: [] }), uav('bu', [150_000, 0, 5000]), ddg('r1', 'red', [200_000, 0, 0], { sensorsOn: [] })], {
      datalinks: [{ id: 'L', name: 'L', side: 'blue', members: ['b1', 'bu'], latencyS: 1, ...(maxRangeM ? { maxRangeM } : {}) }],
    });
    const s = new Session(ctx);
    must(s, { type: 'ADVANCE' });
    detectAll(s);
    return s;
  }
  const fails = (s: Session, cmd: Parameters<Session['check']>[0]) => JSON.stringify(s.check(cmd).checks.filter((c) => c.ok === false));

  test('beyond link range', () => {
    expect(fails(scene(100_000), { type: 'TRANSMIT', linkId: 'L', from: 'bu', to: 'b1', trackId: 'blue-T1' })).toContain('链路距离');
  });
  test('unknown link, same unit, track not held by sender', () => {
    const s = scene();
    expect(fails(s, { type: 'TRANSMIT', linkId: 'X', from: 'bu', to: 'b1', trackId: 'blue-T1' })).toContain('数据链 X 存在');
    expect(fails(s, { type: 'TRANSMIT', linkId: 'L', from: 'bu', to: 'bu', trackId: 'blue-T1' })).toContain('收发方不同');
    expect(fails(s, { type: 'TRANSMIT', linkId: 'L', from: 'b1', to: 'bu', trackId: 'blue-T1' })).toContain('发送方掌握航迹');
  });
  test('a stale delivery does not overwrite fresher local data', () => {
    const s = scene();
    must(s, { type: 'TRANSMIT', linkId: 'L', from: 'bu', to: 'b1', trackId: 'blue-T1' });
    must(s, { type: 'TRANSMIT', linkId: 'L', from: 'bu', to: 'b1', trackId: 'blue-T1' });
    must(s, { type: 'ADVANCE', until: 5000 });
    const deliveries = s.state.log.filter((e) => e.kind === 'DELIVERY');
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]!.truth.summary).toContain('忽略');
  });
});

describe('unit status', () => {
  test('a destroyed unit goes dark, cannot act, and enemy holds on it drop', () => {
    const ctx = miniCtx([ddg('b1', 'blue', [0, 0, 0]), ddg('r1', 'red', [100_000, 0, 0])]);
    const s = new Session(ctx);
    must(s, { type: 'ADVANCE' });
    detectAll(s);
    must(s, { type: 'SET_UNIT_STATUS', unitId: 'r1', status: 'destroyed', note: '弹药库殉爆' });
    const r1 = s.state.units['r1']!;
    expect(Object.values(r1.sensorsOn).every((on) => !on)).toBe(true);
    expect(s.check({ type: 'SET_ROUTE', unitId: 'r1', waypoints: [] }).ok).toBe(false);
    expect(s.check({ type: 'SET_SENSOR', unitId: 'r1', sensorId: 'mfr', on: true }).ok).toBe(false);
    must(s, { type: 'ADVANCE', stopAtNotable: true });
    expect(s.state.log.some((e) => e.kind === 'TRACK_LOST' && e.truth.target === 'blue-T1')).toBe(true);
    expect(s.state.knowledge['b1']!['blue-T1']!.holds).toEqual({});
  });

  test('a salvo arriving at a destroyed target misses mechanically', () => {
    const ctx = miniCtx([ddg('b1', 'blue', [0, 0, 0]), ddg('r1', 'red', [100_000, 0, 0], { sensorsOn: [] })]);
    const s = new Session(ctx);
    must(s, { type: 'ADVANCE' });
    detectAll(s);
    must(s, { type: 'LAUNCH', unitId: 'b1', mountId: 'vls', weaponId: 'asm-x', count: 2, trackId: 'blue-T1' });
    must(s, { type: 'SET_UNIT_STATUS', unitId: 'r1', status: 'destroyed' });
    must(s, { type: 'ADVANCE' });
    expect(pending(s)).toHaveLength(0);
    expect(s.state.groups['blue-MG1']!.misses).toBe(2);
  });
});

describe('bearing-only knowledge', () => {
  test('ESM track has only a bearing and cannot cue a missile', () => {
    const ctx = miniCtx([ddg('b1', 'blue', [0, 0, 0], { sensorsOn: ['esm'] }), ddg('r1', 'red', [100_000, 100_000, 0])]);
    const s = new Session(ctx);
    must(s, { type: 'ADVANCE' });
    const o = pending(s).find((x) => x.kind === 'detection' && x.observerId === 'b1')!;
    must(s, { type: 'RESOLVE', opportunityId: o.id, decision: { kind: 'detection', detected: true, classification: { category: 'ship', identity: 'hostile', confidence: 1 } } });
    const tr = s.state.knowledge['b1']!['blue-T1']!;
    expect(tr.spatial.kind).toBe('BEARING_ONLY');
    if (tr.spatial.kind !== 'BEARING_ONLY') throw new Error();
    expect(tr.spatial.direction[0]).toBeCloseTo(Math.SQRT1_2);
    const v = s.check({ type: 'LAUNCH', unitId: 'b1', mountId: 'vls', weaponId: 'asm-x', count: 1, trackId: 'blue-T1' });
    expect(JSON.stringify(v.checks.filter((c) => c.ok === false))).toContain('定位航迹');
  });
});

describe('export and god view', () => {
  test('god export has commands + truth events; side export has only side events', () => {
    const ctx = miniCtx([ddg('b1', 'blue', [0, 0, 0]), ddg('r1', 'red', [100_000, 0, 0])]);
    const s = new Session(ctx);
    must(s, { type: 'ADVANCE' });
    detectAll(s);
    const god = JSON.parse(exportLog(ctx, s));
    expect(god.view).toBe('god');
    expect(god.commands.length).toBe(3);
    expect(god.events.some((e: { kind: string }) => e.kind === 'DETECTION_OPPORTUNITY')).toBe(true);
    const blue = JSON.parse(exportLog(ctx, s, 'blue'));
    expect(blue.commands).toBeUndefined();
    expect(blue.events.every((e: { id: string }) => e.id.startsWith('blue-E'))).toBe(true);
    const gv = projectGodView(ctx, s.state);
    expect(gv.units.map((u) => u.id)).toEqual(['b1', 'r1']);
    expect(gv.truth.trackTargets['blue-T1']).toBe('r1');
    expect(chronicle(ctx, s.state, 'blue')).not.toContain('r1');
  });
});

describe('math helpers', () => {
  test('quaternions', () => {
    const q = quatFromTo([1, 0, 0], [-1, 0, 0]); // antiparallel
    expect(distance(rotate(q, [1, 0, 0]), [-1, 0, 0])).toBeLessThan(1e-9);
    const a = quatFromAxisAngle([0, 0, 1], 10);
    const b = quatFromAxisAngle([0, 0, 1], 10.0001); // nearly equal → lerp path
    expect(quatAngleDeg(slerp(a, b, 0.5), a)).toBeLessThan(0.001);
    const c = quatFromAxisAngle([0, 0, 1], 90);
    expect(quatAngleDeg(slerp(IDENTITY, c, 0.5), IDENTITY)).toBeCloseTo(45, 6);
    expect(quatAngleDeg(slerp(IDENTITY, [-c[0], -c[1], -c[2], -c[3]], 0.5), IDENTITY)).toBeCloseTo(45, 6);
  });

  test('reference plane projection (for the height-stalk display)', () => {
    const origin: [number, number, number] = [0, 0, 100];
    const normal: [number, number, number] = [0, 0, 2];
    expect(heightAbovePlane([5, 5, 350], origin, normal)).toBeCloseTo(250);
    expect(projectOntoPlane([5, 5, 350], origin, normal)).toEqual([5, 5, 100]);
  });

  test('clock formatting', () => {
    expect(formatClock(1500, parseClock('23:59:59'))).toBe('00:00:00.500');
    expect(parseClock('07:52:10')).toBe(7 * 3600 + 52 * 60 + 10);
  });
});
