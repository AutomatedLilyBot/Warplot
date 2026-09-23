/**
 * Static definitions loaded from /data and /scenarios. Distances in metres,
 * durations in seconds, angles in degrees. Runtime state uses SimTime (ms).
 */
import type { Vec3 } from '../core/math/vec3.js';
import type { Quat } from '../core/math/quat.js';

export type SideId = string;
export type UnitId = string;

/** Discrete track quality ladder. Order matters: later = better. */
export const TRACK_QUALITIES = [
  'NONE',
  'DETECTED',
  'BEARING_ONLY',
  'LOCALIZED',
  'CLASSIFIED',
  'WEAPON_SUPPORT',
  'FIRE_CONTROL',
] as const;
export type TrackQuality = (typeof TRACK_QUALITIES)[number];
export const qualityRank = (q: TrackQuality): number => TRACK_QUALITIES.indexOf(q);
export const qualityAtLeast = (q: TrackQuality, min: TrackQuality): boolean => qualityRank(q) >= qualityRank(min);

export interface SensorDef {
  id: string;
  name: string;
  kind: 'radar' | 'eo' | 'esm' | 'other';
  /** Nominal geometric detection range against a signature-1.0 target. */
  rangeM: number;
  /** Best track quality this sensor alone can establish. */
  maxQuality: TrackQuality;
  /** Radar-like sensors emit while on (makes the carrier detectable by ESM). */
  emits: boolean;
  /** ESM-like sensors can only detect targets that are emitting. */
  requiresTargetEmission?: boolean;
  /** Position uncertainty reported on tracks this sensor holds. */
  uncertaintyM: number;
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
  requiredQuality: TrackQuality;
  /** Track may be at most this old (s) when the weapon is committed. */
  maxTrackAgeS: number;
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
  category: 'ship' | 'uav' | 'aew';
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
}

export interface Catalog {
  sensors: Record<string, SensorDef>;
  weapons: Record<string, WeaponDef>;
  unitClasses: Record<string, UnitClassDef>;
}
