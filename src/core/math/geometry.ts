import { type Vec3, sub, dot, add, scale, length, normalize, DEG } from './vec3.js';

export interface Sphere {
  center: Vec3;
  radiusM: number;
}

/** Distance from point p to the segment a→b. */
export function pointSegmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  let t = len2 < 1e-12 ? 0 : dot(sub(p, a), ab) / len2;
  t = Math.max(0, Math.min(1, t));
  return length(sub(add(a, scale(ab, t)), p));
}

/** True when the straight segment a→b passes through the sphere. */
export function segmentHitsSphere(a: Vec3, b: Vec3, s: Sphere): boolean {
  return pointSegmentDistance(s.center, a, b) < s.radiusM;
}

/** Body-frame azimuth/elevation (deg). Body frame: +X forward, +Y left, +Z up; azimuth positive to port. */
export function azEl(bodyDir: Vec3): { az: number; el: number } {
  const d = normalize(bodyDir);
  return {
    az: Math.atan2(d[1], d[0]) * DEG,
    el: Math.asin(Math.max(-1, Math.min(1, d[2]))) * DEG,
  };
}

/** Signed distance of point p above the plane (origin, normal). */
export function heightAbovePlane(p: Vec3, origin: Vec3, normal: Vec3): number {
  return dot(sub(p, origin), normalize(normal));
}

/** Projection of point p onto the plane (origin, normal). */
export function projectOntoPlane(p: Vec3, origin: Vec3, normal: Vec3): Vec3 {
  const n = normalize(normal);
  return sub(p, scale(n, dot(sub(p, origin), n)));
}
