/**
 * 3D tactical map. Plain Three.js — knows nothing about React or the engine;
 * it only draws a MapModel. World metres (+Z up) are shown in kilometres
 * relative to a floating local origin (see frame.ts).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Vec3 } from '../core/math/vec3.js';
import { add, scale } from '../core/math/vec3.js';
import type { MapEntity, MapModel } from '../ui/mapModel.js';
import { type PlaneFrame, fromPlaneCoords, niceStep, planeCoords, planeFrame, toRender, toWorld } from './frame.js';
import { type GlyphShape, glyphTexture, labelTexture } from './glyphs.js';

export type CameraMode = 'perspective' | 'top' | 'side';

export interface MapOptions {
  onPick?: (key: string | null) => void;
  /** Plane-picking mode (route drafting): world point where a click meets the pick plane. */
  onPlanePick?: (world: Vec3) => void;
  /** Called if the GPU drops the WebGL context. */
  onContextLost?: () => void;
  /** CSS colour per tone (side id or 'contact'). */
  tones: Record<string, string>;
}

interface ScreenSized {
  obj: THREE.Object3D;
  /** Size in CSS px (sprites: w×h; lines: length). */
  px: [number, number];
}

const BG = 0x0b1220;
const GRID = 0x2a3a55;

const v3 = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2]);

export class TacticalMap {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private persp: THREE.PerspectiveCamera;
  private ortho: THREE.OrthographicCamera;
  private camera: THREE.Camera;
  private controls!: OrbitControls;
  private mode: CameraMode = 'perspective';
  private content = new THREE.Group();
  private planeGroup = new THREE.Group();
  private sized: ScreenSized[] = [];
  private pickables: THREE.Object3D[] = [];
  private model: MapModel | null = null;
  private frame: PlaneFrame = planeFrame([0, 0, 0], [0, 0, 1]);
  private localOrigin: Vec3 = [0, 0, 0];
  private selected: string | null = null;
  private extentKm = 200;
  private raf = 0;
  private resizeObs: ResizeObserver;
  private downAt: [number, number] | null = null;
  private fitted = false;
  /** While set, clicks pick a point on the plane through this world point (parallel to the reference plane). */
  private pickPlaneAt: Vec3 | null = null;

