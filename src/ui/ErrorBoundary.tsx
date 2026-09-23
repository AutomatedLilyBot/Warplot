import { Component, type ErrorInfo, type ReactNode } from 'react';
import { clearAutosave } from './store.js';

interface Props {
  children: ReactNode;
  /** Render a compact fallback (used around the map) instead of the full-page one. */
  compact?: boolean;
  title?: string;
}

/**
 * Without a boundary React unmounts the whole tree on any render/effect error,
 * which leaves only the page background. Show the actual error instead.
 */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[warplot]', error, info.componentStack);
  }

  override render() {
    const e = this.state.error;
    if (!e) return this.props.children;
    return (
      <div className={this.props.compact ? 'crash compact' : 'crash'}>
        <h2>{this.props.title ?? '界面出错了'}</h2>
        <p>下面是错误信息，反馈问题时请一并附上：</p>
        <pre className="tree">{`${e.name}: ${e.message}\n${e.stack ?? ''}`.slice(0, 2000)}</pre>
        <div className="row wrap">
          <button onClick={() => this.setState({ error: null })}>重试</button>
          <button
            onClick={() => {
              clearAutosave();
              location.reload();
            }}
          >
            清除本地存档并重新加载
          </button>
        </div>
      </div>
    );
  }
}
