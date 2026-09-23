/**
 * Human-readable chronicle of a world state's event log — the "fact layer" an
 * author reads while writing. God view shows truth bodies; a side view shows
 * only what that side saw, with side-local event ids.
 */
import { formatClock, parseClock } from '../core/time.js';
import type { Ctx } from '../rules/world.js';
import type { WorldState } from '../state/types.js';
import type { EventBody, SimEvent } from './types.js';
import { projectSideView } from '../state/view.js';

export interface ChronicleOptions {
  /** Only events with index ≥ this in the log. */
  fromIndex?: number;
  /** Print requires/produces facts and causal links. */
  facts?: boolean;
}

function line(clock: string, id: string, kind: string, b: EventBody, causedBy: string[], facts: boolean): string[] {
  const out = [`[${clock}] ${id.padEnd(9)} ${kind.padEnd(22)} ${b.summary}`];
  if (!facts) return out;
  const pad = ' '.repeat(12);
  if (causedBy.length) out.push(`${pad}← ${causedBy.join(', ')}`);
  for (const f of b.requires) out.push(`${pad}需要: ${f.label}${f.ref ? ` (${f.ref})` : ''}`);
  for (const f of b.produces) out.push(`${pad}产生: ${f.label}`);
  return out;
}

export function chronicle(ctx: Ctx, s: WorldState, view: 'god' | string = 'god', opts: ChronicleOptions = {}): string {
  const epoch = parseClock(ctx.scenario.epoch);
  const clock = (t: number) => formatClock(t, epoch);
  const facts = opts.facts ?? false;
  if (view === 'god') {
    return s.log
      .slice(opts.fromIndex ?? 0)
      .flatMap((e: SimEvent) => line(clock(e.time), e.id, e.kind, e.truth, e.causedBy, facts))
      .join('\n');
  }
  const visibleBefore = s.log.slice(0, opts.fromIndex ?? 0).filter((e) => e.sides[view]).length;
  return projectSideView(ctx, s, view)
    .events.slice(visibleBefore)
    .flatMap((e) => line(clock(e.time), e.id, e.kind, e, e.causedBy, facts))
    .join('\n');
}
