import { useEffect, useMemo, useState } from 'react';
import { DIFF_COPY, DIFF_TESTIDS } from '@renderer/diff-tab-copy';
import {
  entryKey,
  groupChanges,
  reconcileSelection,
  type ChangeLists,
} from '@renderer/diff/diff-selection';
import { useGitChanges } from '@renderer/hooks/useGitChanges';
import { useDiffSides } from '@renderer/hooks/useDiffSides';
import { DiffFileList } from './DiffFileList';
import { CenteredMessage, DiffPane } from './DiffPane';

/** A request to focus a specific file in the Diff tab. `tick` must change on every request so
 * repeat requests for the same key still re-select — otherwise the second click of a row the
 * user had scrolled away from would do nothing. */
export interface DiffFocusRequest { key: string; tick: number }

interface Props {
  projectId: number;
  focusRequest?: DiffFocusRequest | null;
}

interface ChangesViewProps {
  projectId: number;
  lists: ChangeLists;
  reloadToken: number;
  onRefresh: () => void;
  focusRequest?: DiffFocusRequest | null;
}

const FOCUS_RING = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-[--accent]';

function RefreshButton({ onRefresh }: { onRefresh: () => void }) {
  return (
    <button
      type="button"
      onClick={onRefresh}
      data-testid={DIFF_TESTIDS.refresh}
      className={`text-xs px-2.5 py-1 rounded-md border border-[--border] text-[--text-muted] hover:text-[--text] hover:bg-[--panel-strong] ${FOCUS_RING}`}
    >
      {DIFF_COPY.refresh}
    </button>
  );
}

function ChangesView({ projectId, lists, reloadToken, onRefresh, focusRequest }: ChangesViewProps) {
  const groups = useMemo(() => groupChanges(lists), [lists]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const allEntries = useMemo(() => groups.flatMap((g) => g.entries), [groups]);
  // An external focus request (e.g. a click on a Git-panel row) wins over the reconciled
  // selection as long as the requested entry exists in the current lists. tick drives the
  // effect so repeat clicks still refocus.
  useEffect(() => {
    if (!focusRequest) return;
    if (allEntries.some((e) => entryKey(e) === focusRequest.key)) setSelectedKey(focusRequest.key);
  }, [focusRequest, allEntries]);
  const selected = reconcileSelection(selectedKey, allEntries);
  const reconciledKey = selected ? entryKey(selected) : null;
  useEffect(() => setSelectedKey(reconciledKey), [reconciledKey]);
  const [refreshToken, setRefreshToken] = useState(0);
  const sides = useDiffSides(projectId, selected, reloadToken, refreshToken);
  const refresh = () => {
    setRefreshToken((t) => t + 1);
    onRefresh();
  };

  if (groups.length === 0) {
    return (
      <CenteredMessage testId={DIFF_TESTIDS.empty}>
        <p>{DIFF_COPY.clean}</p>
        <RefreshButton onRefresh={refresh} />
      </CenteredMessage>
    );
  }
  return (
    <div className="h-full flex flex-col md:flex-row min-h-0">
      <div className="max-h-[40%] md:max-h-none md:w-[280px] shrink-0 flex flex-col min-h-0 border-b md:border-b-0 md:border-r border-[--border] bg-[--panel]/40">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[--border] shrink-0">
          <h2 className="flex-1 text-xs font-medium text-[--text]">{DIFF_COPY.listLabel}</h2>
          <RefreshButton onRefresh={refresh} />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <DiffFileList groups={groups} selectedKey={reconciledKey} onSelect={(e) => setSelectedKey(entryKey(e))} />
        </div>
      </div>
      <div className="flex-1 min-w-0 min-h-0">
        <DiffPane entry={selected} sides={sides} projectId={projectId} />
      </div>
    </div>
  );
}

/**
 * The Diff tab body: polls the project's changes while mounted and shows the grouped file list beside the
 * selected file's side-by-side diff, or the loading, not-a-repository, clean and status-failed states
 * (spec AC7–AC13, AC17, AC21–AC30). Mount it keyed by project id so a project switch starts fresh.
 */
export function DiffTab({ projectId, focusRequest }: Props) {
  const { state, reloadToken, refresh } = useGitChanges(projectId);
  return (
    <section className="h-full min-h-0" aria-label={DIFF_COPY.tabLabel} data-testid={DIFF_TESTIDS.panel}>
      {state.phase === 'loading' && <CenteredMessage><p role="status">{DIFF_COPY.loadingList}</p></CenteredMessage>}
      {state.phase === 'not-repo' && <CenteredMessage testId={DIFF_TESTIDS.empty}><p>{DIFF_COPY.notRepo}</p></CenteredMessage>}
      {state.phase === 'error' && (
        <CenteredMessage testId={DIFF_TESTIDS.error}>
          <p role="alert" className="font-medium text-[--text]">{DIFF_COPY.statusFailed}</p>
          {state.message && <pre className="max-w-full whitespace-pre-wrap break-words font-mono text-xs text-[--danger]">{state.message}</pre>}
          <RefreshButton onRefresh={refresh} />
        </CenteredMessage>
      )}
      {state.phase === 'ready' && (
        <ChangesView projectId={projectId} lists={state.lists} reloadToken={reloadToken} onRefresh={refresh} focusRequest={focusRequest ?? null} />
      )}
    </section>
  );
}
