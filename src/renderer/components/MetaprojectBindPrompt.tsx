/**
 * One-time bind prompt (METAI-8).
 *
 * When a project opens unlinked and the user hasn't skipped it, a
 * dismissible banner appears above the workspace with three paths:
 *
 * - **Link existing:** opens the Project Settings tab where the
 *   existing AssignmentPanel handles picking a remote project.
 * - **Create new:** reveals an inline name field (prefilled with the
 *   folder name) and calls `metaproject:assignment-create` through the
 *   existing `useAssignmentOperation` hook. On success, the banner
 *   collapses because the folder is now linked and `useAssignment`
 *   reports `kind: 'linked'`.
 * - **Skip:** writes `.metaide/metaproject-skip` via `bind-prompt:skip`
 *   so the prompt doesn't come back on the next window reload.
 *
 * The banner renders nothing when there's no signed-in metaproject
 * session (useless prompt), when the folder is already linked, or
 * when skip was recorded earlier. Its primary job is to lower the
 * activation energy for the "every project knows its metaproject"
 * story; the chip in the status bar remains the fallback.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@renderer/api';
import { useAssignment } from '@renderer/metaproject/useAssignment';
import { useAssignmentOperation } from '@renderer/metaproject/assignment-operations';
import { useOptionalMetaprojectSession } from '@renderer/metaproject/session';
import { Tooltip } from './Tooltip';
import { XIcon } from './shell-icons';
import { ICON_SIZE } from './icon-size';

interface Props {
  /** Local project id. `null` when nothing is open — the banner hides. */
  readonly projectId: number | null;
  /** Opens the Project Settings tab for this project. Reused for the
   *  "Link existing" button — the Settings pane already carries the
   *  full assignment picker. */
  readonly onOpenProjectSettings: (() => void) | null;
}

type Mode = 'idle' | 'creating';

export function MetaprojectBindPrompt({ projectId, onOpenProjectSettings }: Props): React.JSX.Element | null {
  const session = useOptionalMetaprojectSession();
  if (session === null || projectId === null) return null;
  return <MountedPrompt projectId={projectId} onOpenProjectSettings={onOpenProjectSettings} />;
}

