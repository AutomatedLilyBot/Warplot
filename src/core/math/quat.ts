import { type Vec3, cross, dot, normalize, RAD, DEG, anyPerpendicular } from './vec3.js';

/** Quaternion [x, y, z, w]; rotates body-frame vectors into the world frame. */
export type Quat = [number, number, number, number];

export const IDENTITY: Quat = [0, 0, 0, 1];

export function quatNormalize(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return l < 1e-12 ? [0, 0, 0, 1] : [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export const quatConjugate = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

export function quatFromAxisAngle(axis: Vec3, angleDeg: number): Quat {
  const n = normalize(axis);
  const h = (angleDeg * RAD) / 2;
  const s = Math.sin(h);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(h)];
}

/** Rotate vector v by quaternion q. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const u: Vec3 = [q[0], q[1], q[2]];
  const w = q[3];
  const t = cross(u, v).map((c) => c * 2) as Vec3;
  const ct = cross(u, t);
  return [v[0] + w * t[0] + ct[0], v[1] + w * t[1] + ct[1], v[2] + w * t[2] + ct[2]];
}

/** Shortest-arc rotation taking unit vector `from` onto unit vector `to`. */
export function quatFromTo(from: Vec3, to: Vec3): Quat {
  const f = normalize(from);
  const t = normalize(to);
  const d = dot(f, t);
  if (d < -0.999999) return quatFromAxisAngle(anyPerpendicular(f), 180);
  const c = cross(f, t);
  return quatNormalize([c[0], c[1], c[2], 1 + d]);
}

/** Angle in degrees of the rotation separating two orientations. */
export function quatAngleDeg(a: Quat, b: Quat): number {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, d)) * DEG;
}

export function slerp(a: Quat, b: Quat, t: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb: Quat = b;
  if (d < 0) {
    d = -d;
    bb = [-b[0], -b[1], -b[2], -b[3]];
  }
  if (d > 0.99999) {
    return quatNormalize([
      a[0] + (bb[0] - a[0]) * t,
      a[1] + (bb[1] - a[1]) * t,
      a[2] + (bb[2] - a[2]) * t,
      a[3] + (bb[3] - a[3]) * t,
    ]);
  }
  const th = Math.acos(d);
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return [
    a[0] * wa + bb[0] * wb,
    a[1] * wa + bb[1] * wb,
    a[2] * wa + bb[2] * wb,
    a[3] * wa + bb[3] * wb,
  ];
}

/** Orientation whose body +X points along heading (deg, CCW from world +X in the XY plane). */
export function quatFromHeading(headingDeg: number): Quat {
  return quatFromAxisAngle([0, 0, 1], headingDeg);
}
