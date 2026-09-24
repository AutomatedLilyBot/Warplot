/**
 * Deterministic statistics for track uncertainty: χ² quantiles, χ² CDFs and
 * the probability that a zero-mean 3-D Gaussian lies inside a sphere.
 * Nothing here samples random numbers.
 */
import type { Vec3 } from './vec3.js';
import { type Mat3, inverse3, quadForm, symEigen } from './mat3.js';

/** 95 % quantiles of χ² with 2 and 3 degrees of freedom. */
export const CHI2_95 = { 2: 5.991464547107979, 3: 7.814727903251178 } as const;

/** Squared Mahalanobis distance bᵀ Σ⁻¹ b. */
export const mahalanobis2 = (b: Vec3, cov: Mat3): number => quadForm(inverse3(cov), b);

function lnGamma(x: number): number {
  // Lanczos approximation (g = 7, n = 9).
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularised lower incomplete gamma P(a, x) (series / continued fraction). */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (!Number.isFinite(x)) return 1;
  const lg = lnGamma(a);
  if (x < a + 1) {
    let sum = 1 / a;
    let del = sum;
    let ap = a;
    for (let n = 0; n < 1000; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return Math.min(1, sum * Math.exp(-x + a * Math.log(x) - lg));
  }
  // Lentz continued fraction for Q(a, x).
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.max(0, 1 - Math.exp(-x + a * Math.log(x) - lg) * h);
}

/** CDF of χ² with k degrees of freedom. */
export const chi2Cdf = (x: number, k: number): number => gammaP(k / 2, x / 2);

/**
 * P(‖x‖ ≤ r) for x ~ N(0, Σ) in 3-D. Uses Ruben's series for a positive
 * quadratic form Σ λᵢ zᵢ² with a fixed iteration cap (deterministic).
 */
export function probInSphere(cov: Mat3, r: number): number {
  if (r <= 0) return 0;
  const { values } = symEigen(cov);
  const lmax = Math.max(values[0], 1e-300);
  const lam = values.map((l) => Math.max(l, lmax * 1e-12));
  const beta = Math.min(...lam);
  const gam = lam.map((l) => 1 - beta / l);
  const x = (r * r) / beta;
  const c: number[] = [lam.reduce((p, l) => p * Math.sqrt(beta / l), 1)];
  const g: number[] = [0];
  let total = c[0]! * chi2Cdf(x, 3);
  let mass = c[0]!;
  for (let k = 1; k < 2000 && 1 - mass > 1e-12; k++) {
    g[k] = 0.5 * gam.reduce((s, y) => s + y ** k, 0);
    let ck = 0;
    for (let j = 0; j < k; j++) ck += g[k - j]! * c[j]!;
    c[k] = ck / k;
    mass += c[k]!;
    total += c[k]! * chi2Cdf(x, 3 + 2 * k);
  }
  return Math.min(1, Math.max(0, total));
}
