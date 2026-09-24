import sensors from '../data/sensors.json';
import weapons from '../data/weapons.json';
import unitClasses from '../data/units.json';
import demo from '../scenarios/demo_scenario.json';
import { buildCatalog, asScenario } from '../src/state/load.js';
import type { Ctx } from '../src/rules/world.js';
import type { Scenario, UnitSetup } from '../src/state/defs.js';
import { Session } from '../src/events/session.js';
import type { ClassificationRuling, Command, Opportunity } from '../src/events/types.js';
import { renderExplanation } from '../src/core/explain.js';

export const catalog = buildCatalog({ sensors, weapons, unitClasses });

export function demoCtx(): Ctx {
  return { scenario: structuredClone(asScenario(demo)), catalog };
}

/** Minimal scenario builder for focused rule tests. */
export function miniCtx(units: UnitSetup[], extra: Partial<Scenario> = {}): Ctx {
  const scenario: Scenario = {
    id: 'mini',
    name: 'mini',
    epoch: '00:00:00',
    signalSpeedMps: 299792458,
    sides: [
      { id: 'blue', name: 'Blue' },
      { id: 'red', name: 'Red' },
    ],
    referencePlanes: [],
    obstacles: [],
    units,
    datalinks: [],
    ...extra,
  };
  return { scenario, catalog };
}

export const ddg = (id: string, side: string, position: [number, number, number], extra: Partial<UnitSetup> = {}): UnitSetup => ({
  id,
  name: id.toUpperCase(),
  side,
  classId: 'ddg',
  position,
  sensorsOn: ['mfr'],
  loadout: { vls: { 'sam-std': 40, 'asm-x': 16 }, ciws: { 'ciws-burst': 30 }, rail: { 'rail-slug': 40 } },
  ...extra,
});

/** Dispatch and throw with the reason tree if illegal. */
export function must(session: Session, cmd: Command) {
  const r = session.dispatch(cmd);
  if (!r.ok) throw new Error(`${cmd.type} rejected:\n${r.verdict.checks.map((c) => renderExplanation(c)).join('\n')}`);
  return r;
}

export function pending(session: Session): Opportunity[] {
  return Object.values(session.state.opportunities).filter((o) => o.status === 'pending');
}

/** Truth-correct classification of an entity (tests may classify with perfect knowledge). */
export function truthClassification(session: Session, target: string): ClassificationRuling {
  const u = session.state.units[target];
  const category = u ? session.ctx.catalog.unitClasses[u.classId]!.category : 'missile';
  return { category, identity: 'hostile', confidence: 1 };
}

/** Resolve every pending detection as "detected", unbiased and correctly classified. */
export function detectAll(session: Session): void {
  for (const o of pending(session))
    if (o.kind === 'detection')
      must(session, {
        type: 'RESOLVE',
        opportunityId: o.id,
        decision: { kind: 'detection', detected: true, classification: truthClassification(session, o.target) },
      });
}
