import { describe, expect, test } from 'vitest';
import { Session } from '../src/events/session.js';
import { projectSideView } from '../src/state/view.js';
import { type CausalEvent, causalGraph } from '../src/ui/causal.js';
import { ddg, detectAll, miniCtx, must } from './helpers.js';

const ev = (id: string, causedBy: string[] = [], refs: string[] = []): CausalEvent => ({ id, time: 0, kind: 'K', summary: id, causedBy, refs });

describe('causal graph', () => {
  test('causes and effects follow causedBy and fact refs; shared ancestors are shown once', () => {
    // a → b, a → c, (b, c) → d, d → e
    const events = [ev('a'), ev('b', ['a']), ev('c', [], ['a']), ev('d', ['b', 'c']), ev('e', ['d'])];
    const g = causalGraph(events, 'd')!;
    expect(g.causes.map((n) => [n.event.id, n.depth, n.repeat])).toEqual([
      ['b', 1, false],
      ['a', 2, false],
      ['c', 1, false],
      ['a', 2, true],
    ]);
    expect(g.effects.map((n) => n.event.id)).toEqual(['e']);
    expect(causalGraph(events, 'a')!.effects.map((n) => n.event.id)).toEqual(['b', 'd', 'e', 'c', 'd']);
    expect(causalGraph(events, 'zzz')).toBeNull();
  });

  test('works on a real session: LAUNCH traces back to the detection opportunity', () => {
    const ctx = miniCtx([ddg('b1', 'blue', [0, 0, 0]), ddg('r1', 'red', [100_000, 0, 0])]);
    const s = new Session(ctx);
    must(s, { type: 'ADVANCE', until: 1 });
    detectAll(s);
    const track = Object.keys(s.state.knowledge['b1']!)[0]!;
    const r = must(s, { type: 'LAUNCH', unitId: 'b1', mountId: 'vls', weaponId: 'asm-x', count: 1, trackId: track });
    const launch = r.events.find((e) => e.kind === 'LAUNCH')!;
    const god: CausalEvent[] = s.state.log.map((e) => ({
      id: e.id,
      time: e.time,
      kind: e.kind,
      summary: e.truth.summary,
      causedBy: e.causedBy,
      refs: e.truth.requires.flatMap((f) => (f.ref ? [f.ref] : [])),
    }));
    const kinds = causalGraph(god, launch.id)!.causes.map((n) => n.event.kind);
    expect(kinds).toEqual(expect.arrayContaining(['DETECTION', 'DETECTION_OPPORTUNITY']));

    // Side view: ids are renumbered and opportunities (author-level) are not part of the chain.
    const side = projectSideView(ctx, s.state, 'blue').events.map((e) => ({
      id: e.id,
      time: e.time,
      kind: e.kind,
      summary: e.summary,
      causedBy: e.causedBy,
      refs: e.requires.flatMap((f) => (f.ref ? [f.ref] : [])),
    }));
    const sideLaunch = side.find((e) => e.kind === 'LAUNCH')!;
    const sideKinds = causalGraph(side, sideLaunch.id)!.causes.map((n) => n.event.kind);
    expect(sideKinds).toContain('DETECTION');
    expect(sideKinds).not.toContain('DETECTION_OPPORTUNITY');
    expect(JSON.stringify(causalGraph(side, sideLaunch.id))).not.toMatch(/"E\d+"/);
  });
});
