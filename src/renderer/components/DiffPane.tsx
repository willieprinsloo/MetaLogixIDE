/**
 * The right-hand pane of the Diff tab: renders the selected entry's `git:diff-sides` state, treating state that
 * belongs to another entry as still loading so a stale diff is never shown under a new selection (spec AC17, AC20,
 * AC23, AC30). An "Explain changes" button in the pane header slides out a right-hand panel with Claude's
 * plain-English summary of the current file's diff (user-triggered — no LLM calls on file-switch).
 */
import { useEffect, useState } from 'react';
import { DIFF_COPY } from '@renderer/diff-tab-copy';
import { entryKey, type DiffEntry } from '@renderer/diff/diff-selection';
import type { DiffSidesState } from '@renderer/diff/diff-load-state';
import { useDiffExplanation } from '@renderer/hooks/useDiffExplanation';
import { ICON_SIZE, ICON_STROKE } from './icon-size';
import { Tooltip } from './Tooltip';
import { SplitDiffView } from './SplitDiffView';
import { DiffExplainPanel } from './DiffExplainPanel';

interface DiffPaneProps {
  entry: DiffEntry | null;
  sides: DiffSidesState;
  projectId: number;
}

/** Centred, muted message block for the Diff tab's loading, empty and error states. */
export function CenteredMessage({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center text-sm text-[--text-muted]" data-testid={testId}>
      {children}
    </div>
  );
}

/** The selected entry's diff: loading until state for this entry arrives, then too-large, the error text, or the side-by-side view (spec AC17, AC20, AC23). */
export function DiffPane({ entry, sides, projectId }: DiffPaneProps) {
  const current = entry !== null && 'key' in sides && sides.key === entryKey(entry) ? sides : null;
  const [explainOpen, setExplainOpen] = useState(false);

  // Close the Explain panel with Esc for parity with the rest of the app.
  useEffect(() => {
    if (!explainOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExplainOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [explainOpen]);

  const ok = current && current.status === 'ok' ? current : null;
  const explanation = useDiffExplanation(
    ok && entry
      ? { projectId, diff: ok.diff, diffHash: ok.diffHash, newPath: entry.path, oldPath: entry.origPath ?? entry.path }
      : null,
  );

  if (entry === null) return null;
  if (current === null || current.status === 'loading') {
    return <CenteredMessage><p role="status">{DIFF_COPY.loadingDiff}</p></CenteredMessage>;
  }
  if (current.status === 'too-large') return <CenteredMessage><p>{DIFF_COPY.tooLarge}</p></CenteredMessage>;
  if (current.status === 'error') {
    return <CenteredMessage><p role="alert" className="text-[--danger] whitespace-pre-wrap break-words">{current.message}</p></CenteredMessage>;
  }

  const onExplainClick = () => {
    if (!explainOpen) {
      setExplainOpen(true);
      if (explanation.state.status === 'idle') explanation.request();
    } else {
      setExplainOpen(false);
    }
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-1 border-b border-[--border] shrink-0 bg-[--panel]/30">
        <span className="text-[11px] text-[--text-muted] flex-1 truncate font-mono" title={entry.path}>{entry.path}</span>
        <Tooltip label={explainOpen ? 'Hide AI explanation' : 'Explain this diff with Claude'}>
          <button
            type="button"
            onClick={onExplainClick}
            aria-pressed={explainOpen}
            aria-label={explainOpen ? 'Hide AI explanation' : 'Explain this diff with Claude'}
            data-testid="diff-explain-toggle"
            className={`text-[11px] px-2 py-0.5 rounded border transition-colors inline-flex items-center gap-1 ${
              explainOpen
                ? 'border-[color:var(--accent)] text-[--accent-label,var(--accent)] bg-[color:var(--accent)]/10'
                : 'border-[--border] text-[--text-muted] hover:text-[--text] hover:bg-[--panel-strong]'
            }`}
          >
            <SparkleIcon /> Explain
          </button>
        </Tooltip>
      </div>
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 min-w-0 min-h-0">
          <SplitDiffView
            diff={current.diff}
            oldPath={entry.origPath ?? entry.path}
            newPath={entry.path}
            oldSide={current.oldSide}
            newSide={current.newSide}
          />
        </div>
        {explainOpen && (
          <DiffExplainPanel
            state={explanation.state}
            onRequest={explanation.request}
            onClose={() => setExplainOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

function SparkleIcon() {
  return (
    <svg width={ICON_SIZE.xs} height={ICON_SIZE.xs} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE.xs} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v3M12 18v3M4.5 7.5l2.1 2.1M17.4 14.4l2.1 2.1M3 12h3M18 12h3M4.5 16.5l2.1-2.1M17.4 9.6l2.1-2.1" />
    </svg>
  );
}
