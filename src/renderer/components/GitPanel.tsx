import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';
import { isCommitShortcut } from '@renderer/app-keys';
import { SHORTCUT_COPY } from '@renderer/shortcut-copy';
import { useShortcutPlatform } from '@renderer/shortcut-platform';
import { gitStatusTextClass } from '@renderer/git-status-style';
import { unstagePaths } from '@renderer/git-unstage-paths';
import { createRequestGate } from '@renderer/diff/diff-load-state';
import { ICON_SIZE, ICON_STROKE } from './icon-size';
import { Tooltip } from './Tooltip';
import type { GitChangeEntry } from '@shared/ipc-contract';

type FileEntry = GitChangeEntry;
interface Status {
  isRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  staged: FileEntry[];
  unstaged: FileEntry[];
  untracked: string[];
  error?: string;
}

/**
 * The Git panel's `git:panel-status` for `projectId`: fetched on mount and on project change, then
 * polled every 3s so external `git` commands (from the shell) show up. `status` is null while there
 * is no project, before the first answer, or after a failed request; `refresh` refetches now. Only
 * the latest request's response (or failure) is applied, so a slow answer for a previous project or
 * an older poll never overwrites newer lists; a poll tick is skipped while a request is in flight.
 */
export function usePanelStatus(projectId: number | null): { status: Status | null; refresh: () => Promise<void> } {
  const [status, setStatus] = useState<Status | null>(null);
  const gateRef = useRef(createRequestGate());

  const load = useCallback(async (fromPoll: boolean) => {
    const gate = gateRef.current;
    if (projectId == null) { gate.invalidate(); setStatus(null); return; }
    if (fromPoll && gate.inFlight) return;
    const seq = gate.begin();
    try {
      const s = await api.invoke('git:panel-status', { projectId });
      if (gate.isLatest(seq)) setStatus(s);
    } catch {
      if (gate.isLatest(seq)) setStatus(null);
    } finally {
      gate.settle(seq);
    }
  }, [projectId]);

  const refresh = useCallback(() => load(false), [load]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const id = window.setInterval(() => { void load(true); }, 3000);
    return () => window.clearInterval(id);
  }, [load]);

  return { status, refresh };
}

/**
 * Compact git surface: staged / unstaged / untracked lists with per-row
 * stage-unstage buttons, a commit message input, and Commit / Push / Pull.
 * Deliberately narrow scope — this is not a diff viewer or history browser;
 * it covers the 80% of git you'd otherwise `git add` in the terminal for.
 * A row click delegates the diff to the Diff tab via `onOpenInDiff` so the
 * full side-by-side view lives in exactly one place (AC33 rev 2).
 */
