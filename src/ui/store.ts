/**
 * App store: wraps one Session plus UI state. React subscribes via
 * useSyncExternalStore; the store is the only place commands are dispatched.
 */
import { Session, type SessionData } from '../events/session.js';
import type { ApplyResult, Command, Verdict } from '../events/types.js';
import type { WorldState } from '../state/types.js';
import type { Vec3 } from '../core/math/vec3.js';
import { length } from '../core/math/vec3.js';
import { positionAt, velocityAt } from '../rules/kinematics.js';
import { applyCommand } from '../events/engine.js';
import type { Ctx } from '../rules/world.js';
import type { CameraMode } from '../renderer/TacticalMap.js';
import { type DemoScript, catalog, scenarios, scripts } from './content.js';
import { type MapModel, type ViewId, buildMapModel } from './mapModel.js';

const SAVE_KEY = 'warplot:autosave:v1';
const TAB_KEY = 'warplot:tab';

export type SidebarTab = 'situation' | 'log' | 'branches' | 'advanced';
const TABS: SidebarTab[] = ['situation', 'log', 'branches', 'advanced'];

function readTab(): SidebarTab {
  try {
    const t = localStorage.getItem(TAB_KEY) as SidebarTab | null;
    return t && TABS.includes(t) ? t : 'situation';
  } catch {
    return 'situation';
  }
}

/** Drop the browser autosave (e.g. after it stopped replaying). */
export function clearAutosave(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* storage unavailable */
  }
}

export interface Flash {
  kind: 'ok' | 'error';
  text: string;
  verdict?: Verdict;
}

/** A route being drawn on the map for one unit (not yet a command). */
export interface RouteDraft {
  unitId: string;
  points: Vec3[];
  /** Speed for every leg, as typed (m/s). */
  speedMps: string;
}

/** A dry-run ADVANCE computed off the session; adopting it dispatches the same command. */
export interface Rehearsal {
  cmd: Command;
  state: WorldState;
  events: WorldState['log'];
}

export class AppStore {
  ctx!: Ctx;
  session!: Session;
  scenarioFile = '';
  view: ViewId = 'god';
  selected: string | null = null;
  focusRequest = 0;
  cameraMode: CameraMode = 'perspective';
  planeId = '';
  godTracks = false;
  flash: Flash | null = null;
  /** Sidebar tab (a per-viewer convenience, remembered in localStorage). */
  tab: SidebarTab = readTab();
  /** Opportunity dialog collapsed to a pill so the author can look at the map first. */
  oppMinimized = false;
  /** Text handed to the advanced JSON console (e.g. "copy as JSON" from an action). */
  consoleDraft: { text: string; n: number } | null = null;
  routeDraft: RouteDraft | null = null;
  rehearsal: Rehearsal | null = null;
  /** Map preview time (null = now). Read-only; never committed or autosaved. */
  previewAt: number | null = null;
  private version = 0;
  private listeners = new Set<() => void>();
  private modelCache: { v: number; model: MapModel } | null = null;

