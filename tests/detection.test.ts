import { describe, expect, test } from 'vitest';
import { Session } from '../src/events/session.js';
import { ddg, demoCtx, miniCtx, must, pending } from './helpers.js';
import { detectability } from '../src/rules/detection.js';

describe('detection opportunities', () => {
  test('the sea-search UAV radar cannot detect an airborne UAV, but can detect a ship', () => {
    const ctx = demoCtx();
    const s = new Session(ctx);
    const observer = s.state.units['blue-uav-01']!;
    const air = detectability(ctx, s.state, observer, 'uav-radar', 'red-uav-03', 0);
    expect(air.ok).toBe(false);
    expect(air.checks.some((c) => c.label.includes('目标类别 uav') && !c.ok)).toBe(true);
    const ship = detectability(ctx, s.state, observer, 'uav-radar', 'red-ddg-01', 0);
    expect(ship.checks.some((c) => c.label.includes('目标类别 ship') && c.ok)).toBe(true);
    expect(detectability(ctx, s.state, observer, 'uav-radar', 'red-uav-03', 120_000).ok).toBe(false);
  });

  test('chance appears exactly when the target enters sensor range; time jumps straight there', () => {
    // Red closes at 10 m/s from 160 km; blue mfr range 150 km → 1000 s.
    const ctx = miniCtx([ddg('b1', 'blue', [0, 0, 0]), ddg('r1', 'red', [160_000, 0, 0], { sensorsOn: [], velocity: [-10, 0, 0] })]);
    const s = new Session(ctx);
    must(s, { type: 'ADVANCE' });
    const o = pending(s)[0]!;
    expect(o.kind).toBe('detection');
    expect(Math.abs(s.state.time - 1_000_000)).toBeLessThanOrEqual(1);
    // Only one ADVANCE event → no fixed tick.
    expect(s.state.log.filter((e) => e.kind === 'TIME_ADVANCED')).toHaveLength(1);
  });

  test('"not detected" is recorded with a reason and re-offered after the sensor interval', () => {
    const ctx = miniCtx([ddg('b1', 'blue', [0, 0, 0]), ddg('r1', 'red', [100_000, 0, 0], { sensorsOn: [] })]);
    const s = new Session(ctx);
    must(s, { type: 'ADVANCE' });
    const o = pending(s)[0]!;
    must(s, { type: 'RESOLVE', opportunityId: o.id, decision: { kind: 'detection', detected: false, reason: 'clutter', note: '海杂波' } });
    const declined = s.state.log.at(-1)!;
    expect(declined.kind).toBe('DETECTION_DECLINED');
    expect(declined.sides).toEqual({}); // author-only
    must(s, { type: 'ADVANCE' });
    expect(s.state.time).toBe(60_000); // mfr reofferIntervalS = 60
    expect(pending(s)).toHaveLength(1);
  });

  test('an obstacle blocks line of sight until the target clears it', () => {
    // Island of radius 5 km between them; red moves north past it at 10 m/s.
    const ctx = miniCtx(
      [ddg('b1', 'blue', [0, 0, 0]), ddg('r1', 'red', [100_000, -30_000, 0], { sensorsOn: [], velocity: [0, 10, 0] })],
      { obstacles: [{ id: 'isl', name: '礁岛', center: [50_000, -15_000, 0], radiusM: 5000 }] },
    );
    const s = new Session(ctx);
    must(s, { type: 'ADVANCE' });
    const o = pending(s)[0]!;
    expect(s.state.time).toBeGreaterThan(0);
    // Sight line must be just clear of the island at the offered time.
    const y = -30_000 + 10 * (s.state.time / 1000);
    const a = [0, 0], b = [100_000, y], c = [50_000, -15_000];
    const t = ((c[0]! - a[0]!) * (b[0]! - a[0]!) + (c[1]! - a[1]!) * (b[1]! - a[1]!)) / ((b[0]! - a[0]!) ** 2 + (b[1]! - a[1]!) ** 2);
    const d = Math.hypot(a[0]! + t * (b[0]! - a[0]!) - c[0]!, a[1]! + t * (b[1]! - a[1]!) - c[1]!);
    expect(d).toBeGreaterThanOrEqual(5000);
    expect(d).toBeLessThan(5010);
    expect(JSON.stringify(o.explanation)).toContain('视线无遮挡');
  });
});
