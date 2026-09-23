/** Datalink propagation: fixed latency + distance / signal speed. */
import { distance } from '../core/math/vec3.js';
import { type Explanation, check, info } from '../core/explain.js';
import type { SimTime } from '../core/time.js';
import type { Command } from '../events/types.js';
import type { WorldState } from '../state/types.js';
import { type Ctx, trackOf } from './world.js';
import { positionAt } from './kinematics.js';

export function checkTransmit(
  ctx: Ctx,
  s: WorldState,
  cmd: Extract<Command, { type: 'TRANSMIT' }>,
): { ok: boolean; checks: Explanation[]; deliverAt?: SimTime } {
  const link = ctx.scenario.datalinks.find((l) => l.id === cmd.linkId);
  const from = s.units[cmd.from];
  const to = s.units[cmd.to];
  const checks: Explanation[] = [];
  checks.push(check(`数据链 ${cmd.linkId} 存在`, !!link));
  checks.push(check(`发送方 ${cmd.from} 存在且可用`, !!from && from.status !== 'destroyed' && from.status !== 'disabled'));
  checks.push(check(`接收方 ${cmd.to} 存在`, !!to && to.status !== 'destroyed'));
  if (!link || !from || !to) return { ok: false, checks };
  checks.push(check('收发双方同属该链路所属阵营', link.side === from.side && link.side === to.side));
  checks.push(check('收发双方都是链路成员', link.members.includes(from.id) && link.members.includes(to.id)));
  checks.push(check('收发方不同', from.id !== to.id));
  const tr = trackOf(s, from.id, cmd.trackId);
  checks.push(check(`发送方掌握航迹 ${cmd.trackId}`, !!tr));
  const d = distance(positionAt(from.motion, s.time), positionAt(to.motion, s.time));
  if (link.maxRangeM !== undefined)
    checks.push(check(`链路距离 ${(d / 1000).toFixed(1)} km ≤ ${(link.maxRangeM / 1000).toFixed(1)} km`, d <= link.maxRangeM));
  const delayS = link.latencyS + d / ctx.scenario.signalSpeedMps;
  const ok = checks.every((c) => c.ok !== false);
  checks.push(
    info(`传播延迟 ${delayS.toFixed(3)} s`, {
      children: [info(`链路固有延迟 ${link.latencyS} s`), info(`信号传播 ${(d / 1000).toFixed(1)} km ÷ ${ctx.scenario.signalSpeedMps} m/s`)],
    }),
  );
  return { ok, checks, deliverAt: s.time + Math.ceil(delayS * 1000) };
}
