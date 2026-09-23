/**
 * Event-sourced session with branching.
 *
 * The session stores a tree of command nodes. A branch is a pointer to a node
 * (its head) plus a redo stack. State of any node = replay of the path from
 * the root. Snapshots are memoised in memory only; the serialised form is
 * just the command tree.
 */
import type { Command, ApplyResult, Verdict } from './types.js';
import type { WorldState } from '../state/types.js';
import type { Ctx } from '../rules/world.js';
import { applyCommand, createInitialState, validate } from './engine.js';

export interface CommandNode {
  id: string;
  parent: string | null;
  command: Command;
}

export interface Branch {
  id: string;
  name: string;
  head: string | null;
  /** Nodes undone on this branch, most recent last. */
  redo: string[];
  forkedFrom: { branch: string; node: string | null } | null;
}

export interface SessionData {
  scenarioId: string;
  nodes: Record<string, CommandNode>;
  branches: Record<string, Branch>;
  current: string;
  seq: number;
}

export class Session {
  private data: SessionData;
  private cache = new Map<string, WorldState>();
  private root: WorldState;

  constructor(
    readonly ctx: Ctx,
    data?: SessionData,
  ) {
    this.root = createInitialState(ctx);
    this.data = data ?? {
      scenarioId: ctx.scenario.id,
      nodes: {},
      branches: { main: { id: 'main', name: 'main', head: null, redo: [], forkedFrom: null } },
      current: 'main',
      seq: 0,
    };
  }

  // --- state ---------------------------------------------------------------

  get branch(): Branch {
    return this.data.branches[this.data.current]!;
  }

  get state(): WorldState {
    return this.stateAt(this.branch.head);
  }

  /** Command path root → node. */
  path(nodeId: string | null): CommandNode[] {
    const out: CommandNode[] = [];
    for (let n = nodeId; n !== null; n = this.data.nodes[n]!.parent) out.push(this.data.nodes[n]!);
    return out.reverse();
  }

  commands(branchId = this.data.current): Command[] {
    return this.path(this.data.branches[branchId]!.head).map((n) => n.command);
  }

  stateAt(nodeId: string | null): WorldState {
    if (nodeId === null) return this.root;
    const hit = this.cache.get(nodeId);
    if (hit) return hit;
    const node = this.data.nodes[nodeId]!;
    const prev = this.stateAt(node.parent);
    const r = applyCommand(this.ctx, prev, node.command, this.path(node.parent).length);
    if (!r.result.ok) throw new Error(`session corrupt: node ${nodeId} no longer legal`);
    this.cache.set(nodeId, r.state);
    return r.state;
  }

  // --- commands ------------------------------------------------------------

  check(cmd: Command): Verdict {
    return validate(this.ctx, this.state, cmd);
  }

  /** Validate and append. Illegal commands leave the session untouched. */
  dispatch(cmd: Command): ApplyResult {
    const b = this.branch;
    const r = applyCommand(this.ctx, this.state, cmd, this.path(b.head).length);
    if (!r.result.ok) return r.result;
    const id = `n${++this.data.seq}`;
    this.data.nodes[id] = { id, parent: b.head, command: structuredClone(cmd) };
    this.cache.set(id, r.state);
    b.head = id;
    b.redo = [];
    return r.result;
  }

  canUndo(): boolean {
    return this.branch.head !== null;
  }

  undo(): boolean {
    const b = this.branch;
    if (b.head === null) return false;
    b.redo.push(b.head);
    b.head = this.data.nodes[b.head]!.parent;
    return true;
  }

  canRedo(): boolean {
    return this.branch.redo.length > 0;
  }

  redo(): boolean {
    const b = this.branch;
    const id = b.redo.pop();
    if (!id) return false;
    b.head = id;
    return true;
  }

  // --- branches ------------------------------------------------------------

  /** Create a new branch whose head is `atNode` (default: current head) and switch to it. */
  fork(name: string, atNode: string | null = this.branch.head): Branch {
    if (atNode !== null && !this.data.nodes[atNode]) throw new Error(`unknown node ${atNode}`);
    let id = name.replace(/[^\w-]+/g, '_') || 'branch';
    while (this.data.branches[id]) id = `${id}_`;
    const br: Branch = { id, name, head: atNode, redo: [], forkedFrom: { branch: this.data.current, node: atNode } };
    this.data.branches[id] = br;
    this.data.current = id;
    return br;
  }

  switchBranch(id: string): void {
    if (!this.data.branches[id]) throw new Error(`unknown branch ${id}`);
    this.data.current = id;
  }

  branches(): Branch[] {
    return Object.values(this.data.branches);
  }

  // --- persistence ---------------------------------------------------------

  toJSON(): SessionData {
    return structuredClone(this.data);
  }

  static fromJSON(ctx: Ctx, data: SessionData): Session {
    if (!data || data.scenarioId !== ctx.scenario.id || !data.nodes || !data.branches || !data.branches[data.current])
      throw new Error('session data does not match the scenario or is incomplete');
    if (!Number.isSafeInteger(data.seq) || data.seq < 0 || data.seq >= Number.MAX_SAFE_INTEGER)
      throw new Error('session sequence is invalid');

    const copy = structuredClone(data);
    for (const id of Object.keys(copy.nodes)) {
      const number = Number(id.slice(1));
      if (!/^n[1-9]\d*$/.test(id) || !Number.isSafeInteger(number) || number > copy.seq)
        throw new Error(`session sequence does not cover node ${id}`);
    }
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      const node = copy.nodes[id];
      if (!node || node.id !== id || !node.command || typeof node.command.type !== 'string')
        throw new Error(`invalid session node ${id}`);
      if (visiting.has(id)) throw new Error(`cycle in session nodes at ${id}`);
      visiting.add(id);
      if (node.parent !== null) visit(node.parent);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of Object.keys(copy.nodes)) visit(id);
    for (const [id, branch] of Object.entries(copy.branches)) {
      if (!branch || branch.id !== id || (branch.head !== null && !copy.nodes[branch.head]) || !Array.isArray(branch.redo))
        throw new Error(`invalid session branch ${id}`);
      let head = branch.head;
      for (const redo of [...branch.redo].reverse()) {
        if (!copy.nodes[redo] || copy.nodes[redo]!.parent !== head) throw new Error(`invalid redo node ${redo}`);
        head = redo;
      }
    }

    const session = new Session(ctx, copy);
    for (const id of Object.keys(copy.nodes)) session.stateAt(id);
    return session;
  }
}
