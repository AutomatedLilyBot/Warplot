/** Situation list and the details of the selected unit / group / track. */
import type { ReactNode } from 'react';
import { RAD, length } from '../../core/math/vec3.js';
import { rotate } from '../../core/math/quat.js';
import type { Track } from '../../state/types.js';
import { projectSideView } from '../../state/view.js';
import { groupPosition, orientationAt, trackCovarianceAt, trackPositionAt } from '../../rules/world.js';
import { ellipsoid95, fmtM } from '../../rules/tracks.js';
import { positionAt, velocityAt } from '../../rules/kinematics.js';
import type { AppStore } from '../store.js';
import type { MapEntity } from '../mapModel.js';
import { SPATIAL_ZH, STATUS_ZH, groupLabel } from '../labels.js';
import { classificationText, deg, km, trackLabel, useClock } from '../common.js';

function SpatialRows({ store, t }: { store: AppStore; t: Track }) {
  const now = store.state.time;
  if (t.spatial.kind === 'BEARING_ONLY')
    return (
      <>
        <dt>方位</dt>
        <dd>
          {deg(t.spatial.direction).toFixed(1)}° ± {((t.spatial.angleSigmaRad / RAD) * 1.96).toPrecision(2)}°（95%，纯方位）
        </dd>
      </>
    );
  const pos = trackPositionAt(t, now)!;
  const cov = trackCovarianceAt(store.ctx, t, now)!;
  return (
    <>
      <dt>估计位置</dt>
      <dd>{pos.map((x) => km(x)).join(', ')}</dd>
      <dt>95% 椭球</dt>
      <dd>
        半轴 {ellipsoid95(cov).map(fmtM).join(' / ')}（观测时 {ellipsoid95(t.spatial.posCov).map(fmtM).join(' / ')}）
      </dd>
    </>
  );
}

export function EntityList({ store, tones }: { store: AppStore; tones: Record<string, string> }) {
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

export function DetailsPanel({ store }: { store: AppStore }) {
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
            {trackLabel(store, t.id)} · {SPATIAL_ZH[t.spatial.kind]}
            {t.classification ? ` · ${classificationText(t.classification)}` : ''} ·{' '}
            {Object.keys(t.holds).length ? '保持中' : `${Math.round((s.time - t.observedAt) / 1000)} s 前`}
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
    const t = holders.map(([, k]) => k[id]!).sort((a, b) => b.observedAt - a.observedAt)[0]!;
    const truth = store.view === 'god' ? s.truth.trackTargets[id] : undefined;
    body = (
      <>
        <h3>
          航迹 {trackLabel(store, t.id)} <span className="muted small">{t.id}</span>
        </h3>
        <dl>
          <dt>空间结构</dt>
          <dd>{SPATIAL_ZH[t.spatial.kind]}</dd>
          <dt>分类</dt>
          <dd>{t.classification ? classificationText(t.classification) : '未分类'}</dd>
          <dt>存在概率</dt>
          <dd>{t.existence}</dd>
          <dt>观测 / 接收</dt>
          <dd>
            {clock(t.observedAt)}（{Math.round((s.time - t.observedAt) / 1000)} s 前）
            {t.receivedAt !== t.observedAt && ` / ${clock(t.receivedAt)}`}
          </dd>
          <dt>持有平台</dt>
          <dd>{holders.map(([uid, k]) => `${s.units[uid]!.name}${Object.keys(k[id]!.holds).length ? '（保持）' : ''}`).join('，')}</dd>
          <SpatialRows store={store} t={t} />
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
