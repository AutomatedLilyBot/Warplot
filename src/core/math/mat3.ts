/**
 * Row-major 3×3 matrix as a plain tuple (JSON-serialisable like Vec3).
 * Used for position/velocity covariances; all routines are deterministic.
 */
import type { Vec3 } from './vec3.js';

export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const zero3 = (): Mat3 => [0, 0, 0, 0, 0, 0, 0, 0, 0];
export const diag3 = (a: number, b: number, c: number): Mat3 => [a, 0, 0, 0, b, 0, 0, 0, c];
export const identity3 = (): Mat3 => diag3(1, 1, 1);

export const madd = (a: Mat3, b: Mat3): Mat3 => a.map((x, i) => x + b[i]!) as Mat3;
export const mscale = (a: Mat3, s: number): Mat3 => a.map((x) => x * s) as Mat3;
export const transpose3 = (a: Mat3): Mat3 => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];

export function mmul(a: Mat3, b: Mat3): Mat3 {
  const r = zero3();
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
  return r;
}

export const mulVec = (a: Mat3, v: Vec3): Vec3 => [
  a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
  a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
  a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
];

/** v vᵀ */
export const outer = (v: Vec3): Mat3 => [
  v[0] * v[0], v[0] * v[1], v[0] * v[2],
  v[1] * v[0], v[1] * v[1], v[1] * v[2],
  v[2] * v[0], v[2] * v[1], v[2] * v[2],
];

export const det3 = (a: Mat3): number =>
  a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);

/** Inverse via the adjugate. Throws on a singular matrix. */
export function inverse3(a: Mat3): Mat3 {
  const d = det3(a);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-300) throw new Error('singular matrix');
  const adj: Mat3 = [
    a[4] * a[8] - a[5] * a[7], a[2] * a[7] - a[1] * a[8], a[1] * a[5] - a[2] * a[4],
    a[5] * a[6] - a[3] * a[8], a[0] * a[8] - a[2] * a[6], a[2] * a[3] - a[0] * a[5],
    a[3] * a[7] - a[4] * a[6], a[1] * a[6] - a[0] * a[7], a[0] * a[4] - a[1] * a[3],
  ];
  return mscale(adj, 1 / d);
}

/** vᵀ A v */
export const quadForm = (a: Mat3, v: Vec3): number => {
  const w = mulVec(a, v);
  return v[0] * w[0] + v[1] * w[1] + v[2] * w[2];
};

/** Force exact symmetry (guards against round-off drift). */
export const symmetrize = (a: Mat3): Mat3 => mscale(madd(a, transpose3(a)), 0.5);

/**
 * Eigen-decomposition of a symmetric matrix by cyclic Jacobi rotations
 * (fixed sweep limit → deterministic). Eigenvalues sorted descending;
 * vectors[i] is the unit eigenvector of values[i].
 */
export function symEigen(m: Mat3): { values: Vec3; vectors: [Vec3, Vec3, Vec3] } {
  const a = [
    [m[0], m[1], m[2]],
    [m[3], m[4], m[5]],
    [m[6], m[7], m[8]],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const A = (i: number, j: number) => a[i]![j]!;
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = A(0, 1) ** 2 + A(0, 2) ** 2 + A(1, 2) ** 2;
    const scale = A(0, 0) ** 2 + A(1, 1) ** 2 + A(2, 2) ** 2;
    if (off <= 1e-30 * Math.max(scale, 1e-300)) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = A(p, q);
      if (apq === 0) continue;
      const theta = (A(q, q) - A(p, p)) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = A(k, p);
        const akq = A(k, q);
        a[k]![p] = c * akp - s * akq;
        a[k]![q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = A(p, k);
        const aqk = A(q, k);
        a[p]![k] = c * apk - s * aqk;
        a[q]![k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k]![p]!;
        const vkq = v[k]![q]!;
        v[k]![p] = c * vkp - s * vkq;
        v[k]![q] = s * vkp + c * vkq;
      }
    }
  }
  const idx = [0, 1, 2].sort((i, j) => A(j, j) - A(i, i));
  const values = idx.map((i) => A(i, i)) as Vec3;
  const vectors = idx.map((i) => [v[0]![i]!, v[1]![i]!, v[2]![i]!] as Vec3) as [Vec3, Vec3, Vec3];
  return { values, vectors };
}
