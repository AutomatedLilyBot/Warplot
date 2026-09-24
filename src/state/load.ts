/** Build a Catalog from plain JSON arrays and sanity-check cross references. */
import { type Catalog, type Scenario, type SensorDef, type UnitClassDef, type WeaponDef, IDENTITIES, TARGET_CATEGORIES } from './defs.js';

const finite = (n: number) => Number.isFinite(n);
const positive = (n: number) => finite(n) && n > 0;
const nonnegative = (n: number) => finite(n) && n >= 0;
const count = (n: number) => Number.isSafeInteger(n) && n >= 0;
const vector = (v: readonly number[]) => Array.isArray(v) && v.length === 3 && v.every(finite);
const requireValue = (ok: boolean, label: string): void => {
  if (!ok) throw new Error(`invalid ${label}`);
};
const probability = (n: number) => finite(n) && n >= 0 && n <= 1;
const categories = (xs: unknown) =>
  Array.isArray(xs) && xs.length > 0 && xs.every((c) => (TARGET_CATEGORIES as readonly unknown[]).includes(c));
const bounds = (b: [number, number]) => Array.isArray(b) && b.length === 2 && b.every((n) => nonnegative(n) && n <= 1) && b[0] <= b[1];

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
  for (const s of Object.values(sensors)) {
    if (s.targetCategories !== undefined) requireValue(categories(s.targetCategories), `sensor ${s.id}.targetCategories`);
    requireValue(positive(s.rangeM), `sensor ${s.id}.rangeM`);
    const m = s.measurement;
    requireValue(!!m && (m.kind === 'bearing' || m.kind === 'position'), `sensor ${s.id}.measurement.kind`);
    requireValue(positive(m.angleSigmaDeg) && m.angleSigmaDeg < 90, `sensor ${s.id}.measurement.angleSigmaDeg`);
    if (m.kind === 'position') {
      requireValue(positive(m.rangeSigmaM), `sensor ${s.id}.measurement.rangeSigmaM`);
      requireValue(positive(m.velocitySigmaMps), `sensor ${s.id}.measurement.velocitySigmaMps`);
    }
    requireValue(positive(s.reofferIntervalS), `sensor ${s.id}.reofferIntervalS`);
  }
  for (const w of Object.values(weapons)) {
    requireValue(positive(w.speedMps), `weapon ${w.id}.speedMps`);
    requireValue(nonnegative(w.minRangeM) && positive(w.maxRangeM) && w.maxRangeM >= w.minRangeM, `weapon ${w.id}.range`);
    if (w.targetCategories !== undefined) requireValue(categories(w.targetCategories), `weapon ${w.id}.targetCategories`);
    if (w.minClassificationConfidence !== undefined)
      requireValue(probability(w.minClassificationConfidence), `weapon ${w.id}.minClassificationConfidence`);
    if (w.signature !== undefined) requireValue(nonnegative(w.signature), `weapon ${w.id}.signature`);
    if (w.seekerBasketM !== undefined) requireValue(nonnegative(w.seekerBasketM), `weapon ${w.id}.seekerBasketM`);
    if (w.terminalBounds !== undefined) requireValue(bounds(w.terminalBounds), `weapon ${w.id}.terminalBounds`);
    if (w.killBounds !== undefined) requireValue(bounds(w.killBounds), `weapon ${w.id}.killBounds`);
    if (w.engagementCycleS !== undefined) requireValue(positive(w.engagementCycleS), `weapon ${w.id}.engagementCycleS`);
    if (w.salvoPerEngagement !== undefined) requireValue(count(w.salvoPerEngagement) && w.salvoPerEngagement > 0, `weapon ${w.id}.salvoPerEngagement`);
    if (w.fireControlChannels !== undefined) requireValue(count(w.fireControlChannels), `weapon ${w.id}.fireControlChannels`);
    if (w.illuminatorTimeS !== undefined) requireValue(positive(w.illuminatorTimeS), `weapon ${w.id}.illuminatorTimeS`);
  }
  for (const c of Object.values(unitClasses)) {
    requireValue(positive(c.maxSpeedMps), `class ${c.id}.maxSpeedMps`);
    requireValue(positive(c.maxAccelMps2), `class ${c.id}.maxAccelMps2`);
    requireValue(positive(c.maxSlewRateDegS), `class ${c.id}.maxSlewRateDegS`);
    requireValue(nonnegative(c.signature), `class ${c.id}.signature`);
    for (const sid of c.sensors) if (!sensors[sid]) throw new Error(`class ${c.id}: unknown sensor ${sid}`);
    for (const m of c.mounts) {
      requireValue(count(m.capacity), `class ${c.id}.${m.id}.capacity`);
      requireValue(nonnegative(m.launchIntervalS), `class ${c.id}.${m.id}.launchIntervalS`);
      for (const wid of m.weapons) if (!weapons[wid]) throw new Error(`class ${c.id}.${m.id}: unknown weapon ${wid}`);
      if (m.kind === 'turret' && !c.resources.some((r) => r.id === m.resource))
        throw new Error(`class ${c.id}.${m.id}: resource ${m.resource} not declared`);
      if (m.kind === 'turret') requireValue(positive(m.traverseRateDegS), `class ${c.id}.${m.id}.traverseRateDegS`);
      if (m.kind === 'fixed') {
        requireValue(vector(m.boresight) && m.boresight.some((n) => n !== 0), `class ${c.id}.${m.id}.boresight`);
        requireValue(nonnegative(m.halfAngleDeg) && m.halfAngleDeg <= 180, `class ${c.id}.${m.id}.halfAngleDeg`);
      }
    }
    for (const r of c.resources) if (r.kind === 'capacity') requireValue(count(r.capacity), `class ${c.id}.${r.id}.capacity`);
  }
  return { sensors, weapons, unitClasses };
}

