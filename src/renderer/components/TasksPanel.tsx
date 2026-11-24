import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';
import { TASK_SOURCES, TASKS_COPY, type TaskDef, type TaskNotice } from '@shared/tasks-contract';
import { createRequestGate } from '@renderer/diff/diff-load-state';
import { discoveryFor, filterTasks, groupTasks, NO_DISCOVERY, type ProjectDiscovery } from '@renderer/tasks-view';
import { ICON_SIZE, ICON_STROKE } from './icon-size';


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
 * Makefile targets, docker-compose services, and mise tasks. Refresh button + filter
 * input; each row is a click-to-run button that spawns a fresh shell tab.
 */
export function TasksPanel({ projectId, onLaunched }: Props) {
  const [found, setFound] = useState<ProjectDiscovery>(NO_DISCOVERY);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const gate = useRef(createRequestGate()).current;
  const { tasks, notices } = discoveryFor(found, projectId);

  const refresh = useCallback(async () => {
    const seq = gate.begin();
    if (projectId == null) { setFound(NO_DISCOVERY); setLoading(false); return; }
    setLoading(true);
    try {
      const res = await api.invoke('tasks:discover', { projectId });
      if (gate.isLatest(seq)) setFound({ projectId, tasks: res.tasks, notices: res.notices });
    } catch (e) {
      if (gate.isLatest(seq)) toast('Could not discover tasks', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    } finally { if (gate.isLatest(seq)) setLoading(false); }
  }, [projectId, gate]);

  useEffect(() => { void refresh(); }, [refresh]);

  const grouped = useMemo(() => groupTasks(filterTasks(tasks, filter)), [tasks, filter]);

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
        {!loading && tasks.length === 0 && notices.length === 0 && (
          <div className="p-4 text-center text-[--text-muted]">{TASKS_COPY.empty}</div>
        )}
        <TaskGroups grouped={grouped} notices={notices} running={running} onRun={run} />
      </div>
    </div>
  );
}

/** One section per source in TASK_SOURCES order; mise notices render inside the mise section. */
export function TaskGroups({ grouped, notices, running, onRun }: {
  grouped: Record<TaskDef['source'], TaskDef[]>; notices: TaskNotice[]; running: string | null; onRun: (t: TaskDef) => void;
}) {
  return (
    <>
      {TASK_SOURCES.map((source) => (
        <TaskSection
          key={source}
          title={TASKS_COPY.sectionTitle[source]}
          tasks={grouped[source]}
          notices={source === 'mise' ? notices : []}
          running={running}
          onRun={onRun}
        />
      ))}
    </>
  );
}

/** Muted one-line explanation of why a source could not be listed; no toast. */
export function TaskNoticeLine({ notice }: { notice: TaskNotice }) {
  const text = notice.kind === 'failed' ? TASKS_COPY.notice.failed(notice.detail) : TASKS_COPY.notice[notice.kind];
  return <div className="px-3 py-1 text-[10px] text-[--text-muted]">{text}</div>;
}

function TaskSection({ title, tasks, notices, running, onRun }: {
  title: string; tasks: TaskDef[]; notices: TaskNotice[]; running: string | null; onRun: (t: TaskDef) => void;
}) {
  if (tasks.length === 0 && notices.length === 0) return null;
  return (
    <div className="mb-2">
      <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[--text-muted] font-semibold">{title} ({tasks.length})</div>
      {notices.map((n) => <TaskNoticeLine key={n.kind} notice={n} />)}
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
    <svg width={ICON_SIZE.sm} height={ICON_SIZE.sm} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE.outline} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}
