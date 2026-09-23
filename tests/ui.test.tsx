// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '../src/ui/App.js';
import { AppStore } from '../src/ui/store.js';
import type { MapModel } from '../src/ui/mapModel.js';

interface FakeMap {
  opts: { onPick?: (key: string | null) => void };
  model: MapModel | null;
  selected: string | null;
  mode: string;
  fits: number;
}

const mapMock = vi.hoisted(() => ({ instances: [] as FakeMap[], failConstruction: false }));

// Keep React and the store real; replace only the GPU-dependent canvas renderer.
vi.mock('../src/renderer/TacticalMap.js', () => ({
  TacticalMap: class implements FakeMap {
    opts: FakeMap['opts'];
    model: MapModel | null = null;
    selected: string | null = null;
    mode = 'perspective';
    fits = 0;
    constructor(_container: HTMLElement, opts: FakeMap['opts']) {
      if (mapMock.failConstruction) throw new Error('WebGL unavailable');
      this.opts = opts;
      mapMock.instances.push(this);
    }
    dispose() {}
    setModel(model: MapModel) { this.model = model; }
    setSelected(key: string | null) { this.selected = key; }
    setPlane() {}
    setCameraMode(mode: string) { this.mode = mode; }
    focus() {}
    fit() { this.fits++; }
  },
}));

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  mapMock.instances.length = 0;
  mapMock.failConstruction = false;
});
afterEach(() => cleanup());

describe('Phase 3 interface', () => {
  test('map pick, side switch, camera switch and fit use the active store', () => {
    const store = new AppStore();
    render(<App store={store} />);
    const map = mapMock.instances[0]!;
    expect(map.model?.view).toBe('god');

    act(() => map.opts.onPick?.('unit:blue-ddg-01'));
    expect(store.selected).toBe('unit:blue-ddg-01');
    expect(screen.getByRole('heading', { name: /Blue-DDG-01/ })).toBeTruthy();

    fireEvent.click(within(screen.getByRole('group', { name: '视角' })).getByRole('button', { name: '红方' }));
    expect(store.view).toBe('red');
    expect(store.selected).toBeNull();
    expect(map.model?.view).toBe('red');
    expect(map.model?.entities.filter((e) => e.kind === 'unit').every((e) => e.tone === 'red')).toBe(true);

    fireEvent.click(within(screen.getByRole('group', { name: '镜头' })).getByRole('button', { name: '俯视' }));
    expect(map.mode).toBe('top');
    fireEvent.click(screen.getByRole('button', { name: '全景' }));
    expect(map.fits).toBe(1);
  });

  test('opportunity details stay hidden in a side view and can be ruled in god view', () => {
    const store = new AppStore();
    render(<App store={store} />);
    fireEvent.click(screen.getByRole('button', { name: /下一事件/ }));
    const pending = () => Object.values(store.state.opportunities).filter((o) => o.status === 'pending').length;
    expect(pending()).toBeGreaterThan(0);

    fireEvent.click(within(screen.getByRole('group', { name: '视角' })).getByRole('button', { name: '蓝方' }));
    expect(screen.queryByRole('button', { name: '探测到' })).toBeNull();
    expect(screen.getByText('机会属于作者层信息，本阵营视角不显示内容。')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '切换到上帝视角裁定' }));
    const before = pending();
    fireEvent.click(screen.getAllByRole('button', { name: '探测到' })[0]!);
    expect(pending()).toBe(before - 1);
    expect(store.state.log.some((e) => e.kind === 'DETECTION')).toBe(true);
  });

  test('file input reports a corrupt session without losing the current work', async () => {
    const store = new AppStore();
    store.dispatch({ type: 'NOTE', text: 'my work' });
    const before = store.exportSession();
    const broken = JSON.parse(before);
    broken.session.nodes.n2 = { id: 'n2', parent: 'n1', command: { type: 'NOTE', text: '' } };
    broken.session.seq = 2;
    broken.session.branches.main.head = 'n2';

    const { container } = render(<App store={store} />);
    const file = new File([JSON.stringify(broken)], 'broken.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => JSON.stringify(broken) });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText(/载入失败/)).toBeTruthy());
    expect(store.exportSession()).toBe(before);
    expect(screen.getByRole('button', { name: /下一事件/ })).toBeTruthy();
  });

  test('a WebGL startup failure keeps the sidebar usable', () => {
    mapMock.failConstruction = true;
    const store = new AppStore();
    render(<App store={store} />);
    expect(screen.getByRole('heading', { name: '3D 地图无法启动' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /下一事件/ })).toBeTruthy();
  });
});