function MountedPrompt({ projectId, onOpenProjectSettings }: { projectId: number; onOpenProjectSettings: (() => void) | null }): React.JSX.Element | null {
  const { snapshot } = useOptionalMetaprojectSessionRequired();
  const { state, reload } = useAssignment(projectId);
  const [shouldPrompt, setShouldPrompt] = useState<boolean | null>(null);
  const [folderName, setFolderName] = useState<string>('project');
  const [mode, setMode] = useState<Mode>('idle');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const op = useAssignmentOperation(projectId);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  // Ask the main side whether this project has had `skip` recorded
  // yet. One IPC per project change; the banner stays hidden until we
  // know, which avoids a flicker of "Bind?" on every project switch.
  useEffect(() => {
    let cancelled = false;
    setShouldPrompt(null);
    (async () => {
      try {
        const { shouldPrompt: ok, folderName: fn } = await api.invoke('bind-prompt:status', { projectId });
        if (cancelled) return;
        setShouldPrompt(ok);
        setFolderName(fn);
        setName(fn);
      } catch { if (!cancelled) setShouldPrompt(false); }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  const assignment = state.kind === 'loaded' ? state.value : null;
  const signedIn = snapshot?.phase === 'signed-in';

  // Visibility gate — stay quiet unless EVERY condition is met. A
  // broken or linked assignment, a signed-out session, or a recorded
  // skip all hide the banner. The chip is the fallback in any of
  // those states.
  const visible = useMemo(() => {
    if (shouldPrompt !== true) return false;
    if (!signedIn) return false;
    if (!assignment || assignment.kind !== 'unlinked') return false;
    return true;
  }, [shouldPrompt, signedIn, assignment]);

  const skip = useCallback(async () => {
    try { await api.invoke('bind-prompt:skip', { projectId }); } catch { /* fail loud below */ }
    setShouldPrompt(false);
  }, [projectId]);

  const create = useCallback(async () => {
    if (!signedIn || !snapshot || snapshot.phase !== 'signed-in') return;
    const trimmed = name.trim();
    if (!trimmed) { setError('Give the project a name first.'); return; }
    setError(null);
    await op.run(async ({ apply }) => {
      if (!assignment || !('revision' in assignment)) return;
      const result = await apply(assignment, { kind: 'create', epoch: snapshot.epoch, name: trimmed });
      if (!result.ok) {
        setError(failureMessage(result.reason));
        return;
      }
      // `assignment-changed` fires from the main side and `useAssignment`
      // refetches on its own, flipping the banner's visibility gate to
      // hidden; nothing else to do here.
      reload();
      setMode('idle');
    });
  }, [signedIn, snapshot, name, op, assignment, reload]);

  if (!visible) return null;

  return (
    <aside
      role="status"
      data-testid="metaproject-bind-prompt"
      className="mx-3 mt-2 flex items-start gap-3 rounded-md border border-[--border] bg-[--accent-soft] px-3 py-2 text-[12px] text-[--text]"
    >
      <div className="flex-1">
        <div className="font-medium">Link <span className="font-mono">{folderName}</span> to a metaproject board?</div>
        <div className="text-[--text-muted] mt-0.5">Open tickets from here, badge Story rows with their ticket refs, and track progress alongside the code.</div>
        {mode === 'creating' && (
          <div className="mt-2 flex items-center gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 254))}
              autoFocus
              maxLength={254}
              placeholder="Project name"
              className="flex-1 bg-[--panel] border border-[--border] rounded-md px-2 py-1 text-[12px] outline-none focus:border-[--accent]"
              data-testid="metaproject-bind-prompt-name"
            />
            <button
              onClick={create}
              disabled={op.busy || !name.trim()}
              className="text-[11px] px-2 py-1 rounded-md border border-[color:var(--accent)]/40 text-[color:var(--accent)] hover:bg-[--accent-soft] disabled:opacity-50"
              data-testid="metaproject-bind-prompt-create-confirm"
            >
              {op.busy ? 'Creating…' : 'Create and link'}
            </button>
            <button
              onClick={() => { setMode('idle'); setError(null); }}
              className="text-[11px] px-2 py-1 rounded-md border border-[--border] text-[--text-muted] hover:bg-[--surface-hover]"
            >
              Back
            </button>
          </div>
        )}
        {error && <div role="alert" className="mt-1 text-[11px] text-[--hue-orange-soft-text]">{error}</div>}
      </div>
      {mode === 'idle' && (
        <div className="flex items-center gap-2 shrink-0">
          {onOpenProjectSettings && (
            <button
              onClick={onOpenProjectSettings}
              className="text-[11px] px-2 py-1 rounded-md border border-[--border] text-[--text] hover:bg-[--surface-hover]"
              data-testid="metaproject-bind-prompt-link"
            >
              Link existing
            </button>
          )}
          <button
            onClick={() => setMode('creating')}
            className="text-[11px] px-2 py-1 rounded-md border border-[color:var(--accent)]/40 text-[color:var(--accent)] hover:bg-[--accent-soft]"
            data-testid="metaproject-bind-prompt-create"
          >
            Create new
          </button>
          <Tooltip label="Hide this prompt for this folder. You can still bind from the status-bar chip later.">
            <button
              onClick={skip}
              aria-label="Skip bind prompt for this folder"
              className="p-1 rounded hover:bg-[--surface-hover] text-[--text-muted]"
              data-testid="metaproject-bind-prompt-skip"
            >
              <XIcon size={ICON_SIZE.sm} />
            </button>
          </Tooltip>
        </div>
      )}
    </aside>
  );
}

/** Narrower-typed accessor: inside `MountedPrompt`, an outer null-check
 *  has already proven the context is present, so pull the snapshot
 *  without re-checking at every call site. */
function useOptionalMetaprojectSessionRequired() {
  const session = useOptionalMetaprojectSession();
  if (session === null) throw new Error('bind-prompt: session context missing after gate');
  return session;
}

function failureMessage(reason: string): string {
  switch (reason) {
    case 'signed-out': return 'Not signed in to any metaproject account.';
    case 'conflict':   return 'The folder changed on disk while we were creating. Try again.';
    case 'stale':      return 'Something else changed the assignment. Reload and try again.';
    case 'invalid-input': return 'That name is not valid. Pick a shorter one.';
    default: return `Could not create the project (${reason}).`;
  }
}
