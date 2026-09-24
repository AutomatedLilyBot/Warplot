import { describe, expect, test } from 'vitest';
import { Session } from '../src/events/session.js';
import { unitActions } from '../src/ui/actions.js';
import { ddg, detectAll, miniCtx, must, pending, truthClassification } from './helpers.js';

function raid() {
  const ctx = miniCtx([ddg('b1', 'blue', [0, 0, 0], { headingDeg: 0 }), ddg('r1', 'red', [100_000, 0, 0], { headingDeg: 180 })]);
  const s = new Session(ctx);
  must(s, { type: 'ADVANCE', until: 1 });
  detectAll(s);
  return { ctx, s };
}

describe('legal action catalogue', () => {
  test('lists sensor, weapon, info, manoeuvre and status actions with verdicts', () => {
    const { ctx, s } = raid();
    const track = Object.keys(s.state.knowledge['b1']!)[0]!;
    const items = unitActions(ctx, s.state, 'god', 'b1', track);
    const ids = items.map((i) => i.id);
    expect(ids).toContain('sensor:mfr');
    expect(ids).toContain('launch:vls:asm-x');
    expect(ids).toContain('engage:vls:sam-std');
    expect(ids).toContain('align:rail');
    expect(ids).toContain('classify');
    expect(ids).toContain('evade');
    expect(ids).toContain('status');
    const launch = items.find((i) => i.id === 'launch:vls:asm-x')!;
    expect(launch.verdict.ok).toBe(true);
    expect(launch.command).toMatchObject({ type: 'LAUNCH', count: 1, trackId: track });
    // SAM against a ship track: wrong target category → greyed with a reason.
    const sam = items.find((i) => i.id === 'engage:vls:sam-std')!;
    expect(sam.verdict.ok).toBe(false);
    expect(sam.verdict.checks.some((c) => c.ok === false && c.label.includes('只用于 missile'))).toBe(true);
  });

  test('parameter values feed the command; the verdict follows them', () => {
    const { ctx, s } = raid();
    const track = Object.keys(s.state.knowledge['b1']!)[0]!;
    const items = unitActions(ctx, s.state, 'god', 'b1', track, { 'launch:vls:asm-x': { count: '99' } });
    const launch = items.find((i) => i.id === 'launch:vls:asm-x')!;
    expect(launch.command).toMatchObject({ count: 99 });
    expect(launch.verdict.ok).toBe(false);
    expect(launch.verdict.checks.some((c) => c.ok === false && c.label.includes('库存'))).toBe(true);
  });

  test('earliest legal time is reported for a busy launcher', () => {
    const { ctx, s } = raid();
    const track = Object.keys(s.state.knowledge['b1']!)[0]!;
    must(s, { type: 'LAUNCH', unitId: 'b1', mountId: 'vls', weaponId: 'asm-x', count: 4, trackId: track });
    const launch = unitActions(ctx, s.state, 'god', 'b1', track).find((i) => i.id === 'launch:vls:asm-x')!;
    expect(launch.verdict.ok).toBe(false);
    expect(launch.verdict.earliest).toBe(s.state.time + 4000);
  });

  test('without a track only non-targeted actions are offered; foreign tracks are ignored', () => {
    const { ctx, s } = raid();
    const redTrack = Object.keys(s.state.knowledge['r1']!)[0]!;
    const ids = unitActions(ctx, s.state, 'god', 'b1', redTrack).map((i) => i.id);
    expect(ids.some((id) => id.startsWith('launch:'))).toBe(false);
    expect(ids).toContain('evade');
  });

  test('a side view only acts for own units and hides referee-level checks', () => {
    const { ctx, s } = raid();
    expect(unitActions(ctx, s.state, 'blue', 'r1', null)).toEqual([]);
    const redTrack = Object.keys(s.state.knowledge['r1']!)[0]!;
    must(s, { type: 'LAUNCH', unitId: 'r1', mountId: 'vls', weaponId: 'asm-x', count: 4, trackId: redTrack });
    must(s, { type: 'ADVANCE' });
    const o = pending(s).find((x) => x.kind === 'detection' && x.observerId === 'b1')!;
    if (o.kind !== 'detection') throw new Error();
    // Classify the missile group as a ship: the SAM refuses on category, and the referee line
    // ("目标为飞行中的弹群（裁判层判定）") must not show up in the blue view.
    must(s, { type: 'RESOLVE', opportunityId: o.id, decision: { kind: 'detection', detected: true, classification: { ...truthClassification(s, o.target), category: 'ship' } } });
    const mt = Object.values(s.state.knowledge['b1']!).find((t) => s.state.truth.trackTargets[t.id] === 'red-MG1')!.id;
    const god = unitActions(ctx, s.state, 'god', 'b1', mt).find((i) => i.id === 'engage:vls:sam-std')!;
    const blue = unitActions(ctx, s.state, 'blue', 'b1', mt).find((i) => i.id === 'engage:vls:sam-std')!;
    expect(JSON.stringify(god.verdict.checks)).toContain('裁判层');
    expect(JSON.stringify(blue.verdict.checks)).not.toContain('裁判层');
    expect(blue.verdict.ok).toBe(false);
  });
});
