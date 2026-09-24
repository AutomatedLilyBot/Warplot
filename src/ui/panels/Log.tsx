/** Event log (clickable keywords, filter), causal chain of the focused event, and exports. */
import { useEffect, useRef, useState } from 'react';
import { projectSideView } from '../../state/view.js';
import { exportLog } from '../../events/export.js';
import { chronicle } from '../../events/chronicle.js';
import type { AppStore } from '../store.js';
import { type CausalEvent, type CausalNode, causalGraph } from '../causal.js';
import { Linked, downloadText, useClock, useTokens } from '../common.js';

/** The log visible in the current view (god: truth bodies; side: projected, renumbered events). */
export function viewEvents(store: AppStore): CausalEvent[] {
  const s = store.logState();
  if (store.view === 'god')
    return s.log.map((e) => ({
      id: e.id,
      time: e.time,
      kind: e.kind,
      summary: e.truth.summary,
      causedBy: e.causedBy,
      refs: e.truth.requires.flatMap((f) => (f.ref ? [f.ref] : [])),
    }));
  return projectSideView(store.ctx, s, store.view).events.map((e) => ({
    id: e.id,
    time: e.time,
    kind: e.kind,
    summary: e.summary,
    causedBy: e.causedBy,
    refs: e.requires.flatMap((f) => (f.ref ? [f.ref] : [])),
  }));
}

export function LogPanel({ store }: { store: AppStore }) {
  const clock = useClock(store);
  const tokens = useTokens(store);
  const [showTicks, setShowTicks] = useState(false);
  const [filter, setFilter] = useState('');
  const [focus, setFocus] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const events = viewEvents(store);
  const q = filter.trim().toLowerCase();
  const shown = events
    .filter((e) => showTicks || e.kind !== 'TIME_ADVANCED')
    .filter((e) => !q || e.kind.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q))
    .slice(-300);
  const graph = focus ? causalGraph(events, focus) : null;
  // A focus from another view / branch may not exist here.
  useEffect(() => {
    if (focus && !events.some((e) => e.id === focus)) setFocus(null);
  }, [events, focus]);
  // Block body on purpose: newer Chrome returns a Promise from scrollIntoView, and an
  // expression-bodied effect would hand that to React as its cleanup ("destroy is not a function").
  useEffect(() => {
    if (!focus) endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [shown.length, focus]);
  const pick = (id: string) => {
    setFocus(id);
    listRef.current?.querySelector(`[data-ev="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  const viewName = store.view === 'god' ? '上帝' : store.ctx.scenario.sides.find((x) => x.id === store.view)?.name ?? store.view;
  const base = `warplot-${store.ctx.scenario.id}-${store.session.branch.name}-${store.view}`;

  return (
    <>
      <section className="panel log">
        <div className="row">
          <h3>事件日志（{viewName}）</h3>
          <div className="spacer" />
          {store.view === 'god' && (
            <label className="check small">
              <input type="checkbox" checked={showTicks} onChange={(e) => setShowTicks(e.target.checked)} />
              显示时间推进
            </label>
          )}
        </div>
        {store.rehearsal && <div className="note warn small">预演中：日志包含尚未提交的预演事件。</div>}
        <input className="filter" aria-label="过滤日志" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="按类型或文字过滤" />
        <ol className="events" ref={listRef}>
          {shown.map((e) => (
            <li key={e.id} data-ev={e.id} className={`ev ${e.kind} ${e.id === focus ? 'focus' : ''}`}>
              <button className="t ev-pick" title="查看因果链" onClick={() => setFocus(e.id === focus ? null : e.id)}>
                {clock(e.time)}
              </button>
              <span className="k">{e.kind}</span>
              <span className="s">
                <Linked text={e.summary} tokens={tokens} onPick={(k) => store.select(k, true)} />
              </span>
            </li>
          ))}
        </ol>
        <div ref={endRef} />
        <div className="row small">
          <span className="muted">导出（{viewName}视角）</span>
          <div className="spacer" />
          <button onClick={() => downloadText(`${base}.json`, exportLog(store.ctx, store.session, store.view), 'application/json')}>日志 JSON</button>
          <button onClick={() => downloadText(`${base}.txt`, chronicle(store.ctx, store.state, store.view, { facts: true }), 'text/plain')}>
            战斗编年 TXT
          </button>
        </div>
      </section>
      {graph && (
        <section className="panel causal" aria-label="因果链">
          <div className="row">
            <h3>因果链</h3>
            <div className="spacer" />
            <button className="ghost" aria-label="关闭因果链" onClick={() => setFocus(null)}>
              ×
            </button>
          </div>
          <CausalList title="原因" nodes={graph.causes} clock={clock} onPick={pick} empty="（无记录的原因）" />
          <div className="causal-focus">
            <span className="t">{clock(graph.focus.time)}</span> <span className="k">{graph.focus.kind}</span>
            <div>{graph.focus.summary}</div>
          </div>
          <CausalList title="后果" nodes={graph.effects} clock={clock} onPick={pick} empty="（暂无后果）" />
        </section>
      )}
    </>
  );
}

function CausalList({
  title,
  nodes,
  clock,
  onPick,
  empty,
}: {
  title: string;
  nodes: CausalNode[];
  clock: (t: number) => string;
  onPick: (id: string) => void;
  empty: string;
}) {
  return (
    <div>
      <div className="subhead">{title}</div>
      {!nodes.length && <div className="small muted">{empty}</div>}
      <ul className="causal-list">
        {nodes.map((n, i) => (
          <li key={`${n.event.id}-${i}`} style={{ paddingLeft: (n.depth - 1) * 14 }}>
            <button className="link" onClick={() => onPick(n.event.id)}>
              <span className="t">{clock(n.event.time)}</span> <span className="k">{n.event.kind}</span>
            </button>{' '}
            <span className={n.repeat ? 'muted' : ''}>
              {n.event.summary}
              {n.repeat && '（见上）'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
