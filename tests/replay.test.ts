import { describe, expect, test } from 'vitest';
import { Session } from '../src/events/session.js';
import { replay } from '../src/events/engine.js';
import { demoCtx, detectAll, must, pending } from './helpers.js';

/** Drive the demo for a while, ruling every detection as detected. */
function play(s: Session, steps: number) {
  for (let i = 0; i < steps; i++) {
    if (pending(s).length) detectAll(s);
    else must(s, { type: 'ADVANCE', until: 3_600_000 });
  }
}

describe('event sourcing', () => {
  test('state equals replay of the command log (deterministic)', () => {
    const ctx = demoCtx();
    const s = new Session(ctx);
    play(s, 8);
    must(s, { type: 'SET_ROUTE', unitId: 'blue-ddg-01', waypoints: [{ position: [50_000, -10_000, 0], speedMps: 12 }] });
    play(s, 6);
    const a = JSON.stringify(s.state);
    const b = JSON.stringify(replay(ctx, s.commands()));
    const c = JSON.stringify(replay(demoCtx(), s.commands()));
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  test('undo returns exactly the previous state; redo restores; new command clears redo', () => {
    const s = new Session(demoCtx());
    play(s, 5);
    const before = JSON.stringify(s.state);
    must(s, { type: 'NOTE', text: 'Red commander hesitates' });
    const after = JSON.stringify(s.state);
    expect(s.undo()).toBe(true);
    expect(JSON.stringify(s.state)).toBe(before);
    expect(s.redo()).toBe(true);
    expect(JSON.stringify(s.state)).toBe(after);
    s.undo();
    must(s, { type: 'NOTE', text: 'different idea' });
    expect(s.canRedo()).toBe(false);
  });

  test('fork from a historical node; branches evolve independently', () => {
    const s = new Session(demoCtx());
    play(s, 4);
    const forkPoint = s.branch.head;
    const atFork = JSON.stringify(s.state);
    play(s, 4);
    const mainState = JSON.stringify(s.state);

    s.fork('what-if: blue turns away', forkPoint);
    expect(JSON.stringify(s.state)).toBe(atFork);
    must(s, { type: 'SET_ROUTE', unitId: 'blue-ddg-02', waypoints: [{ position: [-30_000, 40_000, 0] }] });
    expect(JSON.stringify(s.state)).not.toBe(mainState);

    s.switchBranch('main');
    expect(JSON.stringify(s.state)).toBe(mainState);
    expect(s.branches().map((b) => b.name)).toEqual(['main', 'what-if: blue turns away']);
  });

  test('serialised session reloads to the same state on every branch', () => {
    const ctx = demoCtx();
    const s = new Session(ctx);
    play(s, 6);
    s.fork('alt');
    must(s, { type: 'NOTE', text: 'alt line' });
    const json = JSON.parse(JSON.stringify(s.toJSON()));
    const t = Session.fromJSON(demoCtx(), json);
    for (const b of ['main', 'alt']) {
      s.switchBranch(b);
      t.switchBranch(b);
      expect(JSON.stringify(t.state)).toBe(JSON.stringify(s.state));
    }
  });
});