  constructor() {
    // Emergency hatch: open the page with ?reset to start from a clean slate.
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('reset')) clearAutosave();
    if (!this.restore()) this.loadScenario(Object.keys(scenarios).includes('demo_scenario.json') ? 'demo_scenario.json' : Object.keys(scenarios)[0]!);
  }

  // --- subscription -------------------------------------------------------

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;

  private changed(save = true) {
    this.version++;
    if (save) this.save();
    this.listeners.forEach((f) => f());
  }

  // --- derived ------------------------------------------------------------

  get state(): WorldState {
    return this.session.state;
  }

  /** States along the current branch, root first. */
  history(): WorldState[] {
    return [this.session.stateAt(null), ...this.session.path(this.session.branch.head).map((n) => this.session.stateAt(n.id))];
  }

  /** State the map shows: the rehearsal result while one is open, else the session state. */
  mapState(): WorldState {
    return this.rehearsal?.state ?? this.state;
  }

  /** State whose log the log tab shows: the rehearsal while one is open, else the session. */
  logState(): WorldState {
    return this.rehearsal?.state ?? this.state;
  }

  pendingIds(): string[] {
    return Object.values(this.state.opportunities)
      .filter((o) => o.status === 'pending')
      .map((o) => o.id);
  }

  mapModel(): MapModel {
    if (this.modelCache?.v !== this.version)
      this.modelCache = {
        v: this.version,
        model: buildMapModel(this.ctx, this.rehearsal ? [...this.history(), this.rehearsal.state] : this.history(), this.view, {
          godTracks: this.godTracks,
          ...(this.previewAt !== null ? { at: this.previewAt } : {}),
          ...(this.routeDraft ? { draftRoute: [this.routePlaneAnchor()!, ...this.routeDraft.points] } : {}),
        }),
      };
    return this.modelCache.model;
  }

  // --- scenario / persistence --------------------------------------------

  loadScenario(file: string, data?: SessionData): void {
    const scenario = scenarios[file];
    if (!scenario) throw new Error(`unknown scenario ${file}`);
    const ctx: Ctx = { scenario: structuredClone(scenario), catalog };
    const session = data ? Session.fromJSON(ctx, data) : new Session(ctx);
    session.state; // validate before replacing the active session
    this.scenarioFile = file;
    this.ctx = ctx;
    this.session = session;
    this.planeId = scenario.referencePlanes[0]?.id ?? '';
    this.selected = null;
    this.flash = null;
    this.routeDraft = null;
    this.clearTransient();
    if (!scenario.sides.some((s) => s.id === this.view)) this.view = 'god';
    this.changed();
  }

  /** Load a golden script's scenario and replay its commands (incl. branches). */
  loadScript(file: string): void {
    const sc: DemoScript = scripts[file]!;
    this.loadScenario(sc.scenario);
    const s = this.session;
    const marks = new Map<string, string | null>();
    for (const [i, step] of sc.steps.entries()) {
      const fail = (why: string) => {
        this.flash = { kind: 'error', text: `剧本第 ${i + 1} 步无法执行：${why}` };
      };
      if ('do' in step) {
        const r = s.dispatch(step.do as Command);
        if (!r.ok) return fail(JSON.stringify(step.do)), this.changed();
      } else if ('waitUntilLegal' in step) {
        const v = s.check(step.waitUntilLegal as Command);
        if (v.earliest !== undefined) s.dispatch({ type: 'ADVANCE', until: v.earliest });
      } else if ('mark' in step) marks.set(step.mark as string, s.branch.head);
      else if ('fork' in step) s.fork(step.fork as string, step.at ? marks.get(step.at as string) ?? null : s.branch.head);
      else if ('switch' in step) s.switchBranch(step.switch as string);
      else if ('undo' in step) for (let k = 0; k < (step.undo as number); k++) s.undo();
    }
    this.flash = { kind: 'ok', text: `已载入剧本「${sc.name}」` };
    this.changed();
  }

  resetScenario(): void {
    this.loadScenario(this.scenarioFile);
  }

  private save(): void {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ scenarioFile: this.scenarioFile, session: this.session.toJSON() }));
    } catch {
      /* storage unavailable: fine */
    }
  }

  private restore(): boolean {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      const { scenarioFile, session } = JSON.parse(raw) as { scenarioFile: string; session: SessionData };
      if (!scenarios[scenarioFile]) return false;
      this.loadScenario(scenarioFile, session);
      return true;
    } catch (e) {
      console.warn('[warplot] autosave could not be restored, starting fresh', e);
      clearAutosave();
      return false; // stale or corrupt save: start fresh
    }
  }

  exportSession(): string {
    return JSON.stringify({ scenarioFile: this.scenarioFile, session: this.session.toJSON() }, null, 2);
  }

  importSession(json: string): void {
    const { scenarioFile, session } = JSON.parse(json) as { scenarioFile: string; session: SessionData };
    this.loadScenario(scenarioFile, session);
  }

  // --- commands -----------------------------------------------------------

  check(cmd: Command): Verdict {
    return this.session.check(cmd);
  }

  dispatch(cmd: Command): ApplyResult {
    this.clearTransient();
    const before = new Set(this.pendingIds());
    const r = this.session.dispatch(cmd);
    // New rulings owed → bring the dialog back even if it was minimised.
    if (r.ok && this.pendingIds().some((id) => !before.has(id))) this.oppMinimized = false;
    this.flash = r.ok ? null : { kind: 'error', text: `${cmd.type} 被拒绝`, verdict: r.verdict };
    this.changed();
    return r;
  }

  undo(): void {
    this.clearTransient();
    if (this.session.undo()) this.changed();
  }

  /** Undo until `nodeId` (null = scenario start) is the head; it must be on the current path. */
  undoTo(nodeId: string | null): void {
    this.clearTransient();
    const onPath = nodeId === null || this.session.path(this.session.branch.head).some((n) => n.id === nodeId);
    if (!onPath) return;
    let moved = false;
    while (this.session.branch.head !== nodeId && this.session.undo()) moved = true;
    if (moved) this.changed();
  }

  switchBranch(id: string): void {
    if (id === this.session.branch.id) return;
    this.clearTransient();
    this.session.switchBranch(id);
    this.routeDraft = null;
    this.changed();
  }

  /** New branch whose head is `nodeId` (null = scenario start); switches to it. */
  forkAt(name: string, nodeId: string | null): void {
    this.clearTransient();
    this.session.fork(name.trim() || 'branch', nodeId);
    this.routeDraft = null;
    this.changed();
  }
  redo(): void {
    this.clearTransient();
    if (this.session.redo()) this.changed();
  }

  // --- preview / rehearsal ------------------------------------------------

  /** Drop the map preview and any rehearsal (both describe a state that no longer exists). */
  private clearTransient(): void {
    this.previewAt = null;
    this.rehearsal = null;
  }

  setPreviewAt(t: number | null): void {
    this.previewAt = t !== null && t > this.mapState().time ? t : null;
    this.changed(false);
  }

  /** Dry-run an ADVANCE on a copy of the current state; nothing enters the session. */
  rehearse(cmd: Extract<Command, { type: 'ADVANCE' }>): void {
    const r = applyCommand(this.ctx, this.state, cmd, this.session.commands().length);
    if (!r.result.ok) {
      this.flash = { kind: 'error', text: '无法预演', verdict: r.result.verdict };
    } else {
      this.rehearsal = { cmd, state: r.state, events: r.result.events };
      this.previewAt = null;
    }
    this.changed(false);
  }

  /** Commit the rehearsed ADVANCE (deterministic: the same events happen). */
  adoptRehearsal(): void {
    const r = this.rehearsal;
    if (r) this.dispatch(r.cmd);
  }

  discardRehearsal(): void {
    this.clearTransient();
    this.changed(false);
  }

  // --- ui state -----------------------------------------------------------

  setView(v: ViewId): void {
    this.view = v;
    this.modelCache = null;
    // A selection from another view may not exist (or must not be shown) here.
    if (this.selected && !this.mapModel().entities.some((e) => e.key === this.selected)) this.selected = null;
    this.changed(false);
  }

  select(key: string | null, focus = false): void {
    if (this.routeDraft && key !== `unit:${this.routeDraft.unitId}`) this.routeDraft = null;
    this.selected = key;
    if (focus && key) this.focusRequest++;
    this.changed(false);
  }

  setCameraMode(m: CameraMode): void {
    this.cameraMode = m;
    this.changed(false);
  }

  setPlane(id: string): void {
    this.planeId = id;
    this.changed(false);
  }

  setGodTracks(on: boolean): void {
    this.godTracks = on;
    this.modelCache = null;
    this.changed(false);
  }

  // --- route drafting -----------------------------------------------------

  startRoute(unitId: string): void {
    const u = this.state.units[unitId];
    if (!u) return;
    const v = length(velocityAt(u.motion, this.state.time));
    const cls = this.ctx.catalog.unitClasses[u.classId]!;
    const speed = v > 0.5 ? v : cls.maxSpeedMps * 0.6;
    this.routeDraft = { unitId, points: [], speedMps: String(Math.round(speed * 10) / 10) };
    this.changed(false);
  }

  /** World point in the unit's own height layer (the map intersects the plane through the unit). */
  addRoutePoint(p: Vec3): void {
    if (!this.routeDraft) return;
    this.routeDraft = { ...this.routeDraft, points: [...this.routeDraft.points, p] };
    this.changed(false);
  }

  removeRoutePoint(i: number): void {
    if (!this.routeDraft) return;
    this.routeDraft = { ...this.routeDraft, points: this.routeDraft.points.filter((_, k) => k !== i) };
    this.changed(false);
  }

  setRouteSpeed(speed: string): void {
    if (!this.routeDraft) return;
    this.routeDraft = { ...this.routeDraft, speedMps: speed };
    this.changed(false);
  }

  cancelRoute(): void {
    this.routeDraft = null;
    this.changed(false);
  }

  routeCommand(): Command | null {
    const d = this.routeDraft;
    if (!d || !d.points.length) return null;
    const speed = Number(d.speedMps);
    return {
      type: 'SET_ROUTE',
      unitId: d.unitId,
      waypoints: d.points.map((p) => ({ position: p.map((x) => Math.round(x)) as Vec3, ...(d.speedMps.trim() ? { speedMps: speed } : {}) })),
    };
  }

  commitRoute(): void {
    const cmd = this.routeCommand();
    if (cmd && this.dispatch(cmd).ok) {
      this.routeDraft = null;
      this.changed(false);
    }
  }

  /** Where the map should intersect clicks while drafting: the plane through the unit. */
  routePlaneAnchor(): Vec3 | null {
    const u = this.routeDraft && this.state.units[this.routeDraft.unitId];
    return u ? positionAt(u.motion, this.state.time) : null;
  }

  setTab(tab: SidebarTab): void {
    this.tab = tab;
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* storage unavailable */
    }
    this.changed(false);
  }

  setOppMinimized(on: boolean): void {
    this.oppMinimized = on;
    this.changed(false);
  }

  /** Open the advanced console with this command filled in. */
  editAsJson(cmd: Command): void {
    this.consoleDraft = { text: JSON.stringify(cmd, null, 1), n: (this.consoleDraft?.n ?? 0) + 1 };
    this.setTab('advanced');
  }

  clearFlash(): void {
    this.flash = null;
    this.changed(false);
  }

  showError(text: string): void {
    this.flash = { kind: 'error', text };
    this.changed(false);
  }
}
