/**
 * Runtime world state. It is *derived*: state = replay(initial, commands).
 * Nothing here is ever edited directly by the UI.
 */
import type { Vec3 } from '../core/math/vec3.js';
import type { Quat } from '../core/math/quat.js';
import type { SimTime } from '../core/time.js';
import type { Explanation } from '../core/explain.js';
import type { Mat3 } from '../core/math/mat3.js';
import type { Identity, SideId, TargetCategory, UnitId, Waypoint } from './defs.js';
import type { SimEvent, Opportunity } from '../events/types.js';

export type TrackId = string;
export type GroupId = string;
/** Truth-level reference to anything that can be sensed: a unit or a missile group. */
export type EntityId = string;

/** One constant-acceleration piece of a straight-leg trajectory. */
export interface MotionSegment {
  t0: SimTime;
  /** null = open-ended (keeps going). */
  t1: SimTime | null;
  p0: Vec3;
  dir: Vec3;
  v0: number;
  a: number;
}

export interface MotionPlan {
  segments: MotionSegment[];
  route: Waypoint[];
  /** Time the final waypoint is reached (null if no route or open-ended). */
  arrivesAt: SimTime | null;
}

/** Constant-rate slerp from q0 toward goal starting at t0. */
export interface AttitudeState {
  t0: SimTime;
  q0: Quat;
  goal: Quat | null;
}

export type AttitudeTarget = { kind: 'track'; trackId: TrackId } | { kind: 'direction'; dir: Vec3 };

export type AttitudeConstraint =
  | { kind: 'axis_cone'; bodyAxis: Vec3; target: AttitudeTarget; halfAngleDeg: number }
  | { kind: 'exclusive' };

export interface ResourceClaim {
  id: string;
  resource: string;
  owner: { kind: 'mount' | 'maneuver' | 'engagement'; id: string; label: string };
  priority: number;
  amount?: number;
  constraint?: AttitudeConstraint;
  since: SimTime;
  until: SimTime | null;
  status: 'active' | 'suspended';
}

export interface MountState {
  ammo: Record<string, number>;
  busyUntil: SimTime;
  /** Turret pointing (body az/el) after its last action. */
  pointing?: { az: number; el: number };
}

export type UnitStatus = 'active' | 'damaged' | 'disabled' | 'destroyed';

export interface UnitState {
  id: UnitId;
  name: string;
  side: SideId;
  classId: string;
  status: UnitStatus;
  motion: MotionPlan;
  attitude: AttitudeState;
  sensorsOn: Record<string, boolean>;
  mounts: Record<string, MountState>;
  claims: ResourceClaim[];
  hitsTaken: number;
}

export interface MissileGroupState {
  id: GroupId;
  side: SideId;
  weaponId: string;
  initialCount: number;
  count: number;
  launcherId: UnitId;
  mountId: string;
  targetTrackId: TrackId;
  launchTime: SimTime;
  origin: Vec3;
  aimPoint: Vec3;
  speedMps: number;
  arrivalTime: SimTime;
  /** flying → arrived (awaiting impact ruling) → expended. */
  status: 'flying' | 'arrived' | 'expended';
  intercepted: number;
  hits: number;
  misses: number;
  launchEventId: string;
}

/**
 * Spatial state of a track. Only two structures exist; how good a fix is
 * lives in the covariance, not in a discrete grade.
 */
export type TrackSpatial =
  /** Line of sight from `origin`; isotropic 1σ angular error. */
  | { kind: 'BEARING_ONLY'; origin: Vec3; direction: Vec3; angleSigmaRad: number }
  /** Position/velocity estimate with covariances (m², (m/s)²) valid at `observedAt`. */
  | { kind: 'LOCALIZED'; position: Vec3; velocity: Vec3; posCov: Mat3; velCov: Mat3 };

/** What the side believes the contact is — independent of how well it is located. */
export interface ClassificationState {
  category?: TargetCategory;
  label?: string;
  identity: Identity;
  /** Confidence in this classification, 0–1. */
  confidence: number;
}

/**
 * One own sensor currently holding the contact. `offsetW` is the author's
 * measurement offset in whitened coordinates (units of σ along the
 * measurement axes: [radial, cross, up] or [azimuth, elevation]); it stays
 * inside the 95 % region as the geometry changes.
 */
export interface SensorHold {
  offsetW: number[];
}

/** What one platform believes about one contact. Never contains truth ids. */
export interface Track {
  id: TrackId;
  side: SideId;
  /** Probability that the contact exists (author-ruled for now). */
  existence: number;
  spatial: TrackSpatial;
  classification: ClassificationState | null;
  /** Time the underlying observation describes. */
  observedAt: SimTime;
  /** Time this platform received it (later than observedAt for datalink copies). */
  receivedAt: SimTime;
  /** Own sensors currently holding the contact. While non-empty the estimate refreshes at every event boundary. */
  holds: Record<string, SensorHold>;
  /** Events that established / updated this platform's copy (detection, delivery...). */
  provenance: string[];
}

export interface PendingMessage {
  id: string;
  side: SideId;
  linkId: string;
  from: UnitId;
  to: UnitId;
  sentAt: SimTime;
  deliverAt: SimTime;
  track: Track;
  sendEventId: string;
}

export interface Engagement {
  id: string;
  side: SideId;
  unitId: UnitId;
  mountId: string;
  weaponId: string;
  trackId: TrackId;
  channels: number;
  window: { start: SimTime; end: SimTime };
  engagements: number;
  roundsCommitted: number;
  bounds: { min: number; max: number };
  explanation: Explanation;
  status: 'scheduled' | 'resolved';
  claimIds: string[];
  commandEventId: string;
  interceptedCount?: number;
}

/** Hidden referee data. Never exported into a side view. */
export interface TruthLedger {
  trackTargets: Record<TrackId, EntityId>;
}

export interface WorldState {
  scenarioId: string;
  time: SimTime;
  /** Counters keyed by "<side>:<kind>" or "global:<kind>" so ids never leak cross-side activity. */
  seq: Record<string, number>;
  units: Record<UnitId, UnitState>;
  groups: Record<GroupId, MissileGroupState>;
  /** Per-platform knowledge: platform → track id → track. */
  knowledge: Record<UnitId, Record<TrackId, Track>>;
  truth: TruthLedger;
  messages: PendingMessage[];
  engagements: Record<string, Engagement>;
  opportunities: Record<string, Opportunity>;
  /** "<unit>|<sensor>|<entity>" → time a detection chance was last offered. */
  lastOffered: Record<string, SimTime>;
  /** Scheduled route completions already reported, keyed unit id → arrival time. */
  reportedArrivals: Record<UnitId, SimTime>;
  log: SimEvent[];
}
