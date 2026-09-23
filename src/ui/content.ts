/** Bundled data: catalog, scenarios and the golden scripts (loadable as demos). */
import sensors from '../../data/sensors.json';
import weapons from '../../data/weapons.json';
import unitClasses from '../../data/units.json';
import { buildCatalog } from '../state/load.js';
import type { Scenario } from '../state/defs.js';
import type { Command } from '../events/types.js';

export const catalog = buildCatalog({ sensors, weapons, unitClasses });

const scenarioFiles = import.meta.glob('../../scenarios/*.json', { eager: true, import: 'default' }) as Record<string, Scenario>;
export const scenarios: Record<string, Scenario> = Object.fromEntries(
  Object.entries(scenarioFiles).map(([path, sc]) => [path.split('/').pop()!, sc]),
);

/** Subset of the golden-script step format that the UI can replay. */
export type ScriptStep =
  | { do: Command }
  | { waitUntilLegal: Command }
  | { mark: string }
  | { fork: string; at?: string }
  | { switch: string }
  | { undo: number }
  | Record<string, unknown>;

export interface DemoScript {
  name: string;
  description: string;
  scenario: string;
  steps: ScriptStep[];
}

const scriptFiles = import.meta.glob('../../tests/golden/scripts/*.json', { eager: true, import: 'default' }) as Record<string, DemoScript>;
export const scripts: Record<string, DemoScript> = Object.fromEntries(
  Object.entries(scriptFiles).map(([path, sc]) => [path.split('/').pop()!, sc]),
);
