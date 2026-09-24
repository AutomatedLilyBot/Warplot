import { describe, expect, test } from 'vitest';
import { Session } from '../src/events/session.js';
import { buildMapModel, unitTrail } from '../src/ui/mapModel.js';
import { length } from '../src/core/math/vec3.js';
import { ellipsoid95 } from '../src/rules/tracks.js';
import { trackCovarianceAt } from '../src/rules/world.js';
import { trackNumber, groupLabel } from '../src/ui/labels.js';
import { demoCtx, ddg, detectAll, miniCtx, must, pending } from './helpers.js';
import type { Ctx } from '../src/rules/world.js';
import { groupPosition } from '../src/rules/world.js';
import { positionAt } from '../src/rules/kinematics.js';
import { timelineMarks } from '../src/ui/timelineMarks.js';

const history = (s: Session) => [s.stateAt(null), ...s.path(s.branch.head).map((n) => s.stateAt(n.id))];

function secrets(ctx: Ctx, s: Session, side: string): string[] {
  const out: string[] = [];
  for (const u of ctx.scenario.units) if (u.side !== side) out.push(u.id, u.name);
  for (const g of Object.values(s.state.groups)) if (g.side !== side) out.push(g.id, groupLabel(g.id));
  return out;
}

describe('map model', () => {
  test('side model contains only own units and own tracks; no enemy identity or position', () => {
    const ctx = demoCtx();
    const s = new Session(ctx);
    must(s, { type: 'ADVANCE' });
    detectAll(s); // ESM bearings only
    const m = buildMapModel(ctx, history(s), 'blue');
    const json = JSON.stringify(m);
    for (const x of secrets(ctx, s, 'blue')) expect(json).not.toContain(x);
    expect(json).not.toContain('260000'); // red ship x coordinate
    expect(m.entities.filter((e) => e.kind === 'unit').every((e) => e.tone === 'blue')).toBe(true);
    const tracks = m.entities.filter((e) => e.kind === 'track');
    expect(tracks.length).toBeGreaterThan(0);
    expect(tracks.every((t) => t.position === null && t.bearing)).toBe(true); // bearing-only: no position
    expect(tracks.map((t) => t.label)).toContain('7001');
  });

  test('launching side sees its salvo at full count even after interceptions', () => {
    const ctx = miniCtx([ddg('b1', 'blue', [0, 0, 0]), ddg('r1', 'red', [100_000, 0, 0], { headingDeg: 180 })]);
    const s = new Session(ctx);
    must(s, { type: 'ADVANCE', until: 1 });
    detectAll(s);
    must(s, { type: 'LAUNCH', unitId: 'r1', mountId: 'vls', weaponId: 'asm-x', count: 8, trackId: 'red-T1' });
    must(s, { type: 'ADVANCE' });
    detectAll(s);
    const mt = Object.keys(s.state.knowledge['b1']!).find((id) => s.state.truth.trackTargets[id] === 'red-MG1')!;
    must(s, { type: 'ENGAGE', unitId: 'b1', mountId: 'vls', weaponId: 'sam-std', trackId: mt });
    must(s, { type: 'ADVANCE' });
    const o = pending(s)[0]!;
    must(s, { type: 'RESOLVE', opportunityId: o.id, decision: { kind: 'intercept', intercepted: 5 } });

    const red = buildMapModel(ctx, history(s), 'red');
    expect(red.entities.find((e) => e.kind === 'group')!.label).toBe('MG1 ×8');
    const god = buildMapModel(ctx, history(s), 'god');
    expect(god.entities.find((e) => e.kind === 'group')!.label).toBe('MG1 ×3');
    const blue = buildMapModel(ctx, history(s), 'blue');
    expect(blue.entities.some((e) => e.kind === 'group')).toBe(false);
    expect(JSON.stringify(blue)).not.toContain('MG1');
  });

  test('trail follows the command history across a route change; planned route is dashed ahead', () => {
    const ctx = miniCtx([ddg('b1', 'blue', [0, 0, 0], { velocity: [10, 0, 0], sensorsOn: [] })]);
    const s = new Session(ctx);
    must(s, { type: 'ADVANCE', until: 100_000 }); // 1 km east
    must(s, { type: 'SET_ROUTE', unitId: 'b1', waypoints: [{ position: [1000, 5000, 0] }] });
    must(s, { type: 'ADVANCE', until: 200_000 });
    const trail = unitTrail(history(s), 'b1');
    expect(trail[0]).toEqual([0, 0, 0]);
    expect(trail.some((p) => Math.abs(p[0] - 1000) < 1e-6 && Math.abs(p[1]) < 1e-6)).toBe(true); // the turn point
    const last = trail[trail.length - 1]!;
    expect(last[1]).toBeGreaterThan(0);
    const e = buildMapModel(ctx, history(s), 'god').entities[0]!;
    expect(e.route?.[e.route.length - 1]).toEqual([1000, 5000, 0]);
  });

  test('god model can overlay every side’s track picture', () => {
    const ctx = demoCtx();
    const s = new Session(ctx);
    must(s, { type: 'ADVANCE' });
    detectAll(s);
    const off = buildMapModel(ctx, history(s), 'god');
    const on = buildMapModel(ctx, history(s), 'god', { godTracks: true });
    expect(off.entities.some((e) => e.kind === 'track')).toBe(false);
    expect(on.entities.filter((e) => e.kind === 'track').length).toBe(8);
  });

  test('display labels', () => {
    expect(trackNumber('blue-T1')).toBe('7001');
    expect(trackNumber('red-T12')).toBe('7012');
    expect(trackNumber('weird')).toBe('weird');
    expect(groupLabel('red-MG3')).toBe('MG3');
  });

  test('preview at a later time follows motion plans and flights without changing state', () => {
    const ctx = miniCtx([ddg('b1', 'blue', [0, 0, 0], { velocity: [10, 0, 0] }), ddg('r1', 'red', [100_000, 0, 0], { headingDeg: 180 })]);
    const s = new Session(ctx);
    must(s, { type: 'ADVANCE', until: 1 });
    detectAll(s);
    must(s, { type: 'LAUNCH', unitId: 'r1', mountId: 'vls', weaponId: 'asm-x', count: 4, trackId: 'red-T1' });
    const before = JSON.stringify(s.state);
    const g = s.state.groups['red-MG1']!;
    const t = s.state.time + 60_000;
    const m = buildMapModel(ctx, history(s), 'god', { at: t });
    expect(m.preview).toBe(true);
    expect(m.time).toBe(t);
    expect(m.entities.find((e) => e.key === 'unit:b1')!.position).toEqual(positionAt(s.state.units['b1']!.motion, t));
    expect(m.entities.find((e) => e.key === 'group:red-MG1')!.position).toEqual(groupPosition(g, t));
    // After the salvo's arrival time it is no longer drawn in a preview.
    expect(buildMapModel(ctx, history(s), 'god', { at: g.arrivalTime + 1 }).entities.some((e) => e.kind === 'group')).toBe(false);
    // A time in the past is clamped to now (no preview).
    expect(buildMapModel(ctx, history(s), 'god', { at: 0 }).preview).toBeUndefined();
    expect(JSON.stringify(s.state)).toBe(before);

    // Side preview: own salvo extrapolated, nothing about the other side appears.
    const red = JSON.stringify(buildMapModel(ctx, history(s), 'red', { at: t }));
    expect(red).toContain('red-MG1');
    const blue = buildMapModel(ctx, history(s), 'blue', { at: t });
    expect(JSON.stringify(blue)).not.toContain('red-MG1');
    expect(JSON.stringify(blue)).not.toContain('R1');
  });

  test('timeline marks: a side sees only its own schedule', () => {
    const ctx = miniCtx([ddg('b1', 'blue', [0, 0, 0]), ddg('r1', 'red', [100_000, 0, 0], { headingDeg: 180 })]);
    const s = new Session(ctx);
    must(s, { type: 'ADVANCE', until: 1 });
    detectAll(s);
    must(s, { type: 'LAUNCH', unitId: 'r1', mountId: 'vls', weaponId: 'asm-x', count: 4, trackId: 'red-T1' });
    must(s, { type: 'SET_ROUTE', unitId: 'b1', waypoints: [{ position: [5000, 0, 0], speedMps: 10 }] });
    const t0 = s.state.time;
    const god = timelineMarks(ctx, s.state, 'god', t0, t0 + 3_600_000);
    expect(god.map((m) => m.kind).sort()).toEqual(['arrival', 'route']);
    expect(timelineMarks(ctx, s.state, 'blue', t0, t0 + 3_600_000).map((m) => m.kind)).toEqual(['route']);
    expect(timelineMarks(ctx, s.state, 'red', t0, t0 + 3_600_000).map((m) => m.kind)).toEqual(['arrival']);
    expect(timelineMarks(ctx, s.state, 'god', t0, t0 + 1000)).toEqual([]);
  });

  test('localized tracks carry their 95 % ellipsoid, growing in a preview; bearing tracks a spread', () => {
    const ctx = miniCtx([ddg('b1', 'blue', [0, 0, 0], { sensorsOn: ['mfr', 'esm'] }), ddg('r1', 'red', [100_000, 0, 0], { sensorsOn: ['mfr'] })]);
    const s = new Session(ctx);
    must(s, { type: 'ADVANCE', until: 1 });
    detectAll(s);
    must(s, { type: 'SET_SENSOR', unitId: 'b1', sensorId: 'mfr', on: false });
    const tracks = Object.values(s.state.knowledge['b1']!);
    const loc = tracks.find((t) => t.spatial.kind === 'LOCALIZED')!;
    const now = buildMapModel(ctx, history(s), 'blue').entities.find((e) => e.key === `track:${loc.id}`)!;
    const want = ellipsoid95(trackCovarianceAt(ctx, loc, s.state.time)!);
    expect(now.ellipsoid!.axes.map(length)).toEqual(want.map((x) => expect.closeTo(x, 6)));
    const later = buildMapModel(ctx, history(s), 'blue', { at: s.state.time + 600_000 }).entities.find((e) => e.key === `track:${loc.id}`)!;
    expect(length(later.ellipsoid!.axes[0])).toBeGreaterThan(length(now.ellipsoid!.axes[0]));
    const brg = buildMapModel(ctx, history(s), 'blue').entities.find((e) => e.bearing)!;
    expect(brg.bearingSpread).toBeCloseTo(1.96 * (Math.PI / 180), 9);
  });
});
