/**
 * Static definitions loaded from /data and /scenarios. Distances in metres,
 * durations in seconds, angles in degrees. Runtime state uses SimTime (ms).
 */
import type { Vec3 } from '../core/math/vec3.js';
import type { Quat } from '../core/math/quat.js';

export type SideId = string;
export type UnitId = string;

export type TargetCategory = 'ship' | 'uav' | 'aew' | 'missile';
export const TARGET_CATEGORIES: readonly TargetCategory[] = ['ship', 'uav', 'aew', 'missile'];

export type Identity = 'hostile' | 'neutral' | 'friendly' | 'unknown';
export const IDENTITIES: readonly Identity[] = ['hostile', 'neutral', 'friendly', 'unknown'];

/**
 * What one measurement of this sensor contains. Errors are 1σ of an unbiased
 * measurement; the engine turns them into a covariance in the observation
 * geometry and never samples them.
 */
export type MeasurementModel =
  | { kind: 'bearing'; angleSigmaDeg: number }
  | { kind: 'position'; angleSigmaDeg: number; rangeSigmaM: number; velocitySigmaMps: number };

export interface SensorDef {
  id: string;
  name: string;
  kind: 'radar' | 'eo' | 'esm' | 'other';
  /** Target classes this sensor can search; omitted means all classes. */
  targetCategories?: TargetCategory[];
  /** Legacy placeholder: nominal geometric detection range against a signature-1.0 target. */
  rangeM: number;
  /** Measurement content and 1σ errors (bearing-only or full position). */
  measurement: MeasurementModel;
  /** Radar-like sensors emit while on (makes the carrier detectable by ESM). */
  emits: boolean;
  /** ESM-like sensors can only detect targets that are emitting. */
  requiresTargetEmission?: boolean;
  /** After a "not detected" ruling, how long before the same chance is offered again. */
  reofferIntervalS: number;
}

export type WeaponRole = 'anti_ship' | 'sam' | 'ciws' | 'gun';

export interface WeaponDef {
  id: string;
  name: string;
  role: WeaponRole;
  speedMps: number;
  minRangeM: number;
  maxRangeM: number;
  /** Target categories this weapon may be used against; the track must be classified accordingly. */
  targetCategories?: TargetCategory[];
  /** Minimum classification confidence for the category check (default 0). */
  minClassificationConfidence?: number;
  /** Detectability multiplier of the weapon while in flight (for missile groups). */
  signature?: number;
  /** Anti-ship / gun: target must be within this radius of the aim point at arrival. */
  seekerBasketM?: number;
  /** Anti-ship / gun: per-round terminal bounds [lo, hi] used to derive the legal hit interval. */
  terminalBounds?: [number, number];
  /** Interceptors: one engagement cycle per channel (s). */
  engagementCycleS?: number;
  /** Interceptors: rounds fired per engagement (e.g. shoot-shoot = 2). */
  salvoPerEngagement?: number;
  /** Interceptors: per-engagement kill bounds [lo, hi] used to derive the legal interval. */
  killBounds?: [number, number];
  /** Interceptors: fire-control channels one engagement ties up. 0 = none. */
  fireControlChannels?: number;
  /** Interceptors with semi-active terminal homing: illuminator seconds per engagement. */
  illuminatorTimeS?: number;
}

export interface BlindZone {
  label: string;
  azDeg: [number, number];
  elDeg: [number, number];
}

export type MountDef =
  | {
      id: string;
      name: string;
      kind: 'vls';
      weapons: string[];
      capacity: number;
      /** Seconds between consecutive rounds leaving the launcher. */
      launchIntervalS: number;
    }
  | {
      id: string;
      name: string;
      kind: 'turret';
      weapons: string[];
      capacity: number;
      launchIntervalS: number;
      /** Exclusive resource representing the turret's own pointing freedom. */
      resource: string;
      azimuthDeg: [number, number];
      elevationDeg: [number, number];
      traverseRateDegS: number;
      blindZones?: BlindZone[];
    }
  | {
      id: string;
      name: string;
      kind: 'fixed';
      weapons: string[];
      capacity: number;
      launchIntervalS: number;
      /** Body-frame direction of the bore (e.g. [1,0,0] = along the keel, forward). */
      boresight: Vec3;
      /** Target direction must lie within this cone around the bore. */
      halfAngleDeg: number;
    };

export type ResourceDef =
  | { id: string; kind: 'attitude' }
  | { id: string; kind: 'exclusive' }
  | { id: string; kind: 'capacity'; capacity: number };

export interface UnitClassDef {
  id: string;
  name: string;
  category: Exclude<TargetCategory, 'missile'>;
  maxSpeedMps: number;
  maxAccelMps2: number;
  /** Max attitude slew rate (deg/s) — the simplified attitude response. */
  maxSlewRateDegS: number;
  signature: number;
  sensors: string[];
  mounts: MountDef[];
  resources: ResourceDef[];
}

export interface Waypoint {
  position: Vec3;
  speedMps?: number;
}

export interface UnitSetup {
  id: UnitId;
  name: string;
  side: SideId;
  classId: string;
  position: Vec3;
  orientation?: Quat;
  headingDeg?: number;
  /** Initial constant velocity (m/s) if no route is given. */
  velocity?: Vec3;
  route?: Waypoint[];
  /** mountId → weaponId → rounds */
  loadout: Record<string, Record<string, number>>;
  sensorsOn?: string[];
}

export interface DatalinkDef {
  id: string;
  name: string;
  side: SideId;
  members: UnitId[];
  latencyS: number;
  maxRangeM?: number;
}

export interface ReferencePlaneDef {
  id: string;
  name: string;
  origin: Vec3;
  normal: Vec3;
}

export interface ObstacleDef {
  id: string;
  name: string;
  center: Vec3;
  radiusM: number;
}

/** Side-level rules of engagement. `tight`: only tracks identified hostile with enough confidence. */
export interface RoeDef {
  weaponsRelease: 'free' | 'tight';
  minHostileConfidence?: number;
}

export interface Scenario {
  id: string;
  name: string;
  /** Wall-clock label of t=0, e.g. "07:40:00". */
  epoch: string;
  /** Signal propagation speed used for datalink delay (m/s). */
  signalSpeedMps: number;
  sides: { id: SideId; name: string }[];
  referencePlanes: ReferencePlaneDef[];
  obstacles: ObstacleDef[];
  units: UnitSetup[];
  datalinks: DatalinkDef[];
  /** Rules of engagement per side; a side without an entry is weapons-free. */
  roe?: Record<SideId, RoeDef>;
  /**
   * Track prediction: unknown target manoeuvre as a velocity random walk —
   * 1σ velocity change accumulated per minute (m/s per √min).
   */
  trackPrediction?: { velocityDriftMpsPerMin: number };
}

export interface Catalog {
  sensors: Record<string, SensorDef>;
  weapons: Record<string, WeaponDef>;
  unitClasses: Record<string, UnitClassDef>;
}
