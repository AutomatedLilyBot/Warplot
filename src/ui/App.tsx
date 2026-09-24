import { useEffect, useMemo, useRef, useState } from 'react';
import { TacticalMap, type CameraMode } from '../renderer/TacticalMap.js';
import type { Command } from '../events/types.js';
import type { AppStore, SidebarTab } from './store.js';
import { scenarios, scripts } from './content.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { Segmented, Tree, downloadText, useClock, useStore } from './common.js';
import { OpportunityDialog } from './panels/Opportunity.js';
import { DetailsPanel, EntityList } from './panels/Details.js';
import { ActionsPanel } from './panels/Actions.js';
import { BranchesPanel } from './panels/Branches.js';
import { Timeline } from './Timeline.js';
import { LogPanel } from './panels/Log.js';
import { ConsolePanel } from './panels/Console.js';

const SIDE_TONES = ['#4ea1ff', '#ff5a5a', '#54d18a', '#c792ea'];

const TABS: [SidebarTab, string][] = [
  ['situation', '态势'],
  ['log', '日志'],
  ['branches', '分支'],
  ['advanced', '高级'],
];

// ---------------------------------------------------------------------------

export function App({ store }: { store: AppStore }) {
  useStore(store);
  const tones = useMemo(() => {
    const t: Record<string, string> = { contact: '#ffc14d' };
    store.ctx.scenario.sides.forEach((s, i) => (t[s.id] = SIDE_TONES[i % SIDE_TONES.length]!));
    return t;
  }, [store.ctx]);

  return (
    <div className="app">
      <TopBar store={store} />
      <div className="main">
        <MapView store={store} tones={tones} />
        <aside className="sidebar">
          <div className="sidebar-fixed">
            <TimePanel store={store} />
            <Flash store={store} />
          </div>
          <div className="tabs" role="tablist" aria-label="侧栏">
            {TABS.map(([id, text]) => (
              <button key={id} role="tab" aria-selected={store.tab === id} className={store.tab === id ? 'on' : ''} onClick={() => store.setTab(id)}>
                {text}
              </button>
            ))}
          </div>
          <div className="tab-body" role="tabpanel">
            {store.tab === 'situation' && (
              <>
                <DetailsPanel store={store} />
                <ActionsPanel store={store} />
                <EntityList store={store} tones={tones} />
              </>
            )}
            {store.tab === 'log' && <LogPanel store={store} />}
            {store.tab === 'branches' && <BranchesPanel store={store} />}
            {store.tab === 'advanced' && <ConsolePanel store={store} />}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function TopBar({ store }: { store: AppStore }) {
  const sc = store.ctx.scenario;
  const fileRef = useRef<HTMLInputElement>(null);
  const download = () => downloadText(`warplot-${sc.id}-${store.session.branch.name}.json`, store.exportSession(), 'application/json');
  return (
    <header className="topbar">
      <div className="brand">Warplot</div>
      <label>
        想定
        <select
          value={store.scenarioFile}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith('script:')) store.loadScript(v.slice(7));
            else store.loadScenario(v);
          }}
        >
          <optgroup label="想定">
            {Object.entries(scenarios).map(([f, s]) => (
              <option key={f} value={f}>
                {s.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="示例剧本（重放）">
            {Object.entries(scripts).map(([f, s]) => (
              <option key={f} value={`script:${f}`}>
                {s.name}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      <Segmented
        label="视角"
        value={store.view}
        options={[['god', '上帝'], ...sc.sides.map((s) => [s.id, s.name] as [string, string])]}
        onChange={(v) => store.setView(v)}
      />
      <Segmented<CameraMode>
        label="镜头"
        value={store.cameraMode}
        options={[
          ['perspective', '透视'],
          ['top', '俯视'],
          ['side', '侧视'],
        ]}
        onChange={(v) => store.setCameraMode(v)}
      />
      {sc.referencePlanes.length > 1 && (
        <label>
          参考面
          <select value={store.planeId} onChange={(e) => store.setPlane(e.target.value)}>
            {sc.referencePlanes.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="check">
        <input type="checkbox" checked={store.showUncertainty} onChange={(e) => store.setShowUncertainty(e.target.checked)} />
        误差椭球
      </label>
      {store.view === 'god' && (
        <label className="check">
          <input type="checkbox" checked={store.godTracks} onChange={(e) => store.setGodTracks(e.target.checked)} />
          显示各方航迹
        </label>
      )}
      <div className="spacer" />
      <label className="branch">
        分支
        <select aria-label="当前分支" value={store.session.branch.id} onChange={(e) => store.switchBranch(e.target.value)}>
          {store.session.branches().map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <button onClick={download} title="下载会话（命令树 + 分支）">保存</button>
      <button onClick={() => fileRef.current?.click()} title="载入会话文件">载入</button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          try {
            if (f) store.importSession(await f.text());
          } catch (error) {
            store.showError(`载入失败：${error instanceof Error ? error.message : String(error)}`);
          } finally {
            e.target.value = '';
          }
        }}
      />
      <button onClick={() => confirm('清空当前想定的所有操作？') && store.resetScenario()}>重置</button>
    </header>
  );
}


function MapView({ store, tones }: { store: AppStore; tones: Record<string, string> }) {
  return (
    <div className="map">
      <ErrorBoundary compact title="地图出错（侧栏仍可使用）">
        <MapCanvas store={store} tones={tones} />
      </ErrorBoundary>
      <ErrorBoundary compact title="裁定窗口出错">
        <OpportunityDialog store={store} />
      </ErrorBoundary>
      <ErrorBoundary compact title="时间轴出错">
        <Timeline store={store} />
      </ErrorBoundary>
    </div>
  );
}

function MapCanvas({ store, tones }: { store: AppStore; tones: Record<string, string> }) {
  const version = useStore(store);
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<TacticalMap | null>(null);
  const [glError, setGlError] = useState<string | null>(null);

  useEffect(() => {
    let map: TacticalMap;
    try {
      map = new TacticalMap(ref.current!, {
        tones,
        onPick: (k) => store.select(k),
        onPlanePick: (p) => store.addRoutePoint(p),
        onContextLost: () => setGlError('WebGL 上下文丢失（显卡驱动重置或资源不足）。'),
      });
    } catch (e) {
      setGlError((e as Error).message || String(e));
      return;
    }
    mapRef.current = map;
    setGlError(null);
    return () => {
      mapRef.current = null;
      map.dispose();
    };
  }, [store, tones]);

  const sc = store.ctx.scenario;
  const plane = sc.referencePlanes.find((p) => p.id === store.planeId);
  useEffect(() => {
    mapRef.current?.setPlane(plane?.origin ?? [0, 0, 0], plane?.normal ?? [0, 0, 1]);
  }, [plane, tones]);
  useEffect(() => {
    mapRef.current?.setCameraMode(store.cameraMode);
  }, [store.cameraMode, tones]);
  useEffect(() => {
    mapRef.current?.setShowUncertainty(store.showUncertainty);
  }, [store.showUncertainty, tones]);
  useEffect(() => {
    mapRef.current?.setModel(store.mapModel());
    mapRef.current?.setSelected(store.selected);
  }, [version, tones, store]);
  useEffect(() => {
    if (store.focusRequest && store.selected) mapRef.current?.focus(store.selected);
  }, [store.focusRequest, store]);
  const anchor = store.routePlaneAnchor();
  const anchorKey = anchor?.join(',') ?? '';
  useEffect(() => {
    mapRef.current?.setPlanePicking(anchor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorKey, tones]);

  return (
    <>
      <div className="map-canvas" ref={ref} />
      {glError ? (
        <div className="crash compact">
          <h2>3D 地图无法启动</h2>
          <p>浏览器没能创建 WebGL 画布，侧栏的全部功能仍然可用。</p>
          <pre className="tree">{glError}</pre>
          <ul className="small">
            <li>在浏览器设置里打开“使用硬件加速”（Chrome/Edge：设置 → 系统），然后重启浏览器；</li>
            <li>Chrome/Edge 地址栏打开 chrome://gpu，查看 WebGL 是否为 “Hardware accelerated”；</li>
            <li>远程桌面 / 虚拟机里常常没有 WebGL，可以换本机浏览器打开。</li>
          </ul>
        </div>
      ) : (
        <>
          <div className="map-overlay">
            <button onClick={() => mapRef.current?.fit()}>全景</button>
            {store.selected && <button onClick={() => mapRef.current?.focus(store.selected!)}>居中所选</button>}
          </div>
          <Legend tones={tones} />
        </>
      )}
    </>
  );
}

function Legend({ tones }: { tones: Record<string, string> }) {
  return (
    <div className="legend">
      <span>
        <i className="g-ship" /> 舰艇
      </span>
      <span>
        <i className="g-air" /> 空中
      </span>
      <span>
        <i className="g-missile" /> 弹群
      </span>
      <span>
        <i className="g-contact" style={{ borderColor: tones.contact }} /> 航迹
      </span>
      <span className="muted">实线 = 已走航迹 · 虚线 = 计划航路 / 弹道 / 方位线</span>
    </div>
  );
}

// ---------------------------------------------------------------------------

function TimePanel({ store }: { store: AppStore }) {
  const clock = useClock(store);
  const s = store.state;
  const pending = Object.values(s.opportunities).filter((o) => o.status === 'pending').length;
  const adv = (cmd: Command) => store.dispatch(cmd);
  const busy = pending > 0 || !!store.rehearsal;
  return (
    <section className="panel time">
      <div className="clock">{clock(s.time)}</div>
      <div className="row wrap">
        <button className="primary" disabled={busy} onClick={() => adv({ type: 'ADVANCE', stopAtNotable: true })} title="推进到下一个确定事件或机会">
          ▶ 下一事件
        </button>
        <button disabled={busy} onClick={() => adv({ type: 'ADVANCE' })} title="推进到下一个需要裁定的机会（最多 1 小时）">
          ⏭ 下一机会
        </button>
        <button disabled={busy} onClick={() => adv({ type: 'ADVANCE', until: s.time + 60_000 })}>
          +1 分
        </button>
        <button disabled={busy} onClick={() => adv({ type: 'ADVANCE', until: s.time + 600_000 })}>
          +10 分
        </button>
      </div>
      <div className="row">
        <button disabled={!store.session.canUndo()} onClick={() => store.undo()}>
          ↶ 撤销
        </button>
        <button disabled={!store.session.canRedo()} onClick={() => store.redo()}>
          ↷ 重做
        </button>
        <span className="muted small">命令 {store.session.commands().length} 条</span>
      </div>
      {pending > 0 && <div className="note warn">有 {pending} 个待裁定机会：裁定后才能继续推进。</div>}
      {store.rehearsal && <div className="note warn">预演中：地图显示未提交的推进结果，采纳或放弃后才能下令。</div>}
    </section>
  );
}

function Flash({ store }: { store: AppStore }) {
  const f = store.flash;
  if (!f) return null;
  return (
    <section className={`panel flash ${f.kind}`}>
      <div className="row">
        <strong>{f.text}</strong>
        <div className="spacer" />
        <button className="ghost" onClick={() => store.clearFlash()}>
          ×
        </button>
      </div>
      {f.verdict && <Tree items={f.verdict.checks} failingOnly />}
    </section>
  );
}