export function GitPanel({ projectId, onOpenInDiff }: { projectId: number | null; onOpenInDiff?: (entryKey: string) => void }) {
  const platform = useShortcutPlatform();
  const { status, refresh } = usePanelStatus(projectId);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const untrackedAsEntries = useMemo<FileEntry[]>(
    () => (status?.untracked ?? []).map((path) => ({ path, status: '?' as const })),
    [status?.untracked],
  );

  async function run<T>(label: string, fn: () => Promise<T>) {
    setBusy(label);
    try { return await fn(); }
    finally { setBusy(null); void refresh(); }
  }

  async function stageAll() {
    const paths = [...(status?.unstaged ?? []).map((f) => f.path), ...(status?.untracked ?? [])];
    if (paths.length === 0) return;
    await run('stage-all', () => api.invoke('git:stage', { projectId: projectId!, paths }));
  }
  async function unstageAll() {
    const paths = unstagePaths(status?.staged ?? []);
    if (paths.length === 0) return;
    await run('unstage-all', () => api.invoke('git:unstage', { projectId: projectId!, paths }));
  }
  async function stageOne(path: string) {
    await run(`stage:${path}`, () => api.invoke('git:stage', { projectId: projectId!, paths: [path] }));
  }
  async function unstageOne(file: FileEntry) {
    await run(`unstage:${file.path}`, () => api.invoke('git:unstage', { projectId: projectId!, paths: unstagePaths([file]) }));
  }
  async function commit() {
    const msg = message.trim();
    if (!msg) return;
    try {
      await run('commit', () => api.invoke('git:commit', { projectId: projectId!, message: msg }));
      toast('Commit created', { kind: 'success' });
      setMessage('');
    } catch (e) {
      toast('Commit failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    }
  }

  async function draftCommitMessage() {
    if (projectId == null) return;
    const staged = status?.staged ?? [];
    if (staged.length === 0) {
      toast('Nothing staged', { kind: 'info', detail: 'Stage some files first; Claude needs a diff to work with.' });
      return;
    }
    setBusy('draft-commit');
    try {
      // Pull per-file diffs and concatenate — git doesn't expose a "staged diff" tool
      // via the Diff tab's IPC, but 'git:file-diff' with staged:true does one file at a time.
      const pieces: string[] = [];
      for (const f of staged) {
        try {
          const r = await api.invoke('git:file-diff', { projectId, path: f.path, origPath: f.origPath, staged: true });
          if (r.diff) pieces.push(r.diff);
        } catch {
          // Skip a single file that errored; the others still produce a useful message.
        }
      }
      const combined = pieces.join('\n\n');
      if (!combined.trim()) {
        toast('Couldn’t read staged diff', { kind: 'error' });
        return;
      }
      const r = await api.invoke('diff:explain', {
        projectId,
        kind: 'commit',
        diff: combined,
      });
      if (r.status === 'ok') setMessage(r.text);
      else toast('Couldn’t draft message', { kind: 'error', detail: r.message });
    } finally {
      setBusy(null);
    }
  }
  async function push() {
    try {
      const res = await run('push', () => api.invoke('git:push', { projectId: projectId! }));
      toast('Pushed', { kind: 'success', detail: res.output.split('\n').slice(-3).join('\n') });
    } catch (e) { toast('Push failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') }); }
  }
  async function pull() {
    try {
      const res = await run('pull', () => api.invoke('git:pull', { projectId: projectId! }));
      toast('Pulled', { kind: 'success', detail: res.output.split('\n').slice(-3).join('\n') });
    } catch (e) { toast('Pull failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') }); }
  }

  if (projectId == null) {
    return <EmptyPanel text="Pick a project first." />;
  }
  if (!status) {
    return <EmptyPanel text="Loading git status…" />;
  }
  if (!status.isRepo) {
    return <EmptyPanel text="Not a git repository." />;
  }

  const nothingToDo = status.staged.length === 0 && status.unstaged.length === 0 && status.untracked.length === 0;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="px-3 py-2 border-b border-[--border] flex items-center gap-2 shrink-0">
        <BranchIcon />
        <span className="text-sm font-medium truncate flex-1" title={status.branch ?? ''}>{status.branch ?? 'detached'}</span>
        {status.ahead  > 0 && <span className="text-[10px] font-mono text-[color:var(--git-added,#34d399)] px-1 rounded bg-[color:var(--git-ahead-chip,rgb(52_211_153/0.1))]">↑{status.ahead}</span>}
        {status.behind > 0 && <span className="text-[10px] font-mono text-[color:var(--git-deleted,#fb7185)] px-1 rounded bg-[color:var(--git-behind-chip,rgb(251_113_133/0.1))]">↓{status.behind}</span>}
        <Tooltip label="Refresh git status">
          <button
            onClick={refresh}
            className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel-strong]"
            aria-label="Refresh git status"
            data-testid="git-refresh"
          >
            <RefreshIcon />
          </button>
        </Tooltip>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 px-2 py-2 space-y-3 text-xs">
        {status.error ? (
          <div className="text-center text-[--danger] py-6 whitespace-pre-wrap break-words">{status.error}</div>
        ) : nothingToDo && (
          <div className="text-center text-[--text-muted] py-6">Nothing to commit — working tree clean.</div>
        )}
        <Section title="Staged" count={status.staged.length} onBulk={unstageAll} bulkLabel="Unstage all">
          {status.staged.map((f) => (
            <Row key={`s:${f.path}`} file={f} group="staged" onAction={() => void unstageOne(f)} action="−" busy={busy === `unstage:${f.path}`} onOpenInDiff={onOpenInDiff} />
          ))}
        </Section>
        <Section title="Changes" count={status.unstaged.length + untrackedAsEntries.length} onBulk={stageAll} bulkLabel="Stage all">
          {status.unstaged.map((f) => (
            <Row key={`u:${f.path}`} file={f} group="unstaged" onAction={() => void stageOne(f.path)} action="+" busy={busy === `stage:${f.path}`} onOpenInDiff={onOpenInDiff} />
          ))}
          {untrackedAsEntries.map((f) => (
            <Row key={`t:${f.path}`} file={f} group="untracked" onAction={() => void stageOne(f.path)} action="+" busy={busy === `stage:${f.path}`} onOpenInDiff={onOpenInDiff} />
          ))}
        </Section>
      </div>

      <div className="border-t border-[--border] p-2 space-y-2 shrink-0 bg-[--panel]/40">
        <div className="relative">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => { if (isCommitShortcut(e, platform)) void commit(); }}
            placeholder={SHORTCUT_COPY.commitPlaceholder(platform)}
            rows={2}
            className="w-full resize-none bg-[--panel-strong] border border-[--border] rounded-md px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-[--accent]/60"
            data-testid="git-message"
          />
          <Tooltip label="Draft a commit message from the staged diff">
            <button
              type="button"
              onClick={() => void draftCommitMessage()}
              disabled={busy !== null || (status?.staged.length ?? 0) === 0}
              className="absolute right-1 bottom-1 text-[10px] px-1.5 py-0.5 rounded border border-[--border] bg-[--panel]/80 text-[--text-muted] hover:text-[--text] hover:bg-[--panel-strong] disabled:opacity-40"
              aria-label="Draft a commit message from the staged diff"
              data-testid="git-draft-message"
            >
              {busy === 'draft-commit' ? 'Drafting…' : 'Suggest'}
            </button>
          </Tooltip>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={commit}
            disabled={!message.trim() || status.staged.length === 0 || !!busy}
            className="flex-1 text-xs font-medium px-3 py-1.5 rounded-md pressable bg-[color:var(--accent)] text-[--accent-text] hover:brightness-110 disabled:opacity-50"
            data-testid="git-commit"
          >
            {busy === 'commit' ? 'Committing…' : `Commit${status.staged.length ? ` (${status.staged.length})` : ''}`}
          </button>
          <button
            onClick={pull}
            disabled={!!busy}
            className="text-xs px-2 py-1.5 rounded-md border border-[--border] hover:bg-[--panel-strong] disabled:opacity-50"
            title="git pull"
          >
            {busy === 'pull' ? '…' : 'Pull'}
          </button>
          <button
            onClick={push}
            disabled={!!busy}
            className="text-xs px-2 py-1.5 rounded-md border border-[--border] hover:bg-[--panel-strong] disabled:opacity-50"
            title="git push"
          >
            {busy === 'push' ? '…' : 'Push'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, count, onBulk, bulkLabel, children }: {
  title: string; count: number; onBulk: () => void; bulkLabel: string; children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div>
      <div className="flex items-center gap-2 px-1 py-1">
        <span className="text-[10px] uppercase tracking-wider font-semibold text-[--text-muted] flex-1">{title} <span className="opacity-60">({count})</span></span>
        <button
          onClick={onBulk}
          className="text-[10px] text-[color:var(--accent-label,var(--accent))] hover:brightness-110"
        >
          {bulkLabel}
        </button>
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Row({ file, group, onAction, action, busy, onOpenInDiff }: {
  file: FileEntry;
  group: 'staged' | 'unstaged' | 'untracked';
  onAction: () => void;
  action: '+' | '−';
  busy: boolean;
  onOpenInDiff?: (entryKey: string) => void;
}) {
  const color = gitStatusTextClass(file.status);
  const entryKey = `${group}:${file.path}`;
  const open = onOpenInDiff ? () => onOpenInDiff(entryKey) : undefined;
  return (
    <div className="rounded hover:bg-[--panel-strong]/60">
      <div className="group flex items-center gap-2 px-1.5 py-1">
        <span className={`w-4 text-center font-mono text-[10px] ${color}`}>{file.status}</span>
        <button
          onClick={open}
          disabled={!open}
          className="flex-1 flex items-center gap-1 text-left truncate font-mono text-[11px] hover:text-[--text] disabled:cursor-default"
          title={`Open ${file.path} in Diff tab`}
          data-testid={`git-row-${file.path}`}
        >
          <span className="truncate">{file.path}</span>
        </button>
        <Tooltip label={action === '+' ? 'Stage this file' : 'Unstage this file'} wrapClassName="opacity-0 group-hover:opacity-100">
          <button
            onClick={onAction}
            disabled={busy}
            className="disabled:opacity-40 w-5 h-5 flex items-center justify-center rounded text-[--text-muted] hover:text-[--text] hover:bg-[--panel] text-xs"
            aria-label={action === '+' ? 'Stage this file' : 'Unstage this file'}
          >
            {busy ? '…' : action}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

function EmptyPanel({ text }: { text: string }) {
  return (
    <div className="h-full flex items-center justify-center p-6 text-xs text-[--text-muted] text-center">{text}</div>
  );
}

function BranchIcon() {
  return (
    <svg width={ICON_SIZE.sm} height={ICON_SIZE.sm} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE.outline} strokeLinecap="round" strokeLinejoin="round" className="text-[--text-muted]">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v4a4 4 0 0 0 4 4h5.5" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width={ICON_SIZE.sm} height={ICON_SIZE.sm} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE.outline} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}
