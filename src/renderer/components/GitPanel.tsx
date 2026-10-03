import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';

interface FileEntry { path: string; status: 'M' | 'A' | 'D' | 'R' | 'U' | '?' | '!' }
interface Status {
  isRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  staged: FileEntry[];
  unstaged: FileEntry[];
  untracked: string[];
}

/**
 * Compact git surface: staged / unstaged / untracked lists with per-row
 * stage-unstage buttons, a commit message input, and Commit / Push / Pull.
 * Deliberately narrow scope — this is not a diff viewer or history browser;
 * it covers the 80% of git you'd otherwise `git add` in the terminal for.
 */
export function GitPanel({ projectId }: { projectId: number | null }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (projectId == null) { setStatus(null); return; }
    try {
      const s = await api.invoke('git:panel-status', { projectId });
      setStatus(s);
    } catch { setStatus(null); }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);
  // Poll every 3s so external `git` commands (from the shell) show up.
  useEffect(() => {
    const id = window.setInterval(refresh, 3000);
    return () => window.clearInterval(id);
  }, [refresh]);

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
    const paths = (status?.staged ?? []).map((f) => f.path);
    if (paths.length === 0) return;
    await run('unstage-all', () => api.invoke('git:unstage', { projectId: projectId!, paths }));
  }
  async function stageOne(path: string) {
    await run(`stage:${path}`, () => api.invoke('git:stage', { projectId: projectId!, paths: [path] }));
  }
  async function unstageOne(path: string) {
    await run(`unstage:${path}`, () => api.invoke('git:unstage', { projectId: projectId!, paths: [path] }));
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
        {status.ahead  > 0 && <span className="text-[10px] font-mono text-emerald-400 px-1 rounded bg-emerald-400/10">↑{status.ahead}</span>}
        {status.behind > 0 && <span className="text-[10px] font-mono text-rose-400 px-1 rounded bg-rose-400/10">↓{status.behind}</span>}
        <button
          onClick={refresh}
          className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel-strong]"
          title="Refresh"
          data-testid="git-refresh"
        >
          <RefreshIcon />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 px-2 py-2 space-y-3 text-xs">
        {nothingToDo && (
          <div className="text-center text-[--text-muted] py-6">Nothing to commit — working tree clean.</div>
        )}
        <Section title="Staged" count={status.staged.length} onBulk={unstageAll} bulkLabel="Unstage all">
          {status.staged.map((f) => (
            <Row key={`s:${f.path}`} projectId={projectId!} file={f} staged onAction={() => void unstageOne(f.path)} action="−" busy={busy === `unstage:${f.path}`} />
          ))}
        </Section>
        <Section title="Changes" count={status.unstaged.length + untrackedAsEntries.length} onBulk={stageAll} bulkLabel="Stage all">
          {status.unstaged.map((f) => (
            <Row key={`u:${f.path}`} projectId={projectId!} file={f} onAction={() => void stageOne(f.path)} action="+" busy={busy === `stage:${f.path}`} />
          ))}
          {untrackedAsEntries.map((f) => (
            <Row key={`t:${f.path}`} projectId={projectId!} file={f} untracked onAction={() => void stageOne(f.path)} action="+" busy={busy === `stage:${f.path}`} />
          ))}
        </Section>
      </div>

      <div className="border-t border-[--border] p-2 space-y-2 shrink-0 bg-[--panel]/40">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void commit(); }}
          placeholder="Commit message — ⌘Enter to commit"
          rows={2}
          className="w-full resize-none bg-[--panel-strong] border border-[--border] rounded-md px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-[--accent]/60"
          data-testid="git-message"
        />
        <div className="flex items-center gap-1.5">
          <button
            onClick={commit}
            disabled={!message.trim() || status.staged.length === 0 || !!busy}
            className="flex-1 text-xs font-medium px-3 py-1.5 rounded-md pressable bg-[color:var(--accent)] text-white hover:brightness-110 disabled:opacity-50"
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
          className="text-[10px] text-[color:var(--accent)] hover:brightness-110"
        >
          {bulkLabel}
        </button>
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Row({ projectId, file, onAction, action, busy, staged, untracked }: {
  projectId: number;
  file: FileEntry;
  onAction: () => void;
  action: '+' | '−';
  busy: boolean;
  /** True when this row lives in the "Staged" section — diff comes from --cached. */
  staged?: boolean;
  /** True when the file has never been tracked — diff comes from --no-index. */
  untracked?: boolean;
}) {
  const color =
    file.status === 'M' ? 'text-amber-400' :
    file.status === 'A' ? 'text-emerald-400' :
    file.status === 'D' ? 'text-rose-400' :
    file.status === '?' ? 'text-sky-400' :
    'text-[--text-muted]';
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);

  async function toggle() {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (diff != null) return;
    setDiffBusy(true);
    try {
      const { diff } = await api.invoke('git:file-diff', { projectId, path: file.path, staged, untracked });
      setDiff(diff || '(no changes)');
    } catch (e) {
      setDiff(`Error: ${String(e).replace(/^Error:\s*/, '')}`);
    } finally { setDiffBusy(false); }
  }

  return (
    <div className="rounded hover:bg-[--panel-strong]/60">
      <div className="group flex items-center gap-2 px-1.5 py-1">
        <span className={`w-4 text-center font-mono text-[10px] ${color}`}>{file.status}</span>
        <button
          onClick={toggle}
          className="flex-1 flex items-center gap-1 text-left truncate font-mono text-[11px] hover:text-[--text]"
          title={`Toggle diff for ${file.path}`}
        >
          <span className={`text-[--text-muted] transition-transform inline-block w-2 ${open ? 'rotate-90' : ''}`}>▸</span>
          <span className="truncate">{file.path}</span>
        </button>
        <button
          onClick={onAction}
          disabled={busy}
          className="opacity-0 group-hover:opacity-100 disabled:opacity-40 w-5 h-5 flex items-center justify-center rounded text-[--text-muted] hover:text-[--text] hover:bg-[--panel] text-xs"
          title={action === '+' ? 'Stage' : 'Unstage'}
        >
          {busy ? '…' : action}
        </button>
      </div>
      {open && (
        <div className="ml-6 mr-1 mb-1 rounded border border-[--border] bg-[--panel] max-h-[240px] overflow-auto text-[10px] font-mono">
          {diffBusy && <div className="px-2 py-1 text-[--text-muted]">Loading diff…</div>}
          {diff != null && !diffBusy && <DiffView text={diff} />}
        </div>
      )}
    </div>
  );
}

/** Simple unified-diff renderer — colours + / - / @@ lines VS Code-style. */
function DiffView({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <pre className="whitespace-pre">
      {lines.map((l, i) => {
        let cls = 'text-[--text-muted]';
        // Skip the file headers ("diff --git", "index …", "---", "+++") from
        // dominating the coloured output.
        if (l.startsWith('@@')) cls = 'text-sky-400';
        else if (l.startsWith('+') && !l.startsWith('+++')) cls = 'text-emerald-400 bg-emerald-500/5';
        else if (l.startsWith('-') && !l.startsWith('---')) cls = 'text-rose-400 bg-rose-500/5';
        else if (l.startsWith('diff --git') || l.startsWith('index ') || l.startsWith('+++') || l.startsWith('---')) cls = 'text-[--text-muted] opacity-60';
        return <div key={i} className={`px-2 ${cls}`}>{l || ' '}</div>;
      })}
    </pre>
  );
}

function EmptyPanel({ text }: { text: string }) {
  return (
    <div className="h-full flex items-center justify-center p-6 text-xs text-[--text-muted] text-center">{text}</div>
  );
}

function BranchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[--text-muted]">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v4a4 4 0 0 0 4 4h5.5" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}
