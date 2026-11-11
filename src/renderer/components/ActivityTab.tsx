import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@renderer/api';
import type { ActivityEntry, ActivityKind } from '@shared/activity';

/**
 * Shared agent timeline. Reads the project's `.metaide/activity.jsonl` on
 * mount, then tails `activity:changed` so multiple shells (and humans)
 * looking at one project see each other's actions live. Filterable by kind;
 * follow-tail mode auto-scrolls to the newest row.
 */
export function ActivityTab({ projectId }: { projectId: number }) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [filter, setFilter] = useState<ActivityKind | 'all'>('all');
  const [follow, setFollow] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { entries } = await api.invoke('activity:list', { projectId, limit: 200 });
        if (!cancelled) setEntries(entries);
      } catch { /* ignore */ }
    })();
    const off = api.on('activity:changed', (ev) => {
      if (ev.projectId !== projectId) return;
      setEntries((prev) => {
        // Cap the in-memory buffer so a busy agent doesn't grow the renderer
        // unboundedly; older entries are still in the file and come back via
        // `activity:list` if the user reopens.
        const next = [...prev, ev.entry];
        return next.length > 1000 ? next.slice(-1000) : next;
      });
    });
    return () => { cancelled = true; off(); };
  }, [projectId]);

  useEffect(() => {
    if (!follow) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries, follow]);

  const visible = useMemo(
    () => filter === 'all' ? entries : entries.filter((e) => e.kind === filter),
    [entries, filter],
  );

  return (
    <div className="h-full flex flex-col min-h-0" data-testid="activity-tab">
      <div className="px-3 py-1.5 border-b border-[--border] text-[11px] flex items-center gap-2 overflow-hidden">
        <KindChip active={filter === 'all'}       onClick={() => setFilter('all')}>All</KindChip>
        <KindChip active={filter === 'tool'}      onClick={() => setFilter('tool')}>Tools</KindChip>
        <KindChip active={filter === 'prompt'}    onClick={() => setFilter('prompt')}>Prompts</KindChip>
        <KindChip active={filter === 'notification'} onClick={() => setFilter('notification')}>Prompts to user</KindChip>
        <KindChip active={filter === 'turn-end'}  onClick={() => setFilter('turn-end')}>Turn ends</KindChip>
        <div className="flex-1" />
        <span className="text-[--text-muted] font-mono tabular-nums">{visible.length} / {entries.length}</span>
        <label className="flex items-center gap-1 text-[--text-muted] cursor-pointer">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-[color:var(--accent)]" />
          Follow
        </label>
      </div>
      <div ref={listRef} className="flex-1 overflow-auto font-mono text-[12px] leading-[20px] p-2 min-h-0">
        {visible.length === 0 && (
          <div className="p-6 text-sm text-[--text-muted] text-center">
            No activity yet. When an agent in this project runs a tool, prompts, or finishes a turn, it shows up here.
            <br /><span className="opacity-60">Tail from a terminal: <code>tail -f .metaide/activity.jsonl</code></span>
          </div>
        )}
        {visible.map((e) => <ActivityRow key={e.id} entry={e} />)}
      </div>
    </div>
  );
}

function KindChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`text-[11px] px-2 py-0.5 rounded border ${active ? 'border-[color:var(--accent)]/50 text-[color:var(--accent)]' : 'border-[--border] hover:bg-[--panel-strong] text-[--text-muted]'}`}
    >
      {children}
    </button>
  );
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const t = entry.ts.slice(11, 19); // HH:MM:SS
  const color =
    entry.kind === 'tool'         ? 'text-[color:var(--accent)]' :
    entry.kind === 'prompt'       ? 'text-emerald-500' :
    entry.kind === 'notification' ? 'text-amber-500' :
    'text-[--text-muted]';
  const label =
    entry.kind === 'tool'         ? (entry.tool ?? 'tool') :
    entry.kind === 'prompt'       ? 'prompt' :
    entry.kind === 'notification' ? 'prompt→user' :
    'turn-end';
  const target = entry.target ?? entry.text ?? '';
  const ok = entry.kind === 'tool' && entry.ok === false ? ' ✗' : '';
  return (
    <div className="flex items-start gap-2 px-1 py-0.5 hover:bg-[--surface-hover]">
      <span className="text-[--text-muted] tabular-nums shrink-0">{t}</span>
      <span className="text-[--text-muted] tabular-nums shrink-0 opacity-70">s{entry.shellIndex}</span>
      <span className={`shrink-0 w-24 truncate ${color}`} title={entry.agent}>{label}{ok}</span>
      <span className="flex-1 min-w-0 truncate text-[--text]" title={target}>{target}</span>
    </div>
  );
}
