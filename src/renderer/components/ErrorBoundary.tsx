import { Component, type ErrorInfo, type ReactNode } from 'react';
import { api } from '@renderer/api';

interface State {
  error: Error | null;
  info: string | null;
}

/**
 * Last-line-of-defence for render/lifecycle errors. Without this a thrown
 * exception in ANY descendant unmounts the whole React tree and the user
 * sees a blank window with no way to recover short of quitting the app.
 * Here we swap in a small "something went wrong" card + a Reload button
 * that re-runs `location.reload()`, and log the error so we can find it
 * later in the main-process console (bubbled via console.error → captured
 * by Electron's default log route).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, info: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[metaide] uncaught render error:', error, info.componentStack);
    this.setState({ info: info.componentStack ?? null });
  }

  private reload = () => {
    window.location.reload();
  };

  private reset = () => {
    this.setState({ error: null, info: null });
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const err = this.state.error;
    return (
      <div className="h-screen w-screen flex items-center justify-center p-8 bg-[--panel-strong]/60">
        <div className="max-w-md w-full space-y-4 bg-[--panel-strong] border border-[--border] rounded-lg p-5 shadow-xl">
          <div className="text-sm font-semibold text-[--danger]">Something went wrong.</div>
          <div className="text-xs text-[--text-muted]">
            The UI crashed and had to stop rendering. Your shells and connections keep running in the background.
          </div>
          <pre className="text-[11px] font-mono bg-[--panel] border border-[--border] rounded-md p-2 max-h-40 overflow-auto whitespace-pre-wrap">
            {err.message || String(err)}
          </pre>
          <div className="flex items-center gap-2">
            <button
              onClick={this.reload}
              className="flex-1 pressable bg-[color:var(--accent)] text-white rounded-md py-1.5 text-sm hover:brightness-110"
            >
              Reload window
            </button>
            <button
              onClick={this.reset}
              className="px-3 text-xs text-[--text-muted] hover:text-[--text]"
              title="Retry without a full reload"
            >
              Try again
            </button>
          </div>
          <div className="text-[10px] text-[--text-muted] text-center pt-1">
            Details written to the log —{' '}
            <button
              onClick={() => { void api.invoke('app:reveal-log-file', undefined as never); }}
              className="underline hover:text-[--text]"
            >
              reveal log file
            </button>
          </div>
        </div>
      </div>
    );
  }
}
