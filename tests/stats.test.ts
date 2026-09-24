import { describe, expect, test } from 'vitest';
import { type Mat3, diag3, inverse3, mmul, symEigen, identity3 } from '../src/core/math/mat3.js';
import { CHI2_95, chi2Cdf, mahalanobis2, probInSphere } from '../src/core/math/stats.js';

describe('mat3', () => {
  test('inverse and symmetric eigen-decomposition', () => {
    const m: Mat3 = [4, 1, 0.5, 1, 3, 0.2, 0.5, 0.2, 2];
    const p = mmul(m, inverse3(m));
    identity3().forEach((x, i) => expect(p[i]).toBeCloseTo(x, 12));
    const { values, vectors } = symEigen(m);
    expect(values[0]).toBeGreaterThanOrEqual(values[1]);
    expect(values[1]).toBeGreaterThanOrEqual(values[2]);
    for (let i = 0; i < 3; i++) {
      const v = vectors[i]!;
      const mv = [0, 1, 2].map((r) => m[r * 3]! * v[0] + m[r * 3 + 1]! * v[1] + m[r * 3 + 2]! * v[2]);
      mv.forEach((x, k) => expect(x).toBeCloseTo(values[i]! * v[k]!, 10));
    }
    expect(values.reduce((a, b) => a + b, 0)).toBeCloseTo(9, 10);
  });
});

describe('stats', () => {
  test('χ² quantiles and CDFs', () => {
    expect(chi2Cdf(CHI2_95[3], 3)).toBeCloseTo(0.95, 10);
    expect(chi2Cdf(CHI2_95[2], 2)).toBeCloseTo(0.95, 10);
    expect(chi2Cdf(3, 2)).toBeCloseTo(1 - Math.exp(-1.5), 12);
    expect(mahalanobis2([3, 0, 4], diag3(9, 1, 16))).toBeCloseTo(2, 12);
  });

  test('isotropic sphere probability equals χ²₃ CDF', () => {
    expect(probInSphere(diag3(4, 4, 4), 5)).toBeCloseTo(chi2Cdf(25 / 4, 3), 10);
  });

  test('anisotropic sphere probability matches numerical integration', () => {
    const [a, b, c] = [100, 9, 1]; // variances
    const r = 12;
    // Midpoint rule over the ball in the eigenbasis.
    const n = 120;
    const h = (2 * r) / n;
    let p = 0;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        for (let k = 0; k < n; k++) {
          const x = -r + (i + 0.5) * h;
          const y = -r + (j + 0.5) * h;
          const z = -r + (k + 0.5) * h;
          if (x * x + y * y + z * z > r * r) continue;
          p += Math.exp(-0.5 * (x * x / a + y * y / b + z * z / c));
        }
    p *= (h * h * h) / Math.sqrt((2 * Math.PI) ** 3 * a * b * c);
    expect(probInSphere(diag3(a, b, c), r)).toBeCloseTo(p, 2);
  });
});
