import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';

interface TaskDef {
  id: string;
  source: 'npm' | 'make' | 'compose';
  name: string;
  command: string[];
  description?: string;
}

interface Props {
  projectId: number | null;
  /**
   * Notify the parent that a new shell has been spawned so it can flip
   * to the Shell tab and set the active shellIndex. Without this the
   * task would silently run in a hidden tab.
   */
  onLaunched: (shellIndex: number) => void;
}

/**
 * Auto-discovered runnable tasks for the current project — npm scripts,
 * Makefile targets, and docker-compose services. Refresh button + filter
 * input; each row is a click-to-run button that spawns a fresh shell tab.
 */
export function TasksPanel({ projectId, onLaunched }: Props) {
  const [tasks, setTasks] = useState<TaskDef[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (projectId == null) { setTasks([]); return; }
    setLoading(true);
    try {
      const { tasks } = await api.invoke('tasks:discover', { projectId });
      setTasks(tasks);
    } catch (e) {
      toast('Could not discover tasks', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    } finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter((t) => t.name.toLowerCase().includes(q) || (t.description ?? '').toLowerCase().includes(q));
  }, [tasks, filter]);

  const grouped = useMemo(() => {
    const g: Record<TaskDef['source'], TaskDef[]> = { npm: [], make: [], compose: [] };
    for (const t of filtered) g[t.source].push(t);
    return g;
  }, [filtered]);

  async function run(task: TaskDef) {
    if (projectId == null) return;
    setRunning(task.id);
    try {
      const { shellIndex } = await api.invoke('tasks:run', { projectId, taskId: task.id });
      toast(`Running ${task.name}`, { kind: 'success', timeoutMs: 1200 });
      onLaunched(shellIndex);
    } catch (e) {
      toast('Failed to run', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    } finally { setRunning(null); }
  }

  if (projectId == null) return <EmptyPanel text="Pick a project first." />;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="px-3 py-2 border-b border-[--border] flex items-center gap-2 shrink-0">
        <span className="text-sm font-medium">Tasks</span>
        <span className="text-[10px] text-[--text-muted]">{tasks.length} found</span>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          className="ml-auto w-32 bg-[--panel-strong] border border-[--border] rounded px-2 py-0.5 text-[11px] outline-none focus:ring-1 focus:ring-[--accent]/60"
        />
        <button
          onClick={refresh}
          className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel-strong]"
          title="Rediscover"
        >
          <RefreshIcon />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto py-1 text-xs">
        {loading && tasks.length === 0 && (
          <div className="p-4 text-center text-[--text-muted]">Scanning…</div>
        )}
        {!loading && tasks.length === 0 && (
          <div className="p-4 text-center text-[--text-muted]">
            No package.json scripts, Makefile targets, or compose services in this project.
          </div>
        )}
        <TaskSection title="npm scripts" tasks={grouped.npm} running={running} onRun={run} />
        <TaskSection title="Makefile"    tasks={grouped.make} running={running} onRun={run} />
        <TaskSection title="docker compose" tasks={grouped.compose} running={running} onRun={run} />
      </div>
    </div>
  );
}

function TaskSection({ title, tasks, running, onRun }: {
  title: string; tasks: TaskDef[]; running: string | null; onRun: (t: TaskDef) => void;
}) {
  if (tasks.length === 0) return null;
  return (
    <div className="mb-2">
      <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[--text-muted] font-semibold">{title} ({tasks.length})</div>
      <div className="space-y-0.5">
        {tasks.map((t) => (
          <button
            key={t.id}
            onClick={() => onRun(t)}
            disabled={running === t.id}
            className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-[--panel-strong] disabled:opacity-50"
            title={t.command.join(' ')}
          >
            <span className="text-[color:var(--accent-mark,var(--accent))] w-3 text-center">▶</span>
            <span className="font-medium text-[--text] truncate">{t.name}</span>
            {t.description && <span className="text-[10px] text-[--text-muted] truncate flex-1">{t.description}</span>}
            {running === t.id && <span className="text-[10px] text-[--text-muted]">launching…</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

function EmptyPanel({ text }: { text: string }) {
  return <div className="h-full flex items-center justify-center p-6 text-xs text-[--text-muted] text-center">{text}</div>;
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
