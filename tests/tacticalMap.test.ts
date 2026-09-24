// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { TacticalMap } from '../src/renderer/TacticalMap.js';
import type { MapModel } from '../src/ui/mapModel.js';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return {
    ...actual,
    WebGLRenderer: class {
      domElement = document.createElement('canvas');
      setPixelRatio() {}
      setClearColor() {}
      setSize() {}
      render() {}
      dispose() {}
    },
  };
});

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({
      scale() {}, beginPath() {}, arc() {}, stroke() {}, moveTo() {}, lineTo() {}, fill() {},
      closePath() {}, strokeRect() {}, fillText() {}, measureText: (text: string) => ({ width: text.length * 7 }),
    }),
  });
});

describe('Three.js map lifecycle with a stub GPU', () => {
  test('builds map content and survives view, camera, focus and selection updates', () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 800 });
    Object.defineProperty(container, 'clientHeight', { value: 600 });
    document.body.appendChild(container);
    const map = new TacticalMap(container, { tones: { blue: '#4ea1ff', contact: '#ffc14d' } });
    const model: MapModel = {
      view: 'god', time: 0,
      obstacles: [{ id: 'island', name: 'island', center: [20_000, 0, 0], radiusM: 1000 }],
      entities: [
        { key: 'unit:b1', kind: 'unit', tone: 'blue', category: 'ship', label: 'B1', position: [0, 0, 100], forward: [1, 0, 0], trail: [[-1000, 0, 100], [0, 0, 100]], route: [[0, 0, 100], [1000, 0, 100]] },
        { key: 'track:T1', kind: 'track', tone: 'contact', category: 'contact', label: '7001', position: null, bearing: { origin: [0, 0, 100], dir: [1, 0, 0] } },
      ],
    };
    expect(() => {
      map.setModel(model);
      map.setSelected('unit:b1');
      map.setPlane([0, 0, 0], [0, 0, 1]);
      map.setCameraMode('top');
      map.setCameraMode('side');
      map.focus('unit:b1');
      map.fit();
    }).not.toThrow();
    expect(container.querySelector('canvas')).toBeTruthy();
    map.dispose();
    expect(container.querySelector('canvas')).toBeNull();
    container.remove();
  });

  test('draws uncertainty and draft routes; plane picking returns a world point on the pick plane', () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 800 });
    Object.defineProperty(container, 'clientHeight', { value: 600 });
    document.body.appendChild(container);
    const picks: number[][] = [];
    const map = new TacticalMap(container, { tones: { blue: '#4ea1ff', contact: '#ffc14d' }, onPlanePick: (p) => picks.push(p) });
    const model: MapModel = {
      view: 'god', time: 0, obstacles: [],
      draftRoute: [[0, 0, 0], [10_000, 0, 0], [10_000, 10_000, 0]],
      entities: [
        { key: 'unit:b1', kind: 'unit', tone: 'blue', category: 'ship', label: 'B1', position: [0, 0, 0] },
        { key: 'track:T1', kind: 'track', tone: 'contact', category: 'contact', label: '7001', position: [30_000, 0, 0],
          ellipsoid: { center: [30_000, 0, 0], axes: [[500, 0, 0], [0, 200, 0], [0, 0, 100]] } },
        { key: 'track:T2', kind: 'track', tone: 'contact', category: 'contact', label: '7002', position: null,
          bearing: { origin: [0, 0, 0], dir: [0, 1, 0] }, bearingSpread: 0.03 },
      ],
    };
    expect(() => {
      map.setModel(model);
      map.setShowUncertainty(false);
      map.setShowUncertainty(true);
      map.setCameraMode('top');
    }).not.toThrow();
    const canvas = container.querySelector('canvas')!;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;
    Object.assign(canvas, { setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false });
    map.setPlanePicking([0, 0, 250]);
    canvas.dispatchEvent(new MouseEvent('pointerdown', { clientX: 400, clientY: 300 }) as PointerEvent);
    canvas.dispatchEvent(new MouseEvent('pointerup', { clientX: 400, clientY: 300 }) as PointerEvent);
    expect(picks).toHaveLength(1);
    expect(picks[0]![2]).toBeCloseTo(250, 3); // on the plane through the anchor
    map.setPlanePicking(null);
    map.dispose();
    container.remove();
  });
});
