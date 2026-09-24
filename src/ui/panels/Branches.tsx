/** Branch tree and the command history of the current branch (switch, fork anywhere, go back). */
import { useState, type ReactNode } from 'react';
import type { Branch, CommandNode } from '../../events/session.js';
import type { AppStore } from '../store.js';
import { commandSummary } from '../labels.js';
import { useClock } from '../common.js';

export function BranchesPanel({ store }: { store: AppStore }) {
  const session = store.session;
  const clock = useClock(store);
  const branches = session.branches();
  const current = session.branch;
  const children = (id: string | null) => branches.filter((b) => (b.forkedFrom?.branch ?? null) === id && b.id !== id);
  const headTime = (b: Branch) => session.stateAt(b.head).time;

  const renderBranch = (b: Branch, depth: number): ReactNode => (
    <li key={b.id}>
      <button
        className={`branch-row ${b.id === current.id ? 'on' : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        aria-current={b.id === current.id}
        onClick={() => store.switchBranch(b.id)}
      >
        <span className="branch-name">{depth > 0 ? '└ ' : ''}{b.name}</span>
        <span className="small muted">
          {session.commands(b.id).length} 条 · {clock(headTime(b))}
          {b.forkedFrom && ` · 自 ${clock(session.stateAt(b.forkedFrom.node).time)} 分出`}
        </span>
      </button>
      <ul className="branch-tree">{children(b.id).map((c) => renderBranch(c, depth + 1))}</ul>
    </li>
  );

  const path = session.path(current.head);
  const redo = session.redoNodes();
  const name = (id: string) => store.state.units[id]?.name ?? id;

  return (
    <>
      <section className="panel">
        <h3>分支</h3>
        <ul className="branch-tree">{branches.filter((b) => !b.forkedFrom || !branches.some((x) => x.id === b.forkedFrom!.branch)).map((b) => renderBranch(b, 0))}</ul>
      </section>
      <section className="panel">
        <h3>命令历史：{current.name}</h3>
        <ol className="history">
          <HistoryRow store={store} node={null} label="想定开始" time={clock(0)} state="past" isHead={current.head === null} />
          {path.map((n) => (
            <HistoryRow
              key={n.id}
              store={store}
              node={n}
              label={commandSummary(n.command, name)}
              time={clock(session.stateAt(n.id).time)}
              state="past"
              isHead={n.id === current.head}
            />
          ))}
          {redo.map((n) => (
            <HistoryRow key={n.id} store={store} node={n} label={commandSummary(n.command, name)} time="" state="undone" isHead={false} />
          ))}
        </ol>
      </section>
    </>
  );
}

function HistoryRow({
  store,
  node,
  label,
  time,
  state,
  isHead,
}: {
  store: AppStore;
  node: CommandNode | null;
  label: string;
  time: string;
  state: 'past' | 'undone';
  isHead: boolean;
}) {
  const [forking, setForking] = useState(false);
  const [name, setName] = useState('');
  const id = node?.id ?? null;
  return (
    <li className={`hist ${state} ${isHead ? 'head' : ''}`}>
      <div className="row">
        <span className="t small">{time}</span>
        <span className="s">{label}</span>
        <div className="spacer" />
        {isHead && <span className="tag">当前</span>}
      </div>
      {state === 'past' && (
        <div className="row small hist-actions">
          {!isHead && (
            <button className="link" onClick={() => store.undoTo(id)} title="撤销到这一步（之后的命令可以重做）">
              回到此处
            </button>
          )}
          <button className="link" onClick={() => setForking(!forking)}>
            从此处分支…
          </button>
        </div>
      )}
      {forking && (
        <form
          className="row small"
          onSubmit={(e) => {
            e.preventDefault();
            store.forkAt(name, id);
            setForking(false);
            setName('');
          }}
        >
          <input aria-label="新分支名称" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="新分支名称" />
          <button className="primary" type="submit" disabled={!name.trim()}>
            创建分支
          </button>
        </form>
      )}
    </li>
  );
}
