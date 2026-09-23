/**
 * App store: wraps one Session plus UI state. React subscribes via
 * useSyncExternalStore; the store is the only place commands are dispatched.
 */
import { Session, type SessionData } from '../events/session.js';
import type { ApplyResult, Command, Verdict } from '../events/types.js';
import type { WorldState } from '../state/types.js';
import type { Ctx } from '../rules/world.js';
import type { CameraMode } from '../renderer/TacticalMap.js';
import { type DemoScript, catalog, scenarios, scripts } from './content.js';
import { type MapModel, type ViewId, buildMapModel } from './mapModel.js';

const SAVE_KEY = 'warplot:autosave:v1';

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

  mapModel(): MapModel {
    if (this.modelCache?.v !== this.version)
      this.modelCache = { v: this.version, model: buildMapModel(this.ctx, this.history(), this.view, { godTracks: this.godTracks }) };
    return this.modelCache.model;
  }

  // --- scenario / persistence --------------------------------------------

  loadScenario(file: string, data?: SessionData): void {
    const scenario = scenarios[file];
    if (!scenario) throw new Error(`unknown scenario ${file}`);
    this.scenarioFile = file;
    this.ctx = { scenario: structuredClone(scenario), catalog };
    this.session = data ? Session.fromJSON(this.ctx, data) : new Session(this.ctx);
    this.session.state; // throws early if a restored log no longer replays
    this.planeId = scenario.referencePlanes[0]?.id ?? '';
    this.selected = null;
    this.flash = null;
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
    const r = this.session.dispatch(cmd);
    this.flash = r.ok ? null : { kind: 'error', text: `${cmd.type} 被拒绝`, verdict: r.verdict };
    this.changed();
    return r;
  }

  undo(): void {
    if (this.session.undo()) this.changed();
  }
  redo(): void {
    if (this.session.redo()) this.changed();
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

  clearFlash(): void {
    this.flash = null;
    this.changed(false);
  }
}