  constructor(
    private container: HTMLElement,
    private opts: MapOptions,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(BG);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';
    this.persp = new THREE.PerspectiveCamera(50, 1, 0.01, 1e7);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e7, 1e7);
    this.camera = this.persp;
    this.scene.add(this.planeGroup, this.content);
    this.setupControls();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
    const el = this.renderer.domElement;
    el.addEventListener('webglcontextlost', (ev) => {
      ev.preventDefault();
      this.opts.onContextLost?.();
    });
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointerup', this.onUp);
    let reported = false;
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      try {
        this.controls.update();
        this.updateScreenSizes();
        this.renderer.render(this.scene, this.camera);
      } catch (e) {
        if (!reported) console.error('[warplot] render error', e);
        reported = true;
      }
    };
    loop();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.controls.dispose();
    this.clear(this.content);
    this.clear(this.planeGroup);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---------------------------------------------------------------- public

  setModel(model: MapModel): void {
    this.model = model;
    if (!this.fitted) {
      this.fitToModel();
      this.fitted = true;
    }
    this.rebuild();
  }

  setSelected(key: string | null): void {
    this.selected = key;
    this.rebuild();
  }

  setPlane(origin: Vec3, normal: Vec3): void {
    this.frame = planeFrame(origin, normal);
    this.setCameraMode(this.mode, true);
    this.rebuild();
  }

  setCameraMode(mode: CameraMode, force = false): void {
    if (mode === this.mode && !force) return;
    this.mode = mode;
    const target = this.controls.target.clone();
    const dist = Math.max(1, this.camera.position.distanceTo(target));
    const n = v3(this.frame.normal);
    const u = v3(this.frame.u);
    const v = v3(this.frame.v);
    if (mode === 'perspective') {
      this.camera = this.persp;
      this.persp.up.copy(n);
      this.persp.position.copy(target).addScaledVector(n, dist * 0.7).addScaledVector(v, -dist * 0.7).addScaledVector(u, dist * 0.1);
    } else {
      this.camera = this.ortho;
      this.ortho.zoom = 1;
      if (mode === 'top') {
        this.ortho.up.copy(v);
        this.ortho.position.copy(target).addScaledVector(n, 5000);
      } else {
        this.ortho.up.copy(n);
        this.ortho.position.copy(target).addScaledVector(v, -5000);
      }
      this.ortho.lookAt(target);
      this.ortho.updateProjectionMatrix();
    }
    this.setupControls(target);
    this.resize();
  }

  /** Move the floating origin to an entity and orbit around it. */
  focus(key: string): void {
    const e = this.model?.entities.find((x) => x.key === key);
    const p = e?.position ?? e?.bearing?.origin;
    if (!p) return;
    const offset = this.camera.position.clone().sub(this.controls.target);
    this.localOrigin = p;
    this.controls.target.set(0, 0, 0);
    this.camera.position.copy(offset);
    this.rebuild();
  }

  /** Enter (point = plane anchor) or leave (null) plane-picking mode. */
  setPlanePicking(anchor: Vec3 | null): void {
    this.pickPlaneAt = anchor;
    this.renderer.domElement.style.cursor = anchor ? 'crosshair' : '';
  }

  /** Reset the camera to show everything. */
  fit(): void {
    this.fitToModel();
    this.rebuild();
  }

  // --------------------------------------------------------------- camera

  private setupControls(target = new THREE.Vector3()): void {
    this.controls?.dispose();
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(target);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.screenSpacePanning = true;
    this.controls.enableRotate = this.mode === 'perspective';
    this.controls.zoomSpeed = 1.2;
    this.controls.update();
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    const halfH = this.extentKm * 0.65;
    this.ortho.top = halfH;
    this.ortho.bottom = -halfH;
    this.ortho.left = -halfH * (w / h);
    this.ortho.right = halfH * (w / h);
    this.ortho.updateProjectionMatrix();
  }

  private fitToModel(): void {
    const pts = (this.model?.entities ?? []).flatMap((e) => (e.position ? [e.position] : e.bearing ? [e.bearing.origin] : []));
    if (!pts.length) return;
    const c: Vec3 = scale(pts.reduce((a, p) => add(a, p), [0, 0, 0] as Vec3), 1 / pts.length);
    const r = Math.max(20_000, ...pts.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])));
    this.localOrigin = c;
    this.extentKm = (r / 1000) * 2.4;
    this.controls.target.set(0, 0, 0);
    this.persp.position.set(0, 0, 0);
    this.setCameraMode(this.mode, true);
    const d = this.extentKm * 0.9;
    if (this.mode === 'perspective') {
      const n = v3(this.frame.normal);
      const v = v3(this.frame.v);
      this.persp.position.copy(n.multiplyScalar(d * 0.75)).addScaledVector(v, -d * 0.75);
    }
    this.controls.update();
  }

  /** CSS px → render units at a given render-space point. */
  private worldPerPixel(at: THREE.Vector3): number {
    const h = this.renderer.domElement.clientHeight || 1;
    if (this.camera instanceof THREE.PerspectiveCamera) {
      const d = this.camera.position.distanceTo(at);
      return (2 * d * Math.tan((this.camera.fov * Math.PI) / 360)) / h;
    }
    const o = this.camera as THREE.OrthographicCamera;
    return (o.top - o.bottom) / o.zoom / h;
  }

  private updateScreenSizes(): void {
    const tmp = new THREE.Vector3();
    for (const s of this.sized) {
      s.obj.getWorldPosition(tmp);
      const k = this.worldPerPixel(tmp);
      if (s.obj instanceof THREE.Sprite) s.obj.scale.set(s.px[0] * k, s.px[1] * k, 1);
      else s.obj.scale.setScalar(s.px[0] * k);
    }
  }

  // ---------------------------------------------------------------- picking

  private onDown = (ev: PointerEvent) => {
    this.downAt = [ev.clientX, ev.clientY];
  };

  private onUp = (ev: PointerEvent) => {
    if (!this.downAt) return;
    const moved = Math.hypot(ev.clientX - this.downAt[0], ev.clientY - this.downAt[1]);
    this.downAt = null;
    if (moved > 4) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    if (this.pickPlaneAt) {
      const p = this.intersectPickPlane(ray.ray);
      if (p) this.opts.onPlanePick?.(p);
      return;
    }
    const hit = ray.intersectObjects(this.pickables, false)[0];
    this.opts.onPick?.((hit?.object.userData.key as string | undefined) ?? null);
  };

  /** Ray (render space) ∩ plane through the anchor with the reference-plane normal, in world metres. */
  private intersectPickPlane(r: THREE.Ray): Vec3 | null {
    const n = v3(this.frame.normal);
    const p0 = this.r(this.pickPlaneAt!);
    const denom = n.dot(r.direction);
    if (Math.abs(denom) < 1e-9) return null;
    const t = p0.clone().sub(r.origin).dot(n) / denom;
    if (t < 0) return null;
    const hit = r.origin.clone().addScaledVector(r.direction, t);
    return toWorld([hit.x, hit.y, hit.z], this.localOrigin);
  }

  // ---------------------------------------------------------------- building

  private clear(g: THREE.Group): void {
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    g.clear();
  }

  private r(p: Vec3): THREE.Vector3 {
    return v3(toRender(p, this.localOrigin));
  }

  private tone(t: string): string {
    return this.opts.tones[t] ?? '#9fb3c8';
  }

  private line(points: Vec3[], color: string, opts: { dashed?: boolean; opacity?: number } = {}): THREE.Line {
    const geo = new THREE.BufferGeometry().setFromPoints(points.map((p) => this.r(p)));
    const mat = opts.dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: this.extentKm / 120, gapSize: this.extentKm / 180, transparent: true, opacity: opts.opacity ?? 0.8 })
      : new THREE.LineBasicMaterial({ color, transparent: true, opacity: opts.opacity ?? 0.8 });
    const l = new THREE.Line(geo, mat);
    if (opts.dashed) l.computeLineDistances();
    return l;
  }

  private sprite(tex: THREE.Texture, px: [number, number], center?: [number, number], depthTest = false): THREE.Sprite {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest, transparent: true }));
    if (center) s.center.set(center[0], center[1]);
    s.renderOrder = 10;
    this.sized.push({ obj: s, px });
    return s;
  }

  private rebuild(): void {
    this.clear(this.content);
    this.sized = [];
    this.pickables = [];
    this.buildPlane();
    const m = this.model;
    if (!m) return;

    for (const o of m.obstacles) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry((o.radiusM / 1000) * 1, 24, 16),
        new THREE.MeshBasicMaterial({ color: 0x6b7a90, wireframe: true, transparent: true, opacity: 0.35 }),
      );
      mesh.position.copy(this.r(o.center));
      this.content.add(mesh);
      const lab = labelTexture(o.name, undefined, '#aab6c8');
      const ls = this.sprite(lab.tex, [lab.w, lab.h], [0.5, -0.4]);
      ls.position.copy(mesh.position);
      this.content.add(ls);
    }

    for (const e of m.entities) this.buildEntity(e);
    if (m.draftRoute && m.draftRoute.length > 1) this.buildDraftRoute(m.draftRoute);
  }

  private buildDraftRoute(pts: Vec3[]): void {
    this.content.add(this.line(pts, '#ffffff', { dashed: true, opacity: 0.95 }));
    pts.slice(1).forEach((p, i) => {
      const d = this.sprite(glyphTexture('dot', '#ffffff'), [10, 10]);
      d.position.copy(this.r(p));
      this.content.add(d);
      const lab = labelTexture(`${i + 1}`, undefined, '#ffffff');
      const s = this.sprite(lab.tex, [lab.w, lab.h], [-0.2, -0.2]);
      s.position.copy(this.r(p));
      this.content.add(s);
    });
  }

  private buildPlane(): void {
    this.clear(this.planeGroup);
    const f = this.frame;
    const spanKm = this.extentKm * 2;
    const step = niceStep(spanKm, 12) * 1000;
    const half = Math.ceil((spanKm * 1000) / 2 / step) * step;
    // Centre the grid on the local origin's footprint, snapped to the grid.
    const [a0, b0] = planeCoords(f, this.localOrigin);
    const ca = Math.round(a0 / step) * step;
    const cb = Math.round(b0 / step) * step;
    const pts: Vec3[] = [];
    for (let k = -half; k <= half + 1e-6; k += step) {
      pts.push(fromPlaneCoords(f, ca + k, cb - half), fromPlaneCoords(f, ca + k, cb + half));
      pts.push(fromPlaneCoords(f, ca - half, cb + k), fromPlaneCoords(f, ca + half, cb + k));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts.map((p) => this.r(p)));
    this.planeGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: GRID, transparent: true, opacity: 0.55 })));
    // Faint fill so heights read against something.
    const corners = [
      fromPlaneCoords(f, ca - half, cb - half),
      fromPlaneCoords(f, ca + half, cb - half),
      fromPlaneCoords(f, ca + half, cb + half),
      fromPlaneCoords(f, ca - half, cb + half),
    ].map((p) => this.r(p));
    const fill = new THREE.BufferGeometry().setFromPoints([corners[0]!, corners[1]!, corners[2]!, corners[0]!, corners[2]!, corners[3]!]);
    this.planeGroup.add(
      new THREE.Mesh(fill, new THREE.MeshBasicMaterial({ color: 0x14223a, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false })),
    );
    // Scale label.
    const lab = labelTexture(`网格 ${step / 1000} km`, undefined, '#6f86a8');
    const s = this.sprite(lab.tex, [lab.w, lab.h], [0, 0]);
    s.position.copy(this.r(fromPlaneCoords(f, ca - half, cb - half)));
    this.planeGroup.add(s);
  }

  private buildEntity(e: MapEntity): void {
    const color = this.tone(e.tone);
    const dim = !!e.inactive;
    if (e.trail && e.trail.length > 1) this.content.add(this.line(e.trail, color, { opacity: 0.55 }));
    if (e.route && e.route.length > 1) this.content.add(this.line(e.route, color, { dashed: true, opacity: 0.6 }));
    if (e.flightLine) this.content.add(this.line(e.flightLine, color, { dashed: true, opacity: 0.45 }));
    if (e.bearing) {
      const far = add(e.bearing.origin, scale(e.bearing.dir, this.extentKm * 1000 * 1.2));
      this.content.add(this.line([e.bearing.origin, far], color, { dashed: true, opacity: 0.7 }));
    }

    const anchor = e.position ?? e.bearing?.origin;
    if (!anchor) return;
    const g = new THREE.Group();
    g.position.copy(this.r(anchor));
    this.content.add(g);

    if (e.position) {
      // Height stalk to the reference plane + footprint dot.
      const [a, b, hgt] = planeCoords(this.frame, e.position);
      if (Math.abs(hgt) > 1) {
        const foot = fromPlaneCoords(this.frame, a, b);
        this.content.add(this.line([e.position, foot], color, { opacity: 0.4 }));
        const d = this.sprite(glyphTexture('dot', color, true), [8, 8]);
        d.position.copy(this.r(foot));
        this.content.add(d);
      }
    }

    const shape: GlyphShape =
      e.kind === 'track' ? 'contact' : e.category === 'missile' ? 'missile' : e.category === 'ship' ? 'ship' : 'air';
    const glyph = this.sprite(glyphTexture(shape, color, dim || !e.position), [24, 24]);
    glyph.userData.key = e.key;
    g.add(glyph);
    this.pickables.push(glyph);

    if (e.key === this.selected) g.add(this.sprite(glyphTexture('ring', '#ffffff'), [36, 36]));

    if (e.forward) {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), v3(e.forward)]);
      const hl = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false }));
      hl.renderOrder = 9;
      this.sized.push({ obj: hl, px: [34, 34] });
      g.add(hl);
    }

    // Units label to the lower right (clear of the heading line); tracks to the left,
    // so a track drawn on top of its true unit (god view) stays readable.
    const lab = labelTexture(e.label, e.sublabel, color);
    g.add(this.sprite(lab.tex, [lab.w, lab.h], e.kind === 'track' ? [1.1, 0.5] : [-0.1, 1.05]));
  }
}
