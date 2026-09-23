/** Firing arcs: VLS (omni), turrets (own az/el freedom + blind zones), fixed mounts (hull attitude). */
import { type Vec3, angleDeg, normalize, sub } from '../core/math/vec3.js';
import { quatConjugate, rotate } from '../core/math/quat.js';
import { azEl } from '../core/math/geometry.js';
import { type Explanation, check } from '../core/explain.js';
import type { SimTime } from '../core/time.js';
import type { MountDef } from '../state/defs.js';
import type { UnitState } from '../state/types.js';
import { type Ctx, orientationAt } from './world.js';
import { positionAt } from './kinematics.js';

export interface ArcResult {
  ok: boolean;
  checks: Explanation[];
  /** Turret: seconds of training needed before the round can leave. */
  trainS?: number;
  /** Fixed mount: current bore error. */
  errorDeg?: number;
  body?: { az: number; el: number };
}

const inRange = (x: number, [a, b]: [number, number]) => x >= a && x <= b;

/** Can this mount point at world point `target` at time t? */
export function arcCheck(ctx: Ctx, u: UnitState, mount: MountDef, target: Vec3, t: SimTime): ArcResult {
  const worldDir = normalize(sub(target, positionAt(u.motion, t)));
  const q = orientationAt(ctx, u, t);
  const bodyDir = rotate(quatConjugate(q), worldDir);
  const { az, el } = azEl(bodyDir);

  switch (mount.kind) {
    case 'vls':
      return { ok: true, checks: [check(`${mount.name}: 垂直发射，全向射界`, true)], body: { az, el } };
    case 'turret': {
      const azOk = inRange(az, mount.azimuthDeg);
      const elOk = inRange(el, mount.elevationDeg);
      const blind = (mount.blindZones ?? []).find((z) => inRange(az, z.azDeg) && inRange(el, z.elDeg));
      const cur = u.mounts[mount.id]?.pointing ?? { az: 0, el: 0 };
      const trainS = Math.max(Math.abs(az - cur.az), Math.abs(el - cur.el)) / mount.traverseRateDegS;
      const checks = [
        check(`${mount.name} 方位 ${az.toFixed(1)}° ∈ [${mount.azimuthDeg.join(', ')}]`, azOk),
        check(`${mount.name} 俯仰 ${el.toFixed(1)}° ∈ [${mount.elevationDeg.join(', ')}]`, elOk),
        check(blind ? `${mount.name} 被遮挡: ${blind.label}` : `${mount.name} 无遮挡`, !blind),
      ];
      return { ok: azOk && elOk && !blind, checks, trainS, body: { az, el } };
    }
    case 'fixed': {
      const bore = rotate(q, normalize(mount.boresight));
      const err = angleDeg(bore, worldDir);
      const ok = err <= mount.halfAngleDeg;
      return {
        ok,
        checks: [check(`${mount.name} 轴线误差 ${err.toFixed(2)}° ≤ ${mount.halfAngleDeg}°（依赖舰体姿态）`, ok)],
        errorDeg: err,
        body: { az, el },
      };
    }
  }
}
