/**
 * Causal chains over an event log (god log or a side's projected log). Pure.
 * Causes follow `causedBy` and `requires[].ref`; effects are the reverse.
 * The chain is a DAG; it is flattened into a depth-first tree where a node
 * already shown is listed again with `repeat` and not expanded.
 */

export interface CausalEvent {
  id: string;
  time: number;
  kind: string;
  summary: string;
  causedBy: string[];
  /** Fact references (requires[].ref) — also causes. */
  refs: string[];
}

export interface CausalNode {
  event: CausalEvent;
  depth: number;
  repeat: boolean;
}

export interface CausalGraph {
  focus: CausalEvent;
  causes: CausalNode[];
  effects: CausalNode[];
}

function walk(start: string, next: (id: string) => string[], byId: Map<string, CausalEvent>, maxDepth: number): CausalNode[] {
  const out: CausalNode[] = [];
  const seen = new Set<string>([start]);
  const visit = (id: string, depth: number) => {
    for (const nid of next(id)) {
      const ev = byId.get(nid);
      if (!ev) continue;
      const repeat = seen.has(nid);
      out.push({ event: ev, depth, repeat });
      if (repeat || depth >= maxDepth) continue;
      seen.add(nid);
      visit(nid, depth + 1);
    }
  };
  visit(start, 1);
  return out;
}

export function causalGraph(events: CausalEvent[], id: string, maxDepth = 12): CausalGraph | null {
  const byId = new Map(events.map((e) => [e.id, e]));
  const focus = byId.get(id);
  if (!focus) return null;
  const causesOf = (x: string) => {
    const e = byId.get(x)!;
    return [...new Set([...e.causedBy, ...e.refs])].filter((c) => c !== x);
  };
  const effectsIndex = new Map<string, string[]>();
  for (const e of events)
    for (const c of new Set([...e.causedBy, ...e.refs])) if (c !== e.id) effectsIndex.set(c, [...(effectsIndex.get(c) ?? []), e.id]);
  return {
    focus,
    causes: walk(id, causesOf, byId, maxDepth),
    effects: walk(id, (x) => effectsIndex.get(x) ?? [], byId, maxDepth),
  };
}
