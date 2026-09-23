import { describe, expect, test } from 'vitest';
import { Session } from '../src/events/session.js';
import { ddg, detectAll, miniCtx, must, pending } from './helpers.js';
import type { Command } from '../src/events/types.js';

function duel(distanceM = 100_000, redSensors: string[] = ['mfr']) {
  const ctx = miniCtx([ddg('b1', 'blue', [0, 0, 0], { sensorsOn: ['mfr', 'esm'] }), ddg('r1', 'red', [distanceM, 0, 0], { sensorsOn: redSensors })]);
  return { ctx, s: new Session(ctx) };
}

const failed = (s: Session, cmd: Command) => {
  const v = s.check(cmd);
  expect(v.ok).toBe(false);
  return v.checks.filter((c) => c.ok === false).map((c) => c.label);
};

describe('illegal actions are refused with reasons', () => {
  test('ADVANCE is blocked while an opportunity is pending', () => {
    const { s } = duel();
    must(s, { type: 'ADVANCE', until: 1000 });
    expect(pending(s).length).toBeGreaterThan(0);
    expect(failed(s, { type: 'ADVANCE' }).join()).toContain('待裁定');
  });

  test('an illegal command changes nothing', () => {
    const { s } = duel();
    const before = JSON.stringify(s.state);
    const r = s.dispatch({ type: 'LAUNCH', unitId: 'b1', mountId: 'vls', weaponId: 'asm-x', count: 1, trackId: 'nope' });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(s.state)).toBe(before);
    expect(s.canUndo()).toBe(false);
  });

  test('inventory, launcher busy, range, quality, wrong weapon, wrong mount', () => {
    const { s } = duel();
    must(s, { type: 'ADVANCE', until: 1000 });
    // Resolve: radar → FIRE_CONTROL track blue-T?; ESM gives bearing-only. Resolve radar first.
    for (const o of pending(s)) {
      if (o.kind !== 'detection') continue;
      must(s, { type: 'RESOLVE', opportunityId: o.id, decision: { kind: 'detection', detected: true, quality: o.maxQuality } });
    }
    const tracks = s.state.knowledge['b1']!;
    const fc = Object.values(tracks).find((t) => t.quality === 'FIRE_CONTROL')!;
    const brg = Object.values(tracks).find((t) => t.quality === 'BEARING_ONLY')!;
    const L = (x: Partial<Extract<Command, { type: 'LAUNCH' }>>): Command => ({
      type: 'LAUNCH',
      unitId: 'b1',
      mountId: 'vls',
      weaponId: 'asm-x',
      count: 2,
      trackId: fc.id,
      ...x,
    });

    expect(failed(s, L({ count: 17 })).join()).toContain('库存');
    expect(failed(s, L({ trackId: brg.id })).join()).toMatch(/航迹质量|非纯方位/);
    expect(failed(s, L({ weaponId: 'rail-slug' })).join()).toContain('可发射');
    expect(failed(s, L({ mountId: 'ciws', weaponId: 'ciws-burst' })).join()).toContain('用途匹配');
    expect(failed(s, L({ weaponId: 'sam-std' })).join()).toContain('用途匹配');

    must(s, L({ count: 4 }));
    const v = s.check(L({ count: 1 }));
    expect(v.ok).toBe(false);
    expect(v.earliest).toBe(4000); // 4 rounds × 1 s launch interval
    expect(v.checks.find((c) => c.ok === false)!.label).toContain('冷却');
  });

  test('fractional or non-finite launch counts are refused without changing inventory', () => {
    const { s } = duel();
    must(s, { type: 'ADVANCE', until: 1000 });
    detectAll(s);
    const trackId = Object.values(s.state.knowledge['b1']!).find((t) => t.quality === 'FIRE_CONTROL')!.id;
    const before = JSON.stringify(s.state);
    for (const count of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const cmd = { type: 'LAUNCH', unitId: 'b1', mountId: 'vls', weaponId: 'asm-x', count, trackId } as const;
      expect(failed(s, cmd).join()).toContain('正整数');
      expect(s.dispatch(cmd).ok).toBe(false);
      expect(JSON.stringify(s.state)).toBe(before);
    }
    must(s, { type: 'LAUNCH', unitId: 'b1', mountId: 'vls', weaponId: 'asm-x', count: 1, trackId });
    expect(s.state.units['b1']!.mounts['vls']!.ammo['asm-x']).toBe(15);
    expect(s.state.groups['blue-MG1']!.count).toBe(1);
  });

  test('out of range', () => {
    const { s } = duel(4000); // closer than asm-x min range 5 km
    must(s, { type: 'ADVANCE', until: 1000 });
    detectAll(s);
    const tr = Object.values(s.state.knowledge['b1']!).find((t) => t.quality === 'FIRE_CONTROL')!;
    expect(failed(s, { type: 'LAUNCH', unitId: 'b1', mountId: 'vls', weaponId: 'asm-x', count: 1, trackId: tr.id }).join()).toContain('预测命中点距离');
  });

  test('stale track is refused by weapons with a short max track age', () => {
    const { s } = duel(100_000);
    must(s, { type: 'ADVANCE', until: 1000 });
    detectAll(s);
    const tr = Object.values(s.state.knowledge['b1']!).find((t) => t.quality === 'FIRE_CONTROL')!;
    must(s, { type: 'SET_SENSOR', unitId: 'b1', sensorId: 'mfr', on: false });
    must(s, { type: 'ADVANCE', until: 20_000 });
    // rail-slug requires a track ≤ 10 s old; the radar is off so the track is now 19 s old.
    expect(failed(s, { type: 'LAUNCH', unitId: 'b1', mountId: 'rail', weaponId: 'rail-slug', count: 1, trackId: tr.id }).join()).toContain('航迹时龄');
    // asm-x tolerates 300 s, so the same track is still good enough for it.
    expect(s.check({ type: 'LAUNCH', unitId: 'b1', mountId: 'vls', weaponId: 'asm-x', count: 1, trackId: tr.id }).ok).toBe(true);
  });

  test('RESOLVE outside the legal interval is refused', () => {
    const { s } = duel();
    must(s, { type: 'ADVANCE', until: 1000 });
    const o = pending(s).find((x) => x.kind === 'detection')!;
    expect(failed(s, { type: 'RESOLVE', opportunityId: o.id, decision: { kind: 'impact', hits: 1 } }).join()).toContain('裁定类型');
    if (o.kind !== 'detection') throw new Error();
    const tooGood = o.sensorId === 'esm' ? 'LOCALIZED' : 'FIRE_CONTROL';
    if (o.sensorId === 'esm')
      expect(failed(s, { type: 'RESOLVE', opportunityId: o.id, decision: { kind: 'detection', detected: true, quality: tooGood } }).join()).toContain('航迹质量');
  });
});