/** Values supplied by scenario JSON must not create invalid times or positions. */
export function validateScenario(s: Scenario): void {
  requireValue(positive(s.signalSpeedMps), `scenario ${s.id}.signalSpeedMps`);
  for (const p of s.referencePlanes) {
    requireValue(vector(p.origin), `plane ${p.id}.origin`);
    requireValue(vector(p.normal) && p.normal.some((n) => n !== 0), `plane ${p.id}.normal`);
  }
  for (const o of s.obstacles) {
    requireValue(vector(o.center), `obstacle ${o.id}.center`);
    requireValue(nonnegative(o.radiusM), `obstacle ${o.id}.radiusM`);
  }
  for (const [side, roe] of Object.entries(s.roe ?? {})) {
    requireValue(s.sides.some((sd) => sd.id === side), `roe ${side}: unknown side`);
    requireValue(roe.weaponsRelease === 'free' || roe.weaponsRelease === 'tight', `roe ${side}.weaponsRelease`);
    if (roe.minHostileConfidence !== undefined) requireValue(probability(roe.minHostileConfidence), `roe ${side}.minHostileConfidence`);
  }
  if (s.trackPrediction !== undefined)
    requireValue(nonnegative(s.trackPrediction.velocityDriftMpsPerMin), `scenario ${s.id}.trackPrediction.velocityDriftMpsPerMin`);
  for (const link of s.datalinks) {
    requireValue(nonnegative(link.latencyS), `datalink ${link.id}.latencyS`);
    if (link.maxRangeM !== undefined) requireValue(nonnegative(link.maxRangeM), `datalink ${link.id}.maxRangeM`);
  }
  for (const u of s.units) {
    requireValue(vector(u.position), `unit ${u.id}.position`);
    if (u.velocity !== undefined) requireValue(vector(u.velocity), `unit ${u.id}.velocity`);
    if (u.headingDeg !== undefined) requireValue(finite(u.headingDeg), `unit ${u.id}.headingDeg`);
    if (u.orientation !== undefined)
      requireValue(Array.isArray(u.orientation) && u.orientation.length === 4 && u.orientation.every(finite) && u.orientation.some((n) => n !== 0), `unit ${u.id}.orientation`);
    for (const [mount, ammo] of Object.entries(u.loadout))
      for (const [weapon, n] of Object.entries(ammo)) requireValue(count(n), `unit ${u.id}.${mount}.${weapon} loadout`);
    for (const [i, waypoint] of (u.route ?? []).entries()) {
      requireValue(vector(waypoint.position), `unit ${u.id}.route[${i}].position`);
      if (waypoint.speedMps !== undefined) requireValue(nonnegative(waypoint.speedMps), `unit ${u.id}.route[${i}].speedMps`);
    }
  }
}

export const isIdentity = (x: unknown): boolean => (IDENTITIES as readonly unknown[]).includes(x);
export const isCategory = (x: unknown): boolean => (TARGET_CATEGORIES as readonly unknown[]).includes(x);

export const asScenario = (raw: unknown): Scenario => raw as Scenario;
