/** Build a Catalog from plain JSON arrays and sanity-check cross references. */
import { type Catalog, type Scenario, type SensorDef, type UnitClassDef, type WeaponDef, TRACK_QUALITIES } from './defs.js';

export function buildCatalog(raw: { sensors: unknown[]; weapons: unknown[]; unitClasses: unknown[] }): Catalog {
  const byId = <T extends { id: string }>(xs: T[], what: string): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const x of xs) {
      if (out[x.id]) throw new Error(`duplicate ${what} id ${x.id}`);
      out[x.id] = x;
    }
    return out;
  };
  const sensors = byId(raw.sensors as SensorDef[], 'sensor');
  const weapons = byId(raw.weapons as WeaponDef[], 'weapon');
  const unitClasses = byId(raw.unitClasses as UnitClassDef[], 'unit class');
  for (const s of Object.values(sensors))
    if (!TRACK_QUALITIES.includes(s.maxQuality)) throw new Error(`sensor ${s.id}: bad maxQuality ${s.maxQuality}`);
  for (const w of Object.values(weapons))
    if (!TRACK_QUALITIES.includes(w.requiredQuality)) throw new Error(`weapon ${w.id}: bad requiredQuality`);
  for (const c of Object.values(unitClasses)) {
    for (const sid of c.sensors) if (!sensors[sid]) throw new Error(`class ${c.id}: unknown sensor ${sid}`);
    for (const m of c.mounts) {
      for (const wid of m.weapons) if (!weapons[wid]) throw new Error(`class ${c.id}.${m.id}: unknown weapon ${wid}`);
      if (m.kind === 'turret' && !c.resources.some((r) => r.id === m.resource))
        throw new Error(`class ${c.id}.${m.id}: resource ${m.resource} not declared`);
    }
  }
  return { sensors, weapons, unitClasses };
}

export const asScenario = (raw: unknown): Scenario => raw as Scenario;
