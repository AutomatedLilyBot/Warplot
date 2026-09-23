/**
 * Render-space conventions (pure, no Three.js):
 *  - world: metres, +Z up (same as the core)
 *  - render: kilometres relative to a floating local origin, so WebGL floats
 *    stay small no matter how large world coordinates are:
 *      render = (world − localOrigin) / 1000
 *  - reference plane: origin + normal, with an in-plane basis (u, v)
 */
import { type Vec3, cross, dot, normalize, scale, sub, add } from '../core/math/vec3.js';

export const RENDER_SCALE = 1 / 1000;

export function toRender(world: Vec3, localOrigin: Vec3): Vec3 {
  return scale(sub(world, localOrigin), RENDER_SCALE);
}

export function toWorld(render: Vec3, localOrigin: Vec3): Vec3 {
  return add(scale(render, 1 / RENDER_SCALE), localOrigin);
}

export interface PlaneFrame {
  origin: Vec3;
  normal: Vec3;
  /** In-plane "east-like" axis: world +X projected into the plane (or +Y if X is the normal). */
  u: Vec3;
  /** In-plane axis completing a right-handed (u, v, normal) triad. */
  v: Vec3;
}

export function planeFrame(origin: Vec3, normal: Vec3): PlaneFrame {
  const n = normalize(normal);
  const seed: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(sub(seed, scale(n, dot(seed, n))));
  const v = cross(n, u);
  return { origin, normal: n, u, v };
}

/** Plane coordinates (a, b, h) of a world point: p = origin + a·u + b·v + h·n. */
export function planeCoords(f: PlaneFrame, p: Vec3): Vec3 {
  const d = sub(p, f.origin);
  return [dot(d, f.u), dot(d, f.v), dot(d, f.normal)];
}

export function fromPlaneCoords(f: PlaneFrame, a: number, b: number, h = 0): Vec3 {
  return add(add(add(f.origin, scale(f.u, a)), scale(f.v, b)), scale(f.normal, h));
}

/** A "nice" grid step (1, 2, 5 × 10^k) giving roughly `divisions` lines across `span`. */
export function niceStep(span: number, divisions = 10): number {
  const raw = Math.max(span, 1e-9) / divisions;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
