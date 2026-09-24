/** Event log with clickable keywords. */
import { useEffect, useRef, useState } from 'react';
import { projectSideView } from '../../state/view.js';
import type { AppStore } from '../store.js';
import { Linked, useClock, useTokens } from '../common.js';

export function LogPanel({ store }: { store: AppStore }) {
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
  // Block body on purpose: newer Chrome returns a Promise from scrollIntoView, and an
  // expression-bodied effect would hand that to React as its cleanup ("destroy is not a function").
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [shown.length]);
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
