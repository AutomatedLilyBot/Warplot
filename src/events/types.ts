import type { SimTime } from '../core/time.js';
import type { Explanation } from '../core/explain.js';
import type { Vec3 } from '../core/math/vec3.js';
import type { SideId, TrackQuality, UnitId, Waypoint } from '../state/defs.js';
import type { AttitudeConstraint, EntityId, GroupId, TrackId, UnitStatus } from '../state/types.js';

// ---------------------------------------------------------------------------
// Commands: the only inputs. The session log is a list of these.
// ---------------------------------------------------------------------------

export type Command =
  /** Advance time. Always stops at the next opportunity; with stopAtNotable also at deterministic notable events. */
  | { type: 'ADVANCE'; until?: SimTime; stopAtNotable?: boolean }
  | { type: 'SET_ROUTE'; unitId: UnitId; waypoints: Waypoint[] }
  | { type: 'SET_SENSOR'; unitId: UnitId; sensorId: string; on: boolean }
  | { type: 'TRANSMIT'; linkId: string; from: UnitId; to: UnitId; trackId: TrackId }
  /** Fire a salvo (anti-ship missiles or gun rounds) at a track; creates a missile group. */
  | { type: 'LAUNCH'; unitId: UnitId; mountId: string; weaponId: string; count: number; trackId: TrackId }
  /** Commit interceptors (SAM / CIWS) against a track of an incoming missile group. */
  | { type: 'ENGAGE'; unitId: UnitId; mountId: string; weaponId: string; trackId: TrackId; channels?: number }
  /** Ask the hull-attitude controller to bring a fixed mount onto a track. */
  | { type: 'ALIGN'; unitId: UnitId; mountId: string; trackId: TrackId; priority: number }
  /** A maneuver that claims hull resources (e.g. EVADE). */
  | {
      type: 'MANEUVER';
      unitId: UnitId;
      label: string;
      priority: number;
      durationS: number;
      attitude?: AttitudeConstraint;
      claimsTranslation?: boolean;
    }
  | { type: 'RELEASE_CLAIM'; unitId: UnitId; claimId: string }
  | { type: 'RESOLVE'; opportunityId: string; decision: Decision }
  | { type: 'SET_UNIT_STATUS'; unitId: UnitId; status: UnitStatus; note?: string }
  | { type: 'NOTE'; text: string };

export type NotDetectedReason = 'clutter' | 'attention' | 'emission_control' | 'sensor_degradation' | 'other';

export type Decision =
  | {
      kind: 'detection';
      detected: true;
      quality: TrackQuality;
      classification?: string;
      /** Merge into an existing track of the observer instead of creating a new one. */
      correlateWith?: TrackId;
    }
  | { kind: 'detection'; detected: false; reason: NotDetectedReason; note?: string }
  | { kind: 'intercept'; intercepted: number; note?: string }
  | { kind: 'impact'; hits: number; note?: string };

// ---------------------------------------------------------------------------
// Opportunities: uncertain outcomes surfaced to the author, never auto-rolled.
// They are author-level (truth) objects and are never shown in side views.
// ---------------------------------------------------------------------------

interface OpportunityBase {
  id: string;
  side: SideId;
  time: SimTime;
  status: 'pending' | 'resolved';
  explanation: Explanation;
  eventId: string;
  resolution?: Decision;
}

export interface DetectionOpportunity extends OpportunityBase {
  kind: 'detection';
  observerId: UnitId;
  sensorId: string;
  target: EntityId;
  maxQuality: TrackQuality;
  /** Author hint: observer tracks that truth-map to the same entity. */
  sameAsTracks: TrackId[];
}

export interface InterceptOpportunity extends OpportunityBase {
  kind: 'intercept';
  engagementId: string;
  groupId: GroupId | null;
  bounds: { min: number; max: number };
}

export interface ImpactOpportunity extends OpportunityBase {
  kind: 'impact';
  groupId: GroupId;
  target: EntityId;
  bounds: { min: number; max: number };
}

export type Opportunity = DetectionOpportunity | InterceptOpportunity | ImpactOpportunity;

// ---------------------------------------------------------------------------
// Events: facts produced by the engine, with causal links.
// ---------------------------------------------------------------------------

export interface Fact {
  label: string;
  ref?: string;
}

/** A description of an event as seen by one audience. */
export interface EventBody {
  actor?: string;
  action: string;
  target?: string;
  summary: string;
  requires: Fact[];
  produces: Fact[];
  data?: Record<string, unknown>;
}

export type EventKind =
  | 'SCENARIO_START'
  | 'TIME_ADVANCED'
  | 'ROUTE_SET'
  | 'ROUTE_COMPLETE'
  | 'SENSOR_SET'
  | 'DETECTION_OPPORTUNITY'
  | 'DETECTION'
  | 'DETECTION_DECLINED'
  | 'TRACK_LOST'
  | 'TRANSMIT'
  | 'DELIVERY'
  | 'LAUNCH'
  | 'ENGAGE'
  | 'INTERCEPT_OPPORTUNITY'
  | 'INTERCEPT'
  | 'IMPACT_OPPORTUNITY'
  | 'IMPACT'
  | 'GROUP_EXPENDED'
  | 'CLAIM_ADDED'
  | 'CLAIM_SUSPENDED'
  | 'CLAIM_RESUMED'
  | 'CLAIM_RELEASED'
  | 'UNIT_STATUS'
  | 'NOTE';

export interface SimEvent {
  id: string;
  time: SimTime;
  kind: EventKind;
  /** Index of the command (in the branch's command list) that produced this event. */
  commandIndex: number;
  causedBy: string[];
  /** God-view description. */
  truth: EventBody;
  /** Per-side descriptions; a side without an entry does not see the event at all. */
  sides: Record<SideId, EventBody>;
  /** Deterministic events that should halt ADVANCE when stopAtNotable is set. */
  notable?: boolean;
}

export interface Verdict {
  ok: boolean;
  checks: Explanation[];
  /** Earliest time the action could become legal, when the engine can tell. */
  earliest?: SimTime;
}

export interface ApplyResult {
  ok: boolean;
  verdict: Verdict;
  events: SimEvent[];
}

export type { Vec3 };
