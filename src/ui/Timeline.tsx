/** Map-bottom timeline: scrub a read-only preview of positions, or rehearse the next advance. */
import { useState } from 'react';
import type { AppStore } from './store.js';
import { timelineMarks } from './timeline.js';
import { useClock } from './common.js';

const RANGES: [number, string][] = [
  [600_000, '10 分'],
  [3_600_000, '1 时'],
  [10_800_000, '3 时'],
];

export function Timeline({ store }: { store: AppStore }) {
  const clock = useClock(store);
  const [range, setRange] = useState(RANGES[1]![0]);
  const s = store.mapState();
  const now = s.time;
  const end = now + range;
  const value = store.previewAt ?? now;
  const marks = timelineMarks(store.ctx, s, store.view, now, end);
  const pending = store.pendingIds().length > 0;
  const frac = (t: number) => `${((t - now) / range) * 100}%`;

  return (
    <div className="timeline" role="group" aria-label="时间轴">
      {store.rehearsal && <RehearsalBanner store={store} />}
      <div className="row">
        <span className="small tl-now">{clock(value)}</span>
        {store.previewAt !== null && <span className="tag preview">预览（未提交，不含未来事件）</span>}
        <div className="spacer" />
        <button className="chip" disabled={store.previewAt === null} onClick={() => store.setPreviewAt(null)}>
          回到现在
        </button>
        {RANGES.map(([ms, text]) => (
          <button key={ms} className={`chip ${range === ms ? 'on' : ''}`} onClick={() => setRange(ms)}>
            {text}
          </button>
        ))}
        <span className="tl-sep" />
        <button
          className="chip"
          disabled={pending || !!store.rehearsal}
          title="在副本上推进到下一个确定事件或机会，不写入会话"
          onClick={() => store.rehearse({ type: 'ADVANCE', stopAtNotable: true })}
        >
          预演下一事件
        </button>
        <button
          className="chip"
          disabled={pending || !!store.rehearsal}
          title="在副本上推进到下一个待裁定机会，不写入会话"
          onClick={() => store.rehearse({ type: 'ADVANCE' })}
        >
          预演下一机会
        </button>
      </div>
      <div className="tl-track">
        <input
          type="range"
          aria-label="预览时刻"
          min={now}
          max={end}
          step={1000}
          value={Math.min(value, end)}
          onChange={(e) => store.setPreviewAt(Number(e.target.value))}
        />
        {marks.map((m, i) => (
          <span key={i} className={`tl-mark ${m.kind}`} style={{ left: frac(m.time) }} title={`${clock(m.time)} ${m.label}`} />
        ))}
      </div>
    </div>
  );
}

function RehearsalBanner({ store }: { store: AppStore }) {
  const clock = useClock(store);
  const r = store.rehearsal!;
  const opps = Object.values(r.state.opportunities).filter((o) => o.status === 'pending').length;
  // A side view only lists what that side would see (no truth summaries, no opportunities).
  const shown = r.events
    .filter((e) => e.kind !== 'TIME_ADVANCED')
    .flatMap((e) => {
      const b = store.view === 'god' ? e.truth : e.sides[store.view];
      return b ? [{ id: e.id, time: e.time, summary: b.summary }] : [];
    });
  const showOpps = store.view === 'god' && opps > 0;
  return (
    <div className="rehearsal" role="status" aria-label="预演">
      <div className="row">
        <strong>预演（未提交）</strong>
        <span className="small">
          {clock(store.state.time)} → {clock(r.state.time)} · {shown.length} 个事件{showOpps ? ` · 停在 ${opps} 个待裁定机会` : ''}
        </span>
        <div className="spacer" />
        <button onClick={() => store.discardRehearsal()}>放弃</button>
        <button className="primary" onClick={() => store.adoptRehearsal()}>
          采纳
        </button>
      </div>
      <ol className="rehearsal-events small">
        {shown.slice(0, 8).map((e) => (
          <li key={e.id}>
            <span className="muted">{clock(e.time)}</span> {e.summary}
          </li>
        ))}
        {shown.length > 8 && <li className="muted">…另 {shown.length - 8} 个，见「日志」标签</li>}
      </ol>
    </div>
  );
}
