// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from 'vitest';
import { AppStore } from '../src/ui/store.js';

beforeEach(() => localStorage.clear());

describe('browser session store', () => {
  test('a corrupt imported command leaves the current session and autosave intact', () => {
    const store = new AppStore();
    store.dispatch({ type: 'NOTE', text: 'keep this work' });
    const before = store.exportSession();
    const data = JSON.parse(before);
    data.session.nodes.n2 = { id: 'n2', parent: 'n1', command: { type: 'NOTE', text: '' } };
    data.session.seq = 2;
    data.session.branches.main.head = 'n2';

    expect(() => store.importSession(JSON.stringify(data))).toThrow();
    expect(store.exportSession()).toBe(before);
    expect(store.state.log.at(-1)?.truth.summary).toBe('keep this work');
    expect(JSON.parse(localStorage.getItem('warplot:autosave:v1')!).session.branches.main.head).toBe('n1');
  });

  test('mismatched scenario, hidden branch corruption, cycles and sequence collisions are rejected', () => {
    const store = new AppStore();
    const before = store.exportSession();
    const base = JSON.parse(before);

    const mismatch = structuredClone(base);
    mismatch.session.scenarioId = 'other-scenario';
    expect(() => store.importSession(JSON.stringify(mismatch))).toThrow(/scenario/);

    const hidden = structuredClone(base);
    hidden.session.nodes.n1 = { id: 'n1', parent: null, command: { type: 'NOTE', text: '' } };
    hidden.session.seq = 1;
    hidden.session.branches.alt = { id: 'alt', name: 'alt', head: 'n1', redo: [], forkedFrom: null };
    expect(() => store.importSession(JSON.stringify(hidden))).toThrow();

    const cycle = structuredClone(base);
    cycle.session.nodes.n1 = { id: 'n1', parent: 'n1', command: { type: 'NOTE', text: 'loop' } };
    cycle.session.seq = 1;
    expect(() => store.importSession(JSON.stringify(cycle))).toThrow(/cycle/);

    const collision = structuredClone(base);
    collision.session.nodes.n1 = { id: 'n1', parent: null, command: { type: 'NOTE', text: 'saved' } };
    collision.session.branches.main.head = 'n1';
    collision.session.seq = 0;
    expect(() => store.importSession(JSON.stringify(collision))).toThrow(/sequence/);

    const badRedo = structuredClone(base);
    badRedo.session.nodes.n1 = { id: 'n1', parent: null, command: { type: 'NOTE', text: 'saved' } };
    badRedo.session.seq = 1;
    badRedo.session.branches.main.redo = ['n1', 'n1'];
    expect(() => store.importSession(JSON.stringify(badRedo))).toThrow(/redo/);

    const legacy = structuredClone(base);
    legacy.session.nodes.n1 = { id: 'n1', parent: null, command: { type: 'RESOLVE', opportunityId: 'blue-OPP1', decision: { kind: 'detection', detected: true, quality: 'FIRE_CONTROL' } } };
    legacy.session.seq = 1;
    legacy.session.branches.main.head = 'n1';
    expect(() => store.importSession(JSON.stringify(legacy))).toThrow(/旧版会话格式/);
    expect(store.exportSession()).toBe(before);
  });

  test('valid import restores the session and switching sides clears hidden selection', () => {
    const source = new AppStore();
    source.dispatch({ type: 'NOTE', text: 'saved' });
    const json = source.exportSession();
    const store = new AppStore();
    store.importSession(json);
    expect(store.session.commands()).toEqual([{ type: 'NOTE', text: 'saved' }]);

    store.select('unit:blue-ddg-01');
    store.setView('red');
    expect(store.selected).toBeNull();
    const model = store.mapModel();
    expect(model.entities.filter((e) => e.kind === 'unit').every((e) => e.tone === 'red')).toBe(true);
  });
});
