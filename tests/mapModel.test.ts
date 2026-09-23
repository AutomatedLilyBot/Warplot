import { describe, expect, test } from 'vitest';
import { Session } from '../src/events/session.js';
import { buildMapModel, unitTrail } from '../src/ui/mapModel.js';
import { trackNumber, groupLabel } from '../src/ui/labels.js';
import { demoCtx, ddg, detectAll, miniCtx, must, pending } from './helpers.js';
import type { Ctx } from '../src/rules/world.js';

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
});
