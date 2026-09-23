/**
 * Event-time search. We never tick the world; instead we ask "when does this
 * predicate first flip?" using conservative advancement: each probe returns a
 * safe step during which the predicate cannot possibly change (e.g. gap to
 * range ÷ max closing speed). Crossings are refined to 1 ms by bisection.
 */
import type { SimTime } from '../core/time.js';

export interface Probe {
  ok: boolean;
  /** Time (ms) guaranteed to elapse before `ok` could change. */
  safeStepMs: number;
}

const MIN_STEP = 20;
const MAX_ITERS = 200_000;

/** First t in (t0, tMax] where probe(t).ok === want. Assumes probe(t0).ok !== want. */
export function firstFlip(probe: (t: SimTime) => Probe, t0: SimTime, tMax: SimTime, want: boolean): SimTime | null {
  let t = t0;
  let p = probe(t);
  if (p.ok === want) return t0;
  for (let i = 0; i < MAX_ITERS && t < tMax; i++) {
    const next = Math.min(tMax, t + Math.max(MIN_STEP, Math.floor(p.safeStepMs)));
    const pn = probe(next);
    if (pn.ok === want) {
      let lo = t;
      let hi = next;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (probe(mid).ok === want) hi = mid;
        else lo = mid;
      }
      return hi;
    }
    t = next;
    p = pn;
  }
  return null;
}

/** First t ≥ t0 where probe is true (t0 itself counts). */
export function firstTrue(probe: (t: SimTime) => Probe, t0: SimTime, tMax: SimTime): SimTime | null {
  return firstFlip(probe, t0, tMax, true);
}

/** Maximal interval [start, end) starting at the first true time, bounded by tMax. */
export function firstWindow(
  probe: (t: SimTime) => Probe,
  t0: SimTime,
  tMax: SimTime,
): { start: SimTime; end: SimTime } | null {
  const start = firstTrue(probe, t0, tMax);
  if (start === null || start >= tMax) return null;
  const end = firstFlip(probe, start, tMax, false) ?? tMax;
  return end > start ? { start, end } : null;
}

/** Safe step for a distance-vs-threshold predicate. */
export function rangeStep(dist: number, thresholdM: number, closingMaxMps: number): number {
  if (closingMaxMps <= 0) return Infinity;
  return (Math.abs(dist - thresholdM) / closingMaxMps) * 1000;
}
