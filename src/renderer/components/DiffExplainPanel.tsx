/**
 * Right-hand panel that shows Claude's explanation of the current file's
 * diff. The Diff pane owns the open/closed state; this component is dumb —
 * it just renders one of four states: idle (asks the user to click), loading
 * (spinner + what's happening), error (red banner + retry), ok (markdown).
 *
 * Markdown is rendered through the project's shared `renderMarkdown` helper
 * (markdown-it with html:false). The input is Claude's own output, so we
 * dangerouslySetInnerHTML without a sanitizer.
 */
import { renderMarkdown } from '@renderer/markdown/markdownRenderer';
import type { ExplainState } from '@renderer/hooks/useDiffExplanation';
import { Tooltip } from './Tooltip';

interface Props {
  state: ExplainState;
  onRequest: () => void;
  onClose: () => void;
}

export function DiffExplainPanel({ state, onRequest, onClose }: Props) {
  return (
    <aside
      className="w-[360px] shrink-0 border-l border-[--border] bg-[--panel]/40 flex flex-col min-h-0"
      aria-label="AI explanation of this diff"
      data-testid="diff-explain-panel"
    >
      <header className="flex items-center gap-2 px-3 py-1.5 border-b border-[--border] shrink-0">
        <span className="text-xs font-medium text-[--text] flex-1">Explain changes</span>
        {state.status !== 'loading' && (
          <Tooltip label="Re-run the explanation">
            <button
              type="button"
              onClick={onRequest}
              className="text-[11px] px-2 py-0.5 rounded border border-[--border] text-[--text-muted] hover:text-[--text] hover:bg-[--panel-strong]"
              data-testid="diff-explain-rerun"
            >
              {state.status === 'idle' ? 'Explain' : 'Re-run'}
            </button>
          </Tooltip>
        )}
        <Tooltip label="Close the explanation panel" shortcut="Esc">
          <button
            type="button"
            onClick={onClose}
            className="w-5 h-5 flex items-center justify-center rounded text-[--text-muted] hover:text-[--text] hover:bg-[--panel-strong]"
            aria-label="Close the explanation panel"
            data-testid="diff-explain-close"
          >
            ×
          </button>
        </Tooltip>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 text-xs">
        {state.status === 'idle' && (
          <p className="text-[--text-muted]" data-testid="diff-explain-idle">
            Click <strong>Explain</strong> for a one-screen summary of what this diff does, what it changes, and what a reviewer would want to catch.
          </p>
        )}
        {state.status === 'loading' && (
          <p className="text-[--text-muted]" role="status" data-testid="diff-explain-loading">
            Asking Claude to read the diff — this takes a few seconds.
          </p>
        )}
        {state.status === 'error' && (
          <div className="rounded border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/5 px-2 py-1.5" data-testid="diff-explain-error">
            <p className="font-medium text-[--danger] mb-1">Couldn’t explain this diff</p>
            <p className="text-[--text-muted] whitespace-pre-wrap break-words">{state.message}</p>
          </div>
        )}
        {state.status === 'ok' && (
          <div
            className="prose-diff-explain max-w-none"
            data-testid="diff-explain-ok"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(state.text) }}
          />
        )}
      </div>
    </aside>
  );
}
