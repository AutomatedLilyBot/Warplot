/**
 * Measurement and track-uncertainty rules.
 *
 * A measurement's mean is the unbiased estimate of the true state plus an
 * optional author offset; random error lives only in the covariance and is
 * never sampled. The author offset must stay inside the 95 % region of the
 * unbiased measurement (χ²₃ for position, χ²₂ for bearing).
 */
import { type Vec3, RAD, add, cross, length, normalize, scale, sub } from '../core/math/vec3.js';
import { type Mat3, diag3, inverse3, madd, mscale, mulVec, outer, symEigen, symmetrize, zero3 } from '../core/math/mat3.js';
import { CHI2_95, probInSphere } from '../core/math/stats.js';
import type { SimTime } from '../core/time.js';
import type { MeasurementModel, SensorDef } from '../state/defs.js';
import type { SensorHold, Track, TrackSpatial } from '../state/types.js';

/** Default unknown manoeuvre: 1σ velocity drift of 2 m/s per √minute. */
export const DEFAULT_VELOCITY_DRIFT_MPS_PER_MIN = 2;

/** The parts of a track that define its estimate. */
export type TrackEstimate = Pick<Track, 'spatial' | 'observedAt'>;
const MIN_CROSS_SIGMA_M = 1e-3;

/** Author offset as entered: metres along [radial, cross, up] or degrees in [azimuth, elevation]. */
export interface MeasurementOffset {
  radialM?: number;
  crossM?: number;
  upM?: number;
  azDeg?: number;
  elDeg?: number;
}

/** Observation frame: line of sight u, horizontal right e1, "up" e2 (right-handed, e2 ⟂ u). */
export function observationFrame(observer: Vec3, target: Vec3): { u: Vec3; e1: Vec3; e2: Vec3; rangeM: number } {
  const d = sub(target, observer);
  const rangeM = length(d);
  const u: Vec3 = rangeM > 1e-9 ? scale(d, 1 / rangeM) : [1, 0, 0];
  let e1 = normalize(cross(u, [0, 0, 1]));
  if (length(e1) < 0.5) e1 = normalize(cross(u, [0, 1, 0]));
  const e2 = cross(e1, u);
  return { u, e1, e2, rangeM };
}

/** Per-axis 1σ of one measurement in its observation frame. */
export function measurementSigmas(m: MeasurementModel, rangeM: number): number[] {
  const ang = m.angleSigmaDeg * RAD;
  if (m.kind === 'bearing') return [ang, ang];
  const crossM = Math.max(rangeM * ang, MIN_CROSS_SIGMA_M);
  return [m.rangeSigmaM, crossM, crossM];
}

/** Whiten an author offset for this sensor at this geometry; unknown axes are reported. */
export function whitenOffset(
  m: MeasurementModel,
  rangeM: number,
  o: MeasurementOffset,
): { w: number[]; chi2: number; limit: number; wrongAxes: string[] } {
  const sig = measurementSigmas(m, rangeM);
  const used = (keys: (keyof MeasurementOffset)[]) => keys.filter((k) => o[k] !== undefined && o[k] !== 0);
  if (m.kind === 'bearing') {
    const w = [((o.azDeg ?? 0) * RAD) / sig[0]!, ((o.elDeg ?? 0) * RAD) / sig[1]!];
    return { w, chi2: w[0]! ** 2 + w[1]! ** 2, limit: CHI2_95[2], wrongAxes: used(['radialM', 'crossM', 'upM']) };
  }
  const w = [(o.radialM ?? 0) / sig[0]!, (o.crossM ?? 0) / sig[1]!, (o.upM ?? 0) / sig[2]!];
  return { w, chi2: w.reduce((a, x) => a + x * x, 0), limit: CHI2_95[3], wrongAxes: used(['azDeg', 'elDeg']) };
}

/** Position measurement covariance Σ = σR² uuᵀ + σ⊥² (e1e1ᵀ + e2e2ᵀ). */
function positionCov(frame: ReturnType<typeof observationFrame>, sig: number[]): Mat3 {
  return madd(madd(mscale(outer(frame.u), sig[0]! ** 2), mscale(outer(frame.e1), sig[1]! ** 2)), mscale(outer(frame.e2), sig[2]! ** 2));
}

export interface HeldSensor {
  sensor: SensorDef;
  hold: SensorHold;
}

/**
 * Fuse the current measurements of every holding sensor of one platform.
 * Position measurements combine in information form (order-independent);
 * if none measures position the result is a bearing line.
 */
