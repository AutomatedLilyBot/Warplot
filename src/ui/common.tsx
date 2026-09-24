/** Small shared React helpers and formatters for the UI panels. */
import { useSyncExternalStore, type ReactNode } from 'react';
import { renderExplanation, type Explanation } from '../core/explain.js';
import { formatClock, parseClock } from '../core/time.js';
import type { ClassificationState } from '../state/types.js';
import type { AppStore } from './store.js';
import { CATEGORY_ZH, IDENTITY_ZH, groupLabel, trackNumber } from './labels.js';

export function useStore(store: AppStore): number {
  return useSyncExternalStore(store.subscribe, store.getVersion);
}

export function useClock(store: AppStore) {
  const epoch = parseClock(store.ctx.scenario.epoch);
  return (t: number) => formatClock(t, epoch);
}

export function Tree({ items, failingOnly }: { items: Explanation[]; failingOnly?: boolean }) {
  const list = failingOnly ? items.filter((c) => c.ok !== true) : items;
  return <pre className="tree">{list.map((c) => renderExplanation(c)).join('\n')}</pre>;
}

export const km = (m: number) => `${(m / 1000).toFixed(1)} km`;
export const deg = (v: [number, number, number]) => ((Math.atan2(v[0], v[1]) * 180) / Math.PI + 360) % 360;
export const num = (x: string): number | undefined => (x.trim() === '' ? undefined : Number(x));

export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
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

export function classificationText(c: ClassificationState): string {
  const what = [c.label, c.category ? CATEGORY_ZH[c.category] : undefined].filter(Boolean).join(' / ') || '类别未定';
  return `${what} · ${IDENTITY_ZH[c.identity]} · ${Math.round(c.confidence * 100)}%`;
}

/** Track number; in the god view prefixed with the owning side, since every side counts from 7001. */
export function trackLabel(store: AppStore, trackId: string): string {
  if (store.view !== 'god') return trackNumber(trackId);
  const side = store.ctx.scenario.sides.find((sd) => trackId.startsWith(`${sd.id}-`));
  return `${side?.name ?? ''} ${trackNumber(trackId)}`.trim();
}

export interface Token {
  text: string;
  key: string;
  display: string;
}

/** Clickable keywords for the current view (only what the view may show). */
export function useTokens(store: AppStore): Token[] {
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

export function Linked({ text, tokens, onPick }: { text: string; tokens: Token[]; onPick: (key: string) => void }) {
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
