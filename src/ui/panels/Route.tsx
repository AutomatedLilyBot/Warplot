/** Route drafting: click the map to add waypoints, then commit one SET_ROUTE. */
import { useEffect } from 'react';
import { planRoute, positionAt, velocityAt } from '../../rules/kinematics.js';
import { length } from '../../core/math/vec3.js';
import type { AppStore } from '../store.js';
import { Tree, km, useClock } from '../common.js';

export function RoutePlanner({ store }: { store: AppStore }) {
  const clock = useClock(store);
  const d = store.routeDraft!;
  const u = store.state.units[d.unitId]!;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') store.cancelRoute();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);
  const cmd = store.routeCommand();
  const verdict = cmd ? store.check(cmd) : null;
  let eta: number | null = null;
  if (cmd?.type === 'SET_ROUTE' && verdict?.ok) {
    const s = store.state;
    const v = velocityAt(u.motion, s.time);
    eta = planRoute(s.time, positionAt(u.motion, s.time), length(v), v, cmd.waypoints, store.ctx.catalog.unitClasses[u.classId]!).arrivesAt;
  }
  return (
    <section className="panel actions route">
      <h3>规划航路：{u.name}</h3>
      <p className="small muted">在地图上点击添加航路点（与单位当前高度同一层面）。按 Esc 取消。</p>
      <label className="row small">
        航速 m/s
        <input className="narrow" value={d.speedMps} onChange={(e) => store.setRouteSpeed(e.target.value)} />
      </label>
      <ol className="waypoints">
        {d.points.map((p, i) => (
          <li key={i} className="row small">
            <span>
              {i + 1}. {km(p[0])}, {km(p[1])}
            </span>
            <div className="spacer" />
            <button className="ghost" aria-label={`删除航路点 ${i + 1}`} onClick={() => store.removeRoutePoint(i)}>
              ×
            </button>
          </li>
        ))}
      </ol>
      {!d.points.length && <div className="small muted">尚未选点。</div>}
      {verdict && !verdict.ok && <Tree items={verdict.checks} failingOnly />}
      {eta !== null && <div className="small muted">预计 {clock(eta)} 到达终点</div>}
      <div className="row">
        <button disabled={!d.points.length} onClick={() => store.removeRoutePoint(d.points.length - 1)}>
          撤销上一点
        </button>
        <div className="spacer" />
        <button onClick={() => store.cancelRoute()}>取消</button>
        <button className="primary" disabled={!verdict?.ok} onClick={() => store.commitRoute()}>
          确认航路
        </button>
      </div>
    </section>
  );
}