export function measureTrack(observer: Vec3, truthPos: Vec3, truthVel: Vec3, held: HeldSensor[]): TrackSpatial {
  const frame = observationFrame(observer, truthPos);
  const pos = held.filter((h) => h.sensor.measurement.kind === 'position');
  if (pos.length) {
    let info = zero3();
    let infoBias: Vec3 = [0, 0, 0];
    let velInfo = 0;
    for (const h of pos) {
      const m = h.sensor.measurement as Extract<MeasurementModel, { kind: 'position' }>;
      const sig = measurementSigmas(m, frame.rangeM);
      const w = h.hold.offsetW;
      const bias = add(add(scale(frame.u, (w[0] ?? 0) * sig[0]!), scale(frame.e1, (w[1] ?? 0) * sig[1]!)), scale(frame.e2, (w[2] ?? 0) * sig[2]!));
      const inv = inverse3(positionCov(frame, sig));
      info = madd(info, inv);
      infoBias = add(infoBias, mulVec(inv, bias));
      velInfo += 1 / m.velocitySigmaMps ** 2;
    }
    const posCov = symmetrize(inverse3(info));
    return {
      kind: 'LOCALIZED',
      position: add(truthPos, mulVec(posCov, infoBias)),
      velocity: [...truthVel] as Vec3,
      posCov,
      velCov: diag3(1 / velInfo, 1 / velInfo, 1 / velInfo),
    };
  }
  let infoSum = 0;
  let az = 0;
  let el = 0;
  for (const h of held) {
    const sig = measurementSigmas(h.sensor.measurement, frame.rangeM)[0]!;
    const i = 1 / sig ** 2;
    infoSum += i;
    az += i * (h.hold.offsetW[0] ?? 0) * sig;
    el += i * (h.hold.offsetW[1] ?? 0) * sig;
  }
  az /= infoSum;
  el /= infoSum;
  const direction = normalize(add(add(frame.u, scale(frame.e1, Math.tan(az))), scale(frame.e2, Math.tan(el))));
  return { kind: 'BEARING_ONLY', origin: [...observer] as Vec3, direction, angleSigmaRad: Math.sqrt(1 / infoSum) };
}

/** Dead-reckoned mean position of a localized track at time t. */
export function predictedPosition(tr: TrackEstimate, t: SimTime): Vec3 | null {
  if (tr.spatial.kind !== 'LOCALIZED') return null;
  const dt = (t - tr.observedAt) / 1000;
  return add(tr.spatial.position, scale(tr.spatial.velocity, dt));
}

/**
 * Σ(t) = Σp + Δt²Σv + q Δt³/3 · I — measured velocity error plus an unknown
 * manoeuvre modelled as white-noise acceleration (velocity random walk) with
 * spectral density q = drift² / 60 s.
 */
export function predictedCovariance(tr: TrackEstimate, t: SimTime, velocityDriftMpsPerMin: number): Mat3 | null {
  if (tr.spatial.kind !== 'LOCALIZED') return null;
  const dt = Math.abs(t - tr.observedAt) / 1000;
  const q = ((velocityDriftMpsPerMin ** 2) / 60) * dt ** 3 / 3;
  return symmetrize(madd(madd(tr.spatial.posCov, mscale(tr.spatial.velCov, dt * dt)), diag3(q, q, q)));
}

/** Semi-axes (m, descending) of the 95 % joint ellipsoid of a 3-D covariance. */
export function ellipsoid95(cov: Mat3): Vec3 {
  return symEigen(cov).values.map((l) => Math.sqrt(Math.max(l, 0) * CHI2_95[3])) as Vec3;
}

/** Probability that the true target lies within `radiusM` of the predicted mean. */
export const probWithin = (cov: Mat3, radiusM: number): number => probInSphere(cov, radiusM);

/** Short human description of a track's spatial structure. */
export function describeSpatial(sp: TrackSpatial): string {
  if (sp.kind === 'BEARING_ONLY') return `纯方位 σθ ${((sp.angleSigmaRad / RAD)).toPrecision(2)}°`;
  const a = ellipsoid95(sp.posCov);
  return `定位 95% 半轴 ${a.map(fmtM).join('/')}`;
}

export function describeMeasurement(m: MeasurementModel): string {
  return m.kind === 'bearing'
    ? `纯方位测量 σθ ${m.angleSigmaDeg}°`
    : `定位测量 σR ${m.rangeSigmaM} m · σθ ${m.angleSigmaDeg}° · σv ${m.velocitySigmaMps} m/s`;
}

export const fmtM = (m: number): string => (m >= 1000 ? `${(m / 1000).toPrecision(3)} km` : `${m.toPrecision(3)} m`);
