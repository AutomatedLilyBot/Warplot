/** Advanced: raw JSON command console (check first, then execute). */
import { useEffect, useState } from 'react';
import type { Explanation } from '../../core/explain.js';
import type { Command } from '../../events/types.js';
import { positionAt } from '../../rules/kinematics.js';
import type { AppStore } from '../store.js';
import { Tree, useClock } from '../common.js';

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
    ['分类', { type: 'CLASSIFY', unitId, trackId: firstTrack, classification: { category: 'ship', label: '', identity: 'hostile', confidence: 0.8 } }],
    ['数据链', { type: 'TRANSMIT', linkId: link?.id ?? '', from: unitId, to: link?.members.find((m) => m !== unitId) ?? '', trackId: firstTrack }],
    ['单位状态', { type: 'SET_UNIT_STATUS', unitId, status: 'damaged', note: '' }],
    ['备注', { type: 'NOTE', text: '' }],
  ];
}

export function ConsolePanel({ store }: { store: AppStore }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<{ ok: boolean; checks: Explanation[]; earliest?: number } | { error: string } | null>(null);
  const clock = useClock(store);
  const draft = store.consoleDraft;
  useEffect(() => {
    if (draft) {
      setText(draft.text);
      setResult(null);
    }
  }, [draft]);
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
      <p className="muted small">直接编辑命令 JSON。常用操作请用「态势」标签里的动作面板；那里的每个动作都可以「复制为 JSON」到这里。先「检查」看合法性与理由，再「执行」。</p>
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
