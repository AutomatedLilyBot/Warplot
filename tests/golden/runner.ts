/**
 * Golden-scenario runner.
 *
 * A script is a list of steps played against a Session. Steps assert as they
 * go (legal commands must be accepted, `reject` commands must be refused for
 * the stated reason, `expect` checks state). The runner also renders a
 * readable chronicle; the test compares it with a stored golden file so any
 * behavioural drift shows up as a reviewable text diff.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Session } from '../../src/events/session.js';
import { chronicle } from '../../src/events/chronicle.js';
import { projectSideView } from '../../src/state/view.js';
import { type Explanation, renderExplanation } from '../../src/core/explain.js';
import { formatClock, parseClock } from '../../src/core/time.js';
import type { Command } from '../../src/events/types.js';
import type { Scenario } from '../../src/state/defs.js';
import type { Ctx } from '../../src/rules/world.js';
import { catalog } from '../helpers.js';

export interface Expectation {
  /** Clock "HH:MM:SS(.mmm)" in scenario time. */
  time?: string;
  /** Exact set of pending opportunity ids. */
  pending?: string[];
  /** Legal interval of a pending intercept/impact opportunity. */
  bounds?: Record<string, [number, number]>;
  /** "unit.mount.weapon" → rounds left. */
  ammo?: Record<string, number>;
  /** unit → exact list of track ids it knows. */
  knows?: Record<string, string[]>;
  /** "unit.track" → spatial structure (BEARING_ONLY / LOCALIZED). */
  track?: Record<string, string>;
  /** "unit.track" → classified category, or null for unclassified. */
  classification?: Record<string, string | null>;
  /** group → remaining count (truth). */
  groupCount?: Record<string, number>;
  hits?: Record<string, number>;
  /** claim id → status, or "absent". */
  claims?: Record<string, string>;
  /** side → strings that must not appear in that side's view. */
  sideExcludes?: Record<string, string[]>;
}

export type Step =
  | { note: string }
  | { do: Command }
  | { reject: Command; because: string; earliest?: string }
  | { expect: Expectation }
  | { mark: string }
  | { fork: string; at?: string }
  | { switch: string }
  | { undo: number }
  /** Advance to the earliest time the command becomes legal (does not dispatch it). */
  | { waitUntilLegal: Command };

export interface Script {
  name: string;
  description: string;
  scenario: string;
  steps: Step[];
}

const root = fileURLToPath(new URL('../../', import.meta.url));

export function loadScenario(file: string): Scenario {
  return JSON.parse(readFileSync(`${root}scenarios/${file}`, 'utf8')) as Scenario;
}

export function loadScript(file: string): Script {
  return JSON.parse(readFileSync(`${root}tests/golden/scripts/${file}`, 'utf8')) as Script;
}

class StepError extends Error {}

/** The failing checks of a verdict plus its informative hints (passing checks are noise here). */
function failing(checks: Explanation[]): Explanation[] {
  return checks.filter((c) => c.ok !== true);
}

function describeCommand(c: Command): string {
  const { type, ...rest } = c;
  return `${type} ${JSON.stringify(rest)}`;
}

export function runScript(script: Script): { text: string; session: Session; ctx: Ctx } {
  const ctx: Ctx = { scenario: loadScenario(script.scenario), catalog };
  const session = new Session(ctx);
  const epoch = parseClock(ctx.scenario.epoch);
  const clock = (t: number) => formatClock(t, epoch);
  const toTime = (c: string) => Math.round((parseClock(c.split('.')[0]!) - epoch) * 1000 + Number(`0.${c.split('.')[1] ?? '0'}`) * 1000);
  const marks = new Map<string, string | null>();
  const out: string[] = [`# ${script.name}`, script.description, `scenario: ${script.scenario}`, ''];
  let logMark = session.state.log.length;
  const flushEvents = () => {
    const s = session.state;
    if (s.log.length > logMark) out.push(chronicle(ctx, s, 'god', { fromIndex: logMark, facts: true }));
    logMark = s.log.length;
  };
  flushEvents();

  script.steps.forEach((step, i) => {
    const where = `${script.name} step ${i + 1}`;
    const fail = (msg: string): never => {
      throw new StepError(`${where}: ${msg}`);
    };

    if ('note' in step) {
      out.push('', `## ${step.note}`);
    } else if ('do' in step) {
      out.push(`> ${describeCommand(step.do)}`);
      const r = session.dispatch(step.do);
      if (!r.ok) fail(`command refused:\n${r.verdict.checks.map((c) => renderExplanation(c)).join('\n')}`);
      flushEvents();
    } else if ('reject' in step) {
      out.push(`> ${describeCommand(step.reject)}  —— 预期被拒绝`);
      const v = session.check(step.reject);
      if (v.ok) fail('expected rejection but command is legal');
      const text = failing(v.checks).map((c) => renderExplanation(c, 1)).join('\n');
      if (!text.includes(step.because)) fail(`rejection reasons do not mention "${step.because}":\n${text}`);
      out.push(text);
      if (v.earliest !== undefined) out.push(`  最早可行: ${clock(v.earliest)}`);
      if (step.earliest !== undefined && (v.earliest === undefined || clock(v.earliest) !== step.earliest))
        fail(`earliest ${v.earliest === undefined ? 'none' : clock(v.earliest)} ≠ ${step.earliest}`);
      if (session.dispatch(step.reject).ok) fail('dispatch accepted a command that check() refused');
    } else if ('waitUntilLegal' in step) {
      const v = session.check(step.waitUntilLegal);
      if (v.ok) fail('command is already legal');
      const at = v.earliest ?? fail('engine cannot tell when the command becomes legal');
      out.push(`> 等待至可执行 ${describeCommand(step.waitUntilLegal)} → ${clock(at)}`);
      const r = session.dispatch({ type: 'ADVANCE', until: at });
      if (!r.ok) fail('ADVANCE refused');
      flushEvents();
      if (session.state.time !== at) fail(`time stopped early at ${clock(session.state.time)}`);
      if (!session.check(step.waitUntilLegal).ok) fail(`still illegal at ${clock(at)}`);
    } else if ('expect' in step) {
      checkExpect(session, ctx, step.expect, fail, toTime, clock);
    } else if ('mark' in step) {
      marks.set(step.mark, session.branch.head);
      out.push(`@ mark "${step.mark}"`);
    } else if ('fork' in step) {
      const at = step.at === undefined ? session.branch.head : marks.has(step.at) ? marks.get(step.at)! : fail(`unknown mark ${step.at}`);
      session.fork(step.fork, at);
      out.push('', `## 分支 "${step.fork}"（自 ${step.at ?? '当前'}，${clock(session.state.time)}）`);
      logMark = session.state.log.length;
    } else if ('switch' in step) {
      session.switchBranch(step.switch);
      out.push('', `## 切回分支 "${step.switch}"（${clock(session.state.time)}）`);
      logMark = session.state.log.length;
    } else if ('undo' in step) {
      for (let k = 0; k < step.undo; k++) if (!session.undo()) fail('nothing to undo');
      out.push(`< undo ×${step.undo} → ${clock(session.state.time)}`);
      logMark = session.state.log.length;
    }
  });

  for (const b of session.branches()) {
    session.switchBranch(b.id);
    out.push('', ...summary(session, ctx, clock));
  }
  return { text: out.join('\n') + '\n', session, ctx };
}

