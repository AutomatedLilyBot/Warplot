/** Opportunity rulings: a non-modal dialog over the map, one opportunity at a time. */
import { useEffect, useState } from 'react';
import { type Identity, type TargetCategory, IDENTITIES, TARGET_CATEGORIES } from '../../state/defs.js';
import type { ClassificationRuling, Decision, NotDetectedReason, Opportunity } from '../../events/types.js';
import { describeMeasurement } from '../../rules/tracks.js';
import type { AppStore } from '../store.js';
import { CATEGORY_ZH, IDENTITY_ZH, trackNumber } from '../labels.js';
import { Tree, num } from '../common.js';

const REASONS: [NotDetectedReason, string][] = [
  ['clutter', '杂波'],
  ['attention', '注意力'],
  ['emission_control', '电磁管制'],
  ['sensor_degradation', '传感器降级'],
  ['other', '其他'],
];

/**
 * Non-modal dialog over the map. In god view it shows one pending opportunity at a
 * time; in a side view it only says that rulings are author-level.
 */
export function OpportunityDialog({ store }: { store: AppStore }) {
  const pending = Object.values(store.state.opportunities).filter((o) => o.status === 'pending');
  const [index, setIndex] = useState(0);
  const i = Math.min(index, Math.max(0, pending.length - 1));
  useEffect(() => {
    if (index !== i) setIndex(i);
  }, [index, i]);
  if (!pending.length) return null;
  if (store.oppMinimized)
    return (
      <button className="opp-pill primary" onClick={() => store.setOppMinimized(false)}>
        待裁定 {pending.length}
      </button>
    );
  const o = pending[i]!;
  const otherDetections = pending.filter((x) => x.kind === 'detection' && x.id !== o.id);
  return (
    <section className="opp-dialog" role="dialog" aria-label="待裁定机会">
      <div className="row">
        <h3>待裁定机会</h3>
        {store.view === 'god' && pending.length > 1 && (
          <div className="row pager">
            <button aria-label="上一个" disabled={i === 0} onClick={() => setIndex(i - 1)}>
              ‹
            </button>
            <span className="small">
              {i + 1} / {pending.length}
            </span>
            <button aria-label="下一个" disabled={i === pending.length - 1} onClick={() => setIndex(i + 1)}>
              ›
            </button>
          </div>
        )}
        <div className="spacer" />
        <button className="ghost" title="最小化，先看地图" aria-label="最小化" onClick={() => store.setOppMinimized(true)}>
          –
        </button>
      </div>
      {store.view !== 'god' ? (
        <>
          <p className="muted">有 {pending.length} 个待裁定机会。机会属于作者层信息，本阵营视角不显示内容。</p>
          <button className="primary" onClick={() => store.setView('god')}>
            切换到上帝视角裁定
          </button>
        </>
      ) : (
        <>
          <OpportunityCard key={o.id} store={store} o={o} />
          {o.kind === 'detection' && otherDetections.length > 0 && (
            <button
              className="small batch"
              title="其余每个探测机会都裁定为探测到：无作者偏移、不分类、存在概率 1"
              onClick={() => {
                for (const x of otherDetections)
                  store.dispatch({ type: 'RESOLVE', opportunityId: x.id, decision: { kind: 'detection', detected: true } });
              }}
            >
              其余 {otherDetections.length} 个探测机会全部：探测到（无偏、不分类）
            </button>
          )}
        </>
      )}
    </section>
  );
}

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
  const bearing = o.measurement.kind === 'bearing';
  const [existence, setExistence] = useState('1');
  const [category, setCategory] = useState<TargetCategory | ''>('');
  const [label, setLabel] = useState('');
  const [identity, setIdentity] = useState<Identity>('unknown');
  const [confidence, setConfidence] = useState('0.9');
  const [offset, setOffset] = useState<Record<string, string>>({});
  const [corr, setCorr] = useState(o.sameAsTracks[0] ?? '');
  const [reason, setReason] = useState<NotDetectedReason>('clutter');
  const [note, setNote] = useState('');
  const observerTracks = Object.keys(store.state.knowledge[o.observerId] ?? {});
  const axes: [string, string][] = bearing
    ? [
        ['azDeg', '方位 °（右正）'],
        ['elDeg', '俯仰 °（上正）'],
      ]
    : [
        ['radialM', '径向 m'],
        ['crossM', '横向 m（右正）'],
        ['upM', '垂向 m（上正）'],
      ];
  const offsetValues = Object.fromEntries(axes.map(([k]) => [k, num(offset[k] ?? '')]).filter(([, v]) => v !== undefined && v !== 0));
  const classified = !!(category || label.trim() || identity !== 'unknown');
  const classification: ClassificationRuling | undefined = classified
    ? { ...(category ? { category } : {}), ...(label.trim() ? { label: label.trim() } : {}), identity, confidence: Number(confidence) }
    : undefined;
  const decision: Decision = {
    kind: 'detection',
    detected: true,
    ...(num(existence) !== undefined && num(existence) !== 1 ? { existence: num(existence)! } : {}),
    ...(Object.keys(offsetValues).length ? { offset: offsetValues } : {}),
    ...(classification ? { classification } : {}),
    ...(corr ? { correlateWith: corr } : {}),
  };
  const verdict = store.check({ type: 'RESOLVE', opportunityId: o.id, decision });
  const failed = verdict.checks.filter((c) => c.ok === false);
  const offsetCheck = verdict.checks.find((c) => c.label.startsWith('作者测量偏移'));
  return (
    <div className="form">
      <div className="small muted">{describeMeasurement(o.measurement)} → {bearing ? '纯方位航迹' : '定位航迹'}</div>
      <div className="row wrap">
        <label>
          存在概率
          <input className="narrow" value={existence} onChange={(e) => setExistence(e.target.value)} />
        </label>
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
      <div className="row wrap">
        <label>
          类别
          <select value={category} onChange={(e) => setCategory(e.target.value as TargetCategory | '')}>
            <option value="">未定</option>
            {TARGET_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_ZH[c]}
              </option>
            ))}
          </select>
        </label>
        <label>
          识别为
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="如：驱逐舰" />
        </label>
        <label>
          敌我
          <select value={identity} onChange={(e) => setIdentity(e.target.value as Identity)}>
            {IDENTITIES.map((x) => (
              <option key={x} value={x}>
                {IDENTITY_ZH[x]}
              </option>
            ))}
          </select>
        </label>
        {classified && (
          <label>
            置信度
            <input className="narrow" value={confidence} onChange={(e) => setConfidence(e.target.value)} />
          </label>
        )}
      </div>
      <div className="row wrap">
        <span className="small muted">测量偏移（可选）</span>
        {axes.map(([k, t]) => (
          <label key={k}>
            {t}
            <input className="narrow" value={offset[k] ?? ''} onChange={(e) => setOffset({ ...offset, [k]: e.target.value })} />
          </label>
        ))}
      </div>
      {offsetCheck && (
        <div className={`small ${offsetCheck.ok === false ? 'bad' : 'muted'}`}>
          {offsetCheck.ok === false ? '✗ ' : '✓ '}
          {offsetCheck.label}
        </div>
      )}
      {failed.some((c) => c !== offsetCheck) && (
        <div className="small bad">
          ✗{' '}
          {failed
            .filter((c) => c !== offsetCheck)
            .map((c) => c.label)
            .join('；')}
        </div>
      )}
      <button
        className="primary"
        disabled={!verdict.ok}
        title={failed.map((c) => c.label).join('\n')}
        onClick={() => store.dispatch({ type: 'RESOLVE', opportunityId: o.id, decision })}
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
