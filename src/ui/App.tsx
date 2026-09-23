import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { TacticalMap, type CameraMode } from '../renderer/TacticalMap.js';
import { renderExplanation, type Explanation } from '../core/explain.js';
import { formatClock, parseClock } from '../core/time.js';
import { type TrackQuality, TRACK_QUALITIES, qualityAtLeast } from '../state/defs.js';
import { length } from '../core/math/vec3.js';
import type { Command, NotDetectedReason, Opportunity } from '../events/types.js';
import { projectSideView } from '../state/view.js';
import { rotate } from '../core/math/quat.js';
import { groupPosition, orientationAt } from '../rules/world.js';
import { positionAt, velocityAt } from '../rules/kinematics.js';
import type { AppStore } from './store.js';
import { scenarios, scripts } from './content.js';
import { QUALITY_ZH, STATUS_ZH, groupLabel, trackNumber } from './labels.js';
import type { MapEntity } from './mapModel.js';

const SIDE_TONES = ['#4ea1ff', '#ff5a5a', '#54d18a', '#c792ea'];

function useStore(store: AppStore): number {
  return useSyncExternalStore(store.subscribe, store.getVersion);
}

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
          <TimePanel store={store} />
          <Flash store={store} />
          <OpportunityPanel store={store} />
          <DetailsPanel store={store} />
          <EntityList store={store} tones={tones} />
          <LogPanel store={store} />
          <ConsolePanel store={store} />
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function TopBar({ store }: { store: AppStore }) {
  const sc = store.ctx.scenario;
  const fileRef = useRef<HTMLInputElement>(null);
  const download = () => {
    const blob = new Blob([store.exportSession()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `warplot-${sc.id}-${store.session.branch.name}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
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
      {store.view === 'god' && (
        <label className="check">
          <input type="checkbox" checked={store.godTracks} onChange={(e) => store.setGodTracks(e.target.checked)} />
          显示各方航迹
        </label>
      )}
      <div className="spacer" />
      <span className="branch">分支：{store.session.branch.name}</span>
      <button onClick={download} title="下载会话（命令树 + 分支）">保存</button>
      <button onClick={() => fileRef.current?.click()} title="载入会话文件">载入</button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) store.importSession(await f.text());
          e.target.value = '';
        }}
      />
      <button onClick={() => confirm('清空当前想定的所有操作？') && store.resetScenario()}>重置</button>
    </header>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      <span className="seg-label">{label}</span>
      {options.map(([v, text]) => (
        <button key={v} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function MapView({ store, tones }: { store: AppStore; tones: Record<string, string> }) {
  const version = useStore(store);
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<TacticalMap | null>(null);

  useEffect(() => {
    const map = new TacticalMap(ref.current!, { tones, onPick: (k) => store.select(k) });
    mapRef.current = map;
    return () => map.dispose();
  }, [store, tones]);

  const sc = store.ctx.scenario;
  const plane = sc.referencePlanes.find((p) => p.id === store.planeId);
  useEffect(() => {
    mapRef.current?.setPlane(plane?.origin ?? [0, 0, 0], plane?.normal ?? [0, 0, 1]);
  }, [plane, tones]);
  useEffect(() => mapRef.current?.setCameraMode(store.cameraMode), [store.cameraMode, tones]);
  useEffect(() => {
    mapRef.current?.setModel(store.mapModel());
    mapRef.current?.setSelected(store.selected);
  }, [version, tones, store]);
  useEffect(() => {
    if (store.focusRequest && store.selected) mapRef.current?.focus(store.selected);
  }, [store.focusRequest, store]);

  return (
    <div className="map">
      <div className="map-canvas" ref={ref} />
      <div className="map-overlay">
        <button onClick={() => mapRef.current?.fit()}>全景</button>
        {store.selected && <button onClick={() => mapRef.current?.focus(store.selected!)}>居中所选</button>}
      </div>
      <Legend tones={tones} />
    </div>
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

function useClock(store: AppStore) {
  const epoch = parseClock(store.ctx.scenario.epoch);
  return (t: number) => formatClock(t, epoch);
}

function TimePanel({ store }: { store: AppStore }) {
  const clock = useClock(store);
  const s = store.state;
  const pending = Object.values(s.opportunities).filter((o) => o.status === 'pending').length;
  const adv = (cmd: Command) => store.dispatch(cmd);
  return (
    <section className="panel time">
      <div className="clock">{clock(s.time)}</div>
      <div className="row wrap">
        <button className="primary" disabled={pending > 0} onClick={() => adv({ type: 'ADVANCE', stopAtNotable: true })} title="推进到下一个确定事件或机会">
          ▶ 下一事件
        </button>
        <button disabled={pending > 0} onClick={() => adv({ type: 'ADVANCE' })} title="推进到下一个需要裁定的机会（最多 1 小时）">
          ⏭ 下一机会
        </button>
        <button disabled={pending > 0} onClick={() => adv({ type: 'ADVANCE', until: s.time + 60_000 })}>
          +1 分
        </button>
        <button disabled={pending > 0} onClick={() => adv({ type: 'ADVANCE', until: s.time + 600_000 })}>
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

// ---------------------------------------------------------------------------

function OpportunityPanel({ store }: { store: AppStore }) {
  const pending = Object.values(store.state.opportunities).filter((o) => o.status === 'pending');
  if (!pending.length) return null;
  if (store.view !== 'god')
    return (
      <section className="panel opp">
        <h3>待裁定机会</h3>
        <p className="muted">机会属于作者层信息，本阵营视角不显示内容。</p>
        <button className="primary" onClick={() => store.setView('god')}>
          切换到上帝视角裁定
        </button>
      </section>
    );
  return (
    <section className="panel opp">
      <h3>待裁定机会（{pending.length}）</h3>
      {pending.map((o) => (
        <OpportunityCard key={o.id} store={store} o={o} />
      ))}
    </section>
  );
}

const REASONS: [NotDetectedReason, string][] = [
  ['clutter', '杂波'],
  ['attention', '注意力'],
  ['emission_control', '电磁管制'],
  ['sensor_degradation', '传感器降级'],
  ['other', '其他'],
];

function OpportunityCard({ store, o }: { store: AppStore; o: Opportunity }) {
  const [open, setOpen] = useState(false);
  const title = o.kind === 'detection' ? '探测机会' : o.kind === 'intercept' ? '拦截结果' : '命中结果';
  return (
    <div className="card">
      <div className="row">
        <span className={`tag ${o.kind}`}>{title}</span>
        <span className="small muted">{o.id}</span>
      </div>
      <p className="opp-title">{o.explanation.label}</p>
      <button className="link" onClick={() => setOpen(!open)}>
        {open ? '收起依据' : '展开依据'}
      </button>
      {open && <Tree items={o.explanation.children ?? []} />}
      {o.kind === 'detection' ? <DetectionForm store={store} o={o} /> : <CountForm store={store} o={o} />}
    </div>
  );
}

function DetectionForm({ store, o }: { store: AppStore; o: Extract<Opportunity, { kind: 'detection' }> }) {
  const qualities = TRACK_QUALITIES.filter((q) => qualityAtLeast(q, 'DETECTED') && qualityAtLeast(o.maxQuality, q));
  const [q, setQ] = useState<TrackQuality>(o.maxQuality);
  const [cls, setCls] = useState('');
  const [corr, setCorr] = useState(o.sameAsTracks[0] ?? '');
  const [reason, setReason] = useState<NotDetectedReason>('clutter');
  const [note, setNote] = useState('');
  const observerTracks = Object.keys(store.state.knowledge[o.observerId] ?? {});
  return (
    <div className="form">
      <div className="row wrap">
        <label>
          质量
          <select value={q} onChange={(e) => setQ(e.target.value as TrackQuality)}>
            {qualities.map((x) => (
              <option key={x} value={x}>
                {QUALITY_ZH[x]} {x}
              </option>
            ))}
          </select>
        </label>
        {qualityAtLeast(q, 'CLASSIFIED') && (
          <label>
            识别为
            <input value={cls} onChange={(e) => setCls(e.target.value)} placeholder="如：驱逐舰" />
          </label>
        )}
        {observerTracks.length > 0 && (
          <label>
            关联
            <select value={corr} onChange={(e) => setCorr(e.target.value)}>
              <option value="">新航迹</option>
              {observerTracks.map((t) => (
                <option key={t} value={t}>
                  {trackNumber(t)}
                  {o.sameAsTracks.includes(t) ? '（真值同一目标）' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <button
        className="primary"
        onClick={() =>
          store.dispatch({
            type: 'RESOLVE',
            opportunityId: o.id,
            decision: { kind: 'detection', detected: true, quality: q, ...(cls ? { classification: cls } : {}), ...(corr ? { correlateWith: corr } : {}) },
          })
        }
      >
        探测到
      </button>
      <div className="row wrap">
        <select value={reason} onChange={(e) => setReason(e.target.value as NotDetectedReason)}>
          {REASONS.map(([v, t]) => (
            <option key={v} value={v}>
              {t}
            </option>
          ))}
        </select>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="理由（可选）" />
        <button
          onClick={() =>
            store.dispatch({ type: 'RESOLVE', opportunityId: o.id, decision: { kind: 'detection', detected: false, reason, ...(note ? { note } : {}) } })
          }
        >
          未探测到
        </button>
      </div>
    </div>
  );
}

function CountForm({ store, o }: { store: AppStore; o: Extract<Opportunity, { kind: 'intercept' | 'impact' }> }) {
  // Intercept bounds are re-clamped to the group's remaining count at ruling time.
  const left = o.kind === 'intercept' && o.groupId ? store.state.groups[o.groupId]?.count ?? 0 : Infinity;
  const max = Math.min(o.bounds.max, left);
  const min = Math.min(o.bounds.min, max);
  const [n, setN] = useState(min);
  const [note, setNote] = useState('');
  const word = o.kind === 'intercept' ? '拦截' : '命中';
  return (
    <div className="form">
      <div className="row">
        <span>
          {word}数量 <strong className="big">{n}</strong> <span className="muted">合法区间 [{min}, {max}]</span>
        </span>
      </div>
      <input type="range" min={min} max={max} value={n} onChange={(e) => setN(Number(e.target.value))} disabled={min === max} />
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注（可选，写进日志）" />
      <button
        className="primary"
        onClick={() =>
          store.dispatch({
            type: 'RESOLVE',
            opportunityId: o.id,
            decision: o.kind === 'intercept' ? { kind: 'intercept', intercepted: n, ...(note ? { note } : {}) } : { kind: 'impact', hits: n, ...(note ? { note } : {}) },
          })
        }
      >
        确认{word} {n}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------

function EntityList({ store, tones }: { store: AppStore; tones: Record<string, string> }) {
  const model = store.mapModel();
  const groups: [string, MapEntity[]][] = [
    ['单位', model.entities.filter((e) => e.kind === 'unit')],
    ['弹群', model.entities.filter((e) => e.kind === 'group')],
    ['航迹', model.entities.filter((e) => e.kind === 'track')],
  ];
  return (
    <section className="panel">
      <h3>态势</h3>
      {groups.map(([title, list]) =>
        list.length ? (
          <div key={title}>
            <div className="subhead">{title}</div>
            <ul className="entities">
              {list.map((e) => (
                <li key={e.key} className={e.key === store.selected ? 'sel' : ''} onClick={() => store.select(e.key, true)}>
                  <i className="dot" style={{ background: tones[e.tone] ?? '#9fb3c8' }} />
                  <span>{e.label}</span>
                  {e.sublabel && <span className="muted small">{e.sublabel}</span>}
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

const km = (m: number) => `${(m / 1000).toFixed(1)} km`;
const deg = (v: [number, number, number]) => ((Math.atan2(v[0], v[1]) * 180) / Math.PI + 360) % 360;

function DetailsPanel({ store }: { store: AppStore }) {
  const clock = useClock(store);
  const key = store.selected;
  if (!key) return null;
  const s = store.state;
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  // Everything shown here must be visible in the current view.
  const sv = store.view === 'god' ? null : projectSideView(store.ctx, s, store.view);
  let body: ReactNode = null;

  if (kind === 'unit') {
    const u = s.units[id];
    if (!u || (sv && !sv.units.some((x) => x.id === id))) return null;
    const cls = store.ctx.catalog.unitClasses[u.classId]!;
    const p = positionAt(u.motion, s.time);
    const v = velocityAt(u.motion, s.time);
    const fwd = rotate(orientationAt(store.ctx, u, s.time), [1, 0, 0]);
    const tracks = Object.values(s.knowledge[u.id] ?? {});
    body = (
      <>
        <h3>
          {u.name} <span className="muted small">{cls.name}</span>
        </h3>
        <dl>
          <dt>状态</dt>
          <dd>
            {STATUS_ZH[u.status]} {u.hitsTaken > 0 && <span className="warn-text">· 被命中 {u.hitsTaken}</span>}
          </dd>
          <dt>位置</dt>
          <dd>
            {km(p[0])}, {km(p[1])}, 高 {Math.round(p[2])} m
          </dd>
          <dt>航速 / 航向</dt>
          <dd>
            {length(v).toFixed(1)} m/s（{(length(v) * 1.943844).toFixed(0)} 节）{length(v) > 0.1 && ` · ${deg(v).toFixed(0)}°`}
          </dd>
          <dt>舰首指向</dt>
          <dd>{deg(fwd).toFixed(1)}°</dd>
          {u.motion.arrivesAt !== null && u.motion.arrivesAt > s.time && (
            <>
              <dt>到达终点</dt>
              <dd>{clock(u.motion.arrivesAt)}</dd>
            </>
          )}
        </dl>
        <div className="subhead">传感器</div>
        {cls.sensors.map((sid) => (
          <label key={sid} className="check">
            <input
              type="checkbox"
              checked={!!u.sensorsOn[sid]}
              onChange={(e) => store.dispatch({ type: 'SET_SENSOR', unitId: u.id, sensorId: sid, on: e.target.checked })}
            />
            {store.ctx.catalog.sensors[sid]!.name}
          </label>
        ))}
        {cls.mounts.length > 0 && <div className="subhead">武器</div>}
        {cls.mounts.map((m) => (
          <div key={m.id} className="small">
            {m.name}：
            {Object.entries(u.mounts[m.id]?.ammo ?? {})
              .map(([w, n]) => `${store.ctx.catalog.weapons[w]!.name} ${n}`)
              .join('，') || '空'}
            {(u.mounts[m.id]?.busyUntil ?? 0) > s.time && <span className="muted">（装填至 {clock(u.mounts[m.id]!.busyUntil)}）</span>}
          </div>
        ))}
        {u.claims.length > 0 && <div className="subhead">资源占用</div>}
        {u.claims.map((c) => (
          <div key={c.id} className="small">
            <span className={`tag ${c.status}`}>{c.status === 'active' ? '生效' : '挂起'}</span> {c.resource}
            {c.amount ? ` ×${c.amount}` : ''} · {c.owner.label} · 优先级 {c.priority}
            {c.until !== null && ` · 至 ${clock(c.until)}`}
          </div>
        ))}
        <div className="subhead">本平台航迹</div>
        {tracks.length === 0 && <div className="muted small">无</div>}
        {tracks.map((t) => (
          <div key={t.id} className="small clickable" onClick={() => store.select(`track:${t.id}`, true)}>
            {trackLabel(store, t.id)} · {QUALITY_ZH[t.quality]} · {Object.keys(t.holds).length ? '保持中' : `${Math.round((s.time - t.lastUpdate) / 1000)} s 前`}
          </div>
        ))}
      </>
    );
  } else if (kind === 'group') {
    const g = s.groups[id];
    if (!g || (sv && !sv.groups.some((x) => x.id === id))) return null;
    const count = sv ? g.initialCount : g.count;
    body = (
      <>
        <h3>
          弹群 {groupLabel(g.id)} <span className="muted small">{store.ctx.catalog.weapons[g.weaponId]!.name}</span>
        </h3>
        <dl>
          <dt>{sv ? '发射数量' : '剩余 / 发射'}</dt>
          <dd>{sv ? count : `${g.count} / ${g.initialCount}`}</dd>
          <dt>目标航迹</dt>
          <dd className="clickable" onClick={() => store.select(`track:${g.targetTrackId}`, true)}>
            {trackLabel(store, g.targetTrackId)}
          </dd>
          <dt>发射 / 到达</dt>
          <dd>
            {clock(g.launchTime)} → {clock(g.arrivalTime)}
          </dd>
          <dt>位置</dt>
          <dd>{groupPosition(g, s.time).map((x) => km(x)).join(', ')}</dd>
        </dl>
      </>
    );
  } else if (kind === 'track') {
    // Freshest copy among platforms visible in this view.
    const holders = Object.entries(s.knowledge).filter(([uid, k]) => k[id] && (!sv || sv.units.some((u) => u.id === uid)));
    if (!holders.length) return null;
    const t = holders.map(([, k]) => k[id]!).sort((a, b) => b.lastUpdate - a.lastUpdate)[0]!;
    const truth = store.view === 'god' ? s.truth.trackTargets[id] : undefined;
    body = (
      <>
        <h3>
          航迹 {trackLabel(store, t.id)} <span className="muted small">{t.id}</span>
        </h3>
        <dl>
          <dt>质量</dt>
          <dd>
            {QUALITY_ZH[t.quality]} {t.quality}
          </dd>
          {t.classification && (
            <>
              <dt>识别</dt>
              <dd>{t.classification}</dd>
            </>
          )}
          <dt>数据时刻</dt>
          <dd>
            {clock(t.lastUpdate)}（{Math.round((s.time - t.lastUpdate) / 1000)} s 前）
          </dd>
          <dt>持有平台</dt>
          <dd>{holders.map(([uid, k]) => `${s.units[uid]!.name}${Object.keys(k[id]!.holds).length ? '（保持）' : ''}`).join('，')}</dd>
          {t.estimate.kind === 'position' ? (
            <>
              <dt>估计位置</dt>
              <dd>
                {t.estimate.position.map((x) => km(x)).join(', ')} ± {t.estimate.uncertaintyM} m
              </dd>
            </>
          ) : (
            <>
              <dt>方位</dt>
              <dd>{deg(t.estimate.direction).toFixed(1)}°（纯方位）</dd>
            </>
          )}
          {truth && (
            <>
              <dt>真值（仅上帝）</dt>
              <dd className="truth">{s.units[truth]?.name ?? truth}</dd>
            </>
          )}
        </dl>
      </>
    );
  }
  return (
    <section className="panel details">
      <div className="row">
        <div className="spacer" />
        <button className="ghost" onClick={() => store.select(null)}>
          ×
        </button>
      </div>
      {body}
    </section>
  );
}

// ---------------------------------------------------------------------------

/** Track number; in the god view prefixed with the owning side, since every side counts from 7001. */
function trackLabel(store: AppStore, trackId: string): string {
  if (store.view !== 'god') return trackNumber(trackId);
  const side = store.ctx.scenario.sides.find((sd) => trackId.startsWith(`${sd.id}-`));
  return `${side?.name ?? ''} ${trackNumber(trackId)}`.trim();
}

interface Token {
  text: string;
  key: string;
  display: string;
}

/** Clickable keywords for the current view (only what the view may show). */
function useTokens(store: AppStore): Token[] {
  const model = store.mapModel();
  const out: Token[] = [];
  for (const e of model.entities) {
    const [kind, id] = [e.key.slice(0, e.key.indexOf(':')), e.key.slice(e.key.indexOf(':') + 1)];
    if (kind === 'unit') {
      out.push({ text: id, key: e.key, display: store.state.units[id]!.name });
      out.push({ text: store.state.units[id]!.name, key: e.key, display: store.state.units[id]!.name });
    } else if (kind === 'track') out.push({ text: id, key: e.key, display: trackLabel(store, id) });
    else if (kind === 'group') out.push({ text: id, key: e.key, display: groupLabel(id) });
  }
  // Tracks no longer drawn (e.g. expended targets) still read better as numbers.
  const side = store.view;
  for (const [uid, k] of Object.entries(store.state.knowledge))
    if (side === 'god' || store.state.units[uid]!.side === side)
      for (const tid of Object.keys(k)) if (!out.some((t) => t.text === tid)) out.push({ text: tid, key: `track:${tid}`, display: trackLabel(store, tid) });
  return out.sort((a, b) => b.text.length - a.text.length);
}

function Linked({ text, tokens, onPick }: { text: string; tokens: Token[]; onPick: (key: string) => void }) {
  if (!tokens.length) return <>{text}</>;
  const esc = tokens.map((t) => t.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${esc.join('|')})(?![\\w-])`, 'g');
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const tok = tokens.find((t) => t.text === m[1])!;
    parts.push(text.slice(last, m.index));
    parts.push(
      <button key={m.index} className="kw" onClick={() => onPick(tok.key)}>
        {tok.display}
      </button>,
    );
    last = m.index! + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

function LogPanel({ store }: { store: AppStore }) {
  const clock = useClock(store);
  const tokens = useTokens(store);
  const [showTicks, setShowTicks] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const s = store.state;
  const events =
    store.view === 'god'
      ? s.log.map((e) => ({ id: e.id, time: e.time, kind: e.kind, summary: e.truth.summary }))
      : projectSideView(store.ctx, s, store.view).events.map((e) => ({ id: e.id, time: e.time, kind: e.kind, summary: e.summary }));
  const shown = events.filter((e) => showTicks || e.kind !== 'TIME_ADVANCED').slice(-300);
  useEffect(() => endRef.current?.scrollIntoView({ block: 'nearest' }), [shown.length]);
  return (
    <section className="panel log">
      <div className="row">
        <h3>事件日志{store.view === 'god' ? '（上帝）' : `（${store.ctx.scenario.sides.find((x) => x.id === store.view)?.name}）`}</h3>
        <div className="spacer" />
        {store.view === 'god' && (
          <label className="check small">
            <input type="checkbox" checked={showTicks} onChange={(e) => setShowTicks(e.target.checked)} />
            显示时间推进
          </label>
        )}
      </div>
      <ol className="events">
        {shown.map((e) => (
          <li key={e.id} className={`ev ${e.kind}`}>
            <span className="t">{clock(e.time)}</span>
            <span className="k">{e.kind}</span>
            <span className="s">
              <Linked text={e.summary} tokens={tokens} onPick={(k) => store.select(k, true)} />
            </span>
          </li>
        ))}
      </ol>
      <div ref={endRef} />
    </section>
  );
}

// ---------------------------------------------------------------------------

function templates(store: AppStore): [string, Command][] {
  const key = store.selected;
  const s = store.state;
  const uid = key?.startsWith('unit:') ? key.slice(5) : undefined;
  const u = uid ? s.units[uid] : undefined;
  const firstTrack = u ? Object.keys(s.knowledge[u.id] ?? {})[0] ?? 'blue-T1' : 'blue-T1';
  const unitId = u?.id ?? Object.keys(s.units)[0]!;
  const p = u ? positionAt(u.motion, s.time) : [0, 0, 0];
  const link = store.ctx.scenario.datalinks.find((l) => !u || l.members.includes(u.id));
  return [
    ['航路', { type: 'SET_ROUTE', unitId, waypoints: [{ position: [Math.round(p[0]! + 20000), Math.round(p[1]!), Math.round(p[2]!)], speedMps: 12 }] }],
    ['发射', { type: 'LAUNCH', unitId, mountId: 'vls', weaponId: 'asm-x', count: 4, trackId: firstTrack }],
    ['拦截', { type: 'ENGAGE', unitId, mountId: 'vls', weaponId: 'sam-std', trackId: firstTrack }],
    ['轴炮对准', { type: 'ALIGN', unitId, mountId: 'rail', trackId: firstTrack, priority: 1 }],
    ['规避', { type: 'MANEUVER', unitId, label: 'EVADE', priority: 10, durationS: 60 }],
    ['数据链', { type: 'TRANSMIT', linkId: link?.id ?? '', from: unitId, to: link?.members.find((m) => m !== unitId) ?? '', trackId: firstTrack }],
    ['单位状态', { type: 'SET_UNIT_STATUS', unitId, status: 'damaged', note: '' }],
    ['备注', { type: 'NOTE', text: '' }],
  ];
}

function ConsolePanel({ store }: { store: AppStore }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<{ ok: boolean; checks: Explanation[]; earliest?: number } | { error: string } | null>(null);
  const clock = useClock(store);
  const parse = (): Command | null => {
    try {
      return JSON.parse(text) as Command;
    } catch (e) {
      setResult({ error: `JSON 无法解析：${(e as Error).message}` });
      return null;
    }
  };
  return (
    <section className="panel console">
      <h3>命令台</h3>
      <p className="muted small">选择单位后可用模板填充；先「检查」看合法性与理由，再「执行」。表单式操作在 Phase 4。</p>
      <div className="row wrap">
        {templates(store).map(([name, cmd]) => (
          <button key={name} className="chip" onClick={() => (setText(JSON.stringify(cmd, null, 1)), setResult(null))}>
            {name}
          </button>
        ))}
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={7} spellCheck={false} placeholder='{"type":"ADVANCE"}' />
      <div className="row">
        <button
          onClick={() => {
            const c = parse();
            if (c) setResult(store.check(c));
          }}
        >
          检查
        </button>
        <button
          className="primary"
          onClick={() => {
            const c = parse();
            if (!c) return;
            const r = store.dispatch(c);
            setResult(r.ok ? { ok: true, checks: [] } : r.verdict);
          }}
        >
          执行
        </button>
      </div>
      {result && 'error' in result && <div className="note error">{result.error}</div>}
      {result && 'ok' in result && (
        <div className={`note ${result.ok ? 'ok' : 'error'}`}>
          {result.ok ? '合法' : '非法'}
          {'earliest' in result && result.earliest !== undefined && ` · 最早可行 ${clock(result.earliest)}`}
          {result.checks.length > 0 && <Tree items={result.checks} />}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

function Tree({ items, failingOnly }: { items: Explanation[]; failingOnly?: boolean }) {
  const list = failingOnly ? items.filter((c) => c.ok !== true) : items;
  return <pre className="tree">{list.map((c) => renderExplanation(c)).join('\n')}</pre>;
}
