/** Legal actions for the selected unit: one row per command, greyed out with reasons when illegal. */
import { useMemo, useState } from 'react';
import type { AppStore } from '../store.js';
import { type ActionGroup, type ActionItem, type ParamValues, GROUP_ZH, unitActions } from '../actions.js';
import { Tree, trackLabel, useClock, useStore } from '../common.js';
import { RoutePlanner } from './Route.js';

const GROUPS: ActionGroup[] = ['sensor', 'weapon', 'info', 'maneuver', 'status'];

export function ActionsPanel({ store }: { store: AppStore }) {
  const version = useStore(store);
  const key = store.selected;
  const unitId = key?.startsWith('unit:') ? key.slice(5) : null;
  const unit = unitId ? store.state.units[unitId] : undefined;
  const tracks = unit ? Object.keys(store.state.knowledge[unit.id] ?? {}).sort() : [];
  const [trackPick, setTrackPick] = useState<string>('');
  const [values, setValues] = useState<ParamValues>({});
  const trackId = tracks.includes(trackPick) ? trackPick : (tracks[0] ?? null);
  const items = useMemo(
    () => (unitId ? unitActions(store.ctx, store.state, store.view, unitId, trackId, values) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, unitId, trackId, values, store.view],
  );
  if (!unit || !items.length) return null;
  if (store.routeDraft?.unitId === unit.id) return <RoutePlanner store={store} />;
  const blocked = store.rehearsal !== null;
  const setParam = (id: string, k: string, v: string) => setValues({ ...values, [id]: { ...values[id], [k]: v } });

  return (
    <section className="panel actions">
      <div className="row">
        <h3>动作：{unit.name}</h3>
        <div className="spacer" />
        <button disabled={blocked} onClick={() => store.startRoute(unit.id)} title="在地图上点选航路点">
          规划航路
        </button>
      </div>
      {blocked && <div className="note warn small">预演中：采纳或放弃预演后才能下令。</div>}
      <label className="row small">
        目标航迹
        <select value={trackId ?? ''} onChange={(e) => setTrackPick(e.target.value)} disabled={!tracks.length}>
          {!tracks.length && <option value="">（本平台没有航迹）</option>}
          {tracks.map((t) => (
            <option key={t} value={t}>
              {trackLabel(store, t)}
            </option>
          ))}
        </select>
      </label>
      {GROUPS.map((g) => {
        const list = items.filter((i) => i.group === g);
        if (!list.length) return null;
        return (
          <div key={g}>
            <div className="subhead">{GROUP_ZH[g]}</div>
            {list.map((it) => (
              <ActionRow key={it.id} store={store} item={it} blocked={blocked} values={values[it.id] ?? {}} onParam={(k, v) => setParam(it.id, k, v)} />
            ))}
          </div>
        );
      })}
    </section>
  );
}

function ActionRow({
  store,
  item,
  blocked,
  values,
  onParam,
}: {
  store: AppStore;
  item: ActionItem;
  blocked: boolean;
  values: Record<string, string>;
  onParam: (k: string, v: string) => void;
}) {
  const clock = useClock(store);
  const [open, setOpen] = useState(false);
  const v = item.verdict;
  const failing = v.checks.filter((c) => c.ok === false);
  const pending = store.pendingIds().length > 0;
  return (
    <div className={`action ${v.ok ? 'legal' : 'illegal'}`}>
      <div className="row wrap">
        <span className="action-label">{item.label}</span>
        {item.params.map((p) => (
          <label key={p.key} className="small">
            {p.label}
            {p.type === 'select' ? (
              <select value={values[p.key] ?? p.default} onChange={(e) => onParam(p.key, e.target.value)}>
                {p.options!.map(([val, text]) => (
                  <option key={val} value={val}>
                    {text}
                  </option>
                ))}
              </select>
            ) : (
              <input className={p.type === 'number' ? 'narrow' : ''} value={values[p.key] ?? p.default} onChange={(e) => onParam(p.key, e.target.value)} />
            )}
          </label>
        ))}
        <div className="spacer" />
        <button className="primary" disabled={!v.ok || blocked} onClick={() => store.dispatch(item.command)}>
          执行
        </button>
      </div>
      {!v.ok && (
        <div className="small bad">
          ✗ {failing.map((c) => c.label).join('；')}
          {item.hiddenFailures && `${failing.length ? '；' : ''}有裁判层条件不满足（切到上帝视角查看）`}
        </div>
      )}
      <div className="row small">
        {v.earliest !== undefined && !v.ok && (
          <button
            className="chip"
            disabled={pending || blocked || v.earliest <= store.state.time}
            title={pending ? '先裁定待裁定机会' : '推进时间到该动作最早可行的时刻（途中出现机会会提前停下）'}
            onClick={() => store.dispatch({ type: 'ADVANCE', until: v.earliest })}
          >
            推进到 {clock(v.earliest)}
          </button>
        )}
        <button className="link" onClick={() => setOpen(!open)}>
          {open ? '收起检查' : '全部检查'}
        </button>
        <button className="link" onClick={() => store.editAsJson(item.command)}>
          复制为 JSON
        </button>
      </div>
      {open && <Tree items={v.checks} />}
    </div>
  );
}