function checkExpect(
  session: Session,
  ctx: Ctx,
  e: Expectation,
  fail: (m: string) => never,
  toTime: (c: string) => number,
  clock: (t: number) => string,
): void {
  const s = session.state;
  const eq = (what: string, got: unknown, want: unknown) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) fail(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };
  if (e.time !== undefined) eq('time', clock(s.time), clock(toTime(e.time)));
  const pend = Object.values(s.opportunities).filter((o) => o.status === 'pending');
  if (e.pending) eq('pending', pend.map((o) => o.id).sort(), [...e.pending].sort());
  for (const [id, b] of Object.entries(e.bounds ?? {})) {
    const o = s.opportunities[id];
    if (!o || o.kind === 'detection') fail(`no bounded opportunity ${id}`);
    eq(`bounds ${id}`, [o.bounds.min, o.bounds.max], b);
  }
  for (const [key, n] of Object.entries(e.ammo ?? {})) {
    const [u, m, w] = key.split('.');
    eq(`ammo ${key}`, s.units[u!]?.mounts[m!]?.ammo[w!] ?? 0, n);
  }
  for (const [u, ids] of Object.entries(e.knows ?? {})) eq(`knows ${u}`, Object.keys(s.knowledge[u] ?? {}).sort(), [...ids].sort());
  for (const [key, kind] of Object.entries(e.track ?? {})) {
    const [u, t] = key.split('.');
    eq(`track ${key}`, s.knowledge[u!]?.[t!]?.spatial.kind, kind);
  }
  for (const [key, cat] of Object.entries(e.classification ?? {})) {
    const [u, t] = key.split('.');
    const tr = s.knowledge[u!]?.[t!];
    if (!tr) fail(`no track ${key}`);
    eq(`classification ${key}`, tr.classification?.category ?? null, cat);
  }
  for (const [g, n] of Object.entries(e.groupCount ?? {})) eq(`group ${g}`, s.groups[g]?.count, n);
  for (const [u, n] of Object.entries(e.hits ?? {})) eq(`hits ${u}`, s.units[u]?.hitsTaken, n);
  for (const [id, st] of Object.entries(e.claims ?? {})) {
    const c = Object.values(s.units).flatMap((u) => u.claims).find((x) => x.id === id);
    eq(`claim ${id}`, c?.status ?? 'absent', st);
  }
  for (const [side, secrets] of Object.entries(e.sideExcludes ?? {})) {
    const json = JSON.stringify(projectSideView(ctx, s, side));
    for (const x of secrets) if (json.includes(x)) fail(`${side} view leaks "${x}"`);
  }
}

function summary(session: Session, ctx: Ctx, clock: (t: number) => string): string[] {
  const s = session.state;
  const out = [`## 终局摘要（分支 "${session.branch.name}"，${clock(s.time)}）`];
  for (const u of Object.values(s.units)) {
    const ammo = Object.entries(u.mounts)
      .map(([m, ms]) => `${m}{${Object.entries(ms.ammo).map(([w, n]) => `${w}:${n}`).join(' ')}}`)
      .join(' ');
    out.push(`- ${u.name} [${u.status}] 命中 ${u.hitsTaken} 航迹 ${Object.keys(s.knowledge[u.id] ?? {}).join(',') || '-'} ${ammo}`);
  }
  for (const g of Object.values(s.groups))
    out.push(`- ${g.id} ${g.weaponId} 发射 ${g.initialCount} 被拦 ${g.intercepted} 命中 ${g.hits} 落空 ${g.misses} 剩余 ${g.count} [${g.status}]`);
  for (const side of ctx.scenario.sides) {
    out.push('', `### ${side.name}视角事件`);
    out.push(chronicle(ctx, s, side.id) || '（无）');
  }
  return out;
}
