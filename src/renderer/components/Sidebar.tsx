import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRoots } from '@renderer/hooks/useRoots';
import { useProjects } from '@renderer/hooks/useProjects';
import { useRecents } from '@renderer/hooks/useRecents';
import { useAliveShellIds } from '@renderer/hooks/useAliveShellIds';
import { useOverallClaudeState, useProjectClaudeState } from '@renderer/hooks/useClaudeStates';
import type { Project, Root } from '@shared/types';
import type { ClaudeShellState } from '@shared/claude-state';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { StatusDot } from './StatusDot';
import { ENV_COPY } from '@renderer/project-env-copy';

interface Props {
  selectedProjectId: number | null;
  onSelect: (p: Project) => void;
  onNewProject?: () => void;
  /** Opens the environment variables editor for a project (context menu). */
  onEditEnv: (p: Project) => void;
  width?: number;
}

export function Sidebar({ selectedProjectId, onSelect, onNewProject, onEditEnv, width }: Props) {
  const { roots, refresh: refreshRoots } = useRoots();
  const { projects, refresh: refreshProjects } = useProjects();
  const { recents } = useRecents(10);
  const { aliveIds } = useAliveShellIds();
  const overallClaudeState = useOverallClaudeState();
  const [filter, setFilter] = useState('');

  // Stable order for the "In use" section: each project keeps the seq
  // number it was first observed alive with. Clicking a row updates
  // last_opened_at (which reshuffles the underlying projects list), but
  // the seq map is not touched, so the visible order stays put. When
  // a shell exits, its seq is dropped; if it comes back later, it gets
  // a fresh (higher) seq and lands at the bottom.
  const inUseSeq = useRef<Map<number, number>>(new Map());
  const inUseNextSeq = useRef(1);
  useEffect(() => {
    const map = inUseSeq.current;
    for (const id of aliveIds) if (!map.has(id)) map.set(id, inUseNextSeq.current++);
    for (const id of [...map.keys()]) if (!aliveIds.has(id)) map.delete(id);
  }, [aliveIds]);

  const inUse = useMemo(() => {
    const seq = inUseSeq.current;
    const list = projects.filter((p) => aliveIds.has(p.id));
    const sorted = list.slice().sort((a, b) => (seq.get(a.id) ?? 0) - (seq.get(b.id) ?? 0));
    if (filter) return sorted.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()));
    return sorted;
  }, [projects, aliveIds, filter]);

  // Recents excluding the ones already shown in "In use".
  const recentsShown = useMemo(() => {
    const skip = new Set(inUse.map((p) => p.id));
    const list = recents.filter((p) => !skip.has(p.id));
    if (filter) return list.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()));
    return list.slice(0, 6);
  }, [recents, inUse, filter]);

  const grouped = useMemo(() => {
    const byRoot = new Map<number, Project[]>();
    for (const p of projects) {
      if (filter && !p.name.toLowerCase().includes(filter.toLowerCase())) continue;
      if (!byRoot.has(p.rootId)) byRoot.set(p.rootId, []);
      byRoot.get(p.rootId)!.push(p);
    }
    return byRoot;
  }, [projects, filter]);

  const [rescanning, setRescanning] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Project | null>(null);
  const askRename = useCallback((p: Project) => setRenameTarget(p), []);
  async function rescanAll() {
    setRescanning(true);
    let total = 0;
    try {
      for (const r of roots) {
        const { discovered } = await api.invoke('roots:rescan', { id: r.id });
        total += discovered;
      }
      await refreshProjects();
      toast(`Rescanned ${roots.length} root${roots.length === 1 ? '' : 's'}`, { kind: 'success', detail: `${total} project folder${total === 1 ? '' : 's'} on disk` });
    } catch (e) {
      toast('Rescan failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    } finally {
      setRescanning(false);
    }
  }
  async function addRoot() {
    const picked = await api.invoke('dialogs:pick-directory', undefined as never);
    if (!picked.path) return;
    await api.invoke('roots:add', { path: picked.path });
    await refreshRoots();
    await refreshProjects();
  }

  return (
    <aside
      data-view="projects"
      className="section-panel h-full bg-[--panel] border-r border-[--border] flex flex-col backdrop-blur-md shrink-0"
      style={{ width: width ?? 288 }}
    >
      <div className="p-3 border-b border-[--border] space-y-2">
        <div className="flex items-center gap-1">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="flex-1 min-w-0 bg-[--panel-strong] text-sm px-2.5 py-1.5 rounded-md border border-[--border] focus:outline-none focus:ring-1 focus:ring-[--accent]/60"
          />
          <button
            onClick={rescanAll}
            title={rescanning ? 'Rescanning…' : 'Rescan every root — pick up newly-added folders on disk'}
            disabled={rescanning}
            className="shrink-0 w-8 h-8 flex items-center justify-center rounded-md border border-[--border] bg-[--panel-strong] hover:bg-[--panel] text-[--text-muted] hover:text-[--text] disabled:opacity-50"
            data-testid="sidebar-rescan"
          >
            <RescanIcon spinning={rescanning} />
          </button>
        </div>
        <div className="flex gap-1">
          <button
            onClick={addRoot}
            className="flex-1 text-xs font-medium bg-[--panel-strong] border border-[--border] hover:bg-[--panel] pressable rounded-md py-1.5"
            title="Add a root directory"
          >
            + Root
          </button>
          <button
            onClick={onNewProject}
            className="flex-1 text-xs font-medium bg-[color:var(--accent)] text-white hover:brightness-110 active:brightness-95 pressable rounded-md py-1.5"
            title="Create a new project (⌘⇧N)"
            data-testid="new-project-btn"
            disabled={!onNewProject}
          >
            + Project
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {inUse.length > 0 && (
          <Section title="In use" testId="section-in-use" accent dotState={overallClaudeState}>
            {inUse.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                selected={selectedProjectId === p.id}
                alive
                onSelect={onSelect}
                onRename={askRename}
                onEditEnv={onEditEnv}
              />
            ))}
          </Section>
        )}

        {recentsShown.length > 0 && (
          <Section title="Recents" testId="section-recents">
            {recentsShown.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                selected={selectedProjectId === p.id}
                alive={aliveIds.has(p.id)}
                onSelect={onSelect}
                onRename={askRename}
                onEditEnv={onEditEnv}
              />
            ))}
          </Section>
        )}

        <Section title="All projects" testId="section-all">
          {roots.map((r) => (
            <RootBlock
              key={r.id}
              root={r}
              projects={grouped.get(r.id) ?? []}
              selectedProjectId={selectedProjectId}
              aliveIds={aliveIds}
              onSelect={onSelect}
              onRename={askRename}
              onEditEnv={onEditEnv}
            />
          ))}
        </Section>
      </div>
      <RenameProjectDialog
        project={renameTarget}
        onClose={() => setRenameTarget(null)}
        onDone={async () => { setRenameTarget(null); await refreshProjects(); }}
      />
    </aside>
  );
}

const SECTION_COLLAPSED_KEY = 'metaide.sectionsCollapsed';
function readCollapsedSections(): Set<string> {
  try {
    const raw = localStorage.getItem(SECTION_COLLAPSED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}
function writeCollapsedSections(set: Set<string>): void {
  localStorage.setItem(SECTION_COLLAPSED_KEY, JSON.stringify([...set]));
}

function Section({
  title, testId, accent = false, dotState, children,
}: {
  title: string;
  testId: string;
  accent?: boolean;
  /** Worst Claude state across the section's shells (D4); only meaningful when `accent` is set. */
  dotState?: ClaudeShellState;
  children: React.ReactNode;
}) {
  const [collapsedSet, setCollapsedSet] = useState<Set<string>>(readCollapsedSections);
  const collapsed = collapsedSet.has(title);
  function toggle() {
    setCollapsedSet((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      writeCollapsedSections(next);
      return next;
    });
  }
  return (
    <div className="mb-2" data-testid={testId}>
      <button
        onClick={toggle}
        aria-expanded={!collapsed}
        data-testid={`${testId}-toggle`}
        className="w-full px-3 pt-2 pb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-[--text] hover:text-[--text] hover:bg-[--panel]/60"
      >
        <span className="inline-block w-3 transition-transform text-[--text-muted]" style={{ transform: collapsed ? 'rotate(-90deg)' : 'none' }}>▾</span>
        {accent && <StatusDot state={dotState ?? 'idle'} />}
        <span className={accent ? '' : 'text-[--text-muted]'}>{title}</span>
      </button>
      {!collapsed && children}
    </div>
  );
}

function ProjectRow({
  project,
  selected,
  alive,
  onSelect,
  onRename,
  onEditEnv,
  indent = 12,
}: {
  project: Project;
  selected: boolean;
  alive: boolean;
  onSelect: (p: Project) => void;
  /** Lifted so the Rename dialog lives at Sidebar level and stays open across rerenders. */
  onRename: (p: Project) => void;
  onEditEnv: (p: Project) => void;
  indent?: number;
}) {
  const claudeState = useProjectClaudeState(project.id);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  async function unload(e: React.MouseEvent) {
    e.stopPropagation();
    try { await api.invoke('shells:kill', { projectId: project.id, shellIndex: 0 }); }
    catch (err) { console.error(err); }
  }
  async function revealInFinder() {
    try { await api.invoke('files:reveal', { projectId: project.id, relPath: '' }); }
    catch (err) { console.error(err); }
  }
  async function copyPath() {
    try {
      await navigator.clipboard.writeText(project.path);
      toast('Copied path', { kind: 'success', timeoutMs: 1000 });
    } catch (e) {
      toast('Copy failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    }
  }
  function onContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  }
  const menuItems: ContextMenuItem[] = [
    { label: 'Rename folder…',  onClick: () => onRename(project) },
    { label: ENV_COPY.contextMenuItem, onClick: () => onEditEnv(project) },
    { label: 'Reveal in Finder', onClick: () => void revealInFinder(), separatorAfter: true },
    { label: 'Copy full path',   onClick: () => void copyPath() },
  ];
  return (
    <div
      onContextMenu={onContextMenu}
      title={`${project.path}\n(right-click for options)`}
      className={`group w-full flex items-center gap-2 pr-1 py-1 text-sm rounded-md mx-1 transition-colors ${
        selected ? 'bg-[color:var(--accent)] text-white' : 'hover:bg-[--panel-strong]'
      }`}
    >
      <button
        onClick={() => onSelect(project)}
        data-testid="project-row"
        data-alive={alive ? '1' : '0'}
        className="flex-1 min-w-0 flex items-center gap-2 text-left"
        style={{ paddingLeft: indent }}
      >
        {alive ? (
          <StatusDot state={claudeState} className="shrink-0" />
        ) : (
          <span
            aria-hidden
            className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
              selected ? 'bg-white/70' : 'bg-transparent border border-[--border]'
            }`}
          />
        )}
        <span className="truncate">{project.name}</span>
      </button>
      {alive && (
        <button
          onClick={unload}
          data-testid="row-unload"
          className={`w-4 h-4 flex items-center justify-center rounded transition-colors ${
            selected
              ? 'text-white/80 hover:text-white hover:bg-white/15 opacity-100'
              : 'text-[--text-muted] hover:text-[--danger] hover:bg-[--panel] opacity-0 group-hover:opacity-100 focus:opacity-100'
          }`}
          title="Unload session (close shell)"
        >
          <RowXIcon />
        </button>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

function RescanIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={spinning ? { animation: 'mp-spin 0.7s linear infinite' } : undefined}
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

function RowXIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

const ROOT_COLLAPSED_KEY = 'metaide.rootsCollapsed';
function readCollapsed(): Set<number> {
  try {
    const raw = localStorage.getItem(ROOT_COLLAPSED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as number[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}
function writeCollapsed(set: Set<number>): void {
  localStorage.setItem(ROOT_COLLAPSED_KEY, JSON.stringify([...set]));
}

function RootBlock({
  root,
  projects,
  selectedProjectId,
  aliveIds,
  onSelect,
  onRename,
  onEditEnv,
}: {
  root: Root;
  projects: Project[];
  selectedProjectId: number | null;
  aliveIds: Set<number>;
  onSelect: (p: Project) => void;
  onRename: (p: Project) => void;
  onEditEnv: (p: Project) => void;
}) {
  const [collapsed, setCollapsedState] = useState<Set<number>>(readCollapsed);
  const open = !collapsed.has(root.id);
  function toggle() {
    setCollapsedState((prev) => {
      const next = new Set(prev);
      if (next.has(root.id)) next.delete(root.id);
      else next.add(root.id);
      writeCollapsed(next);
      return next;
    });
  }
  const aliveInRoot = projects.filter((p) => aliveIds.has(p.id)).length;
  return (
    <div>
      <button
        onClick={toggle}
        aria-expanded={open}
        data-testid="root-toggle"
        className="w-full text-left px-3 py-1 text-xs text-[--text-muted] hover:text-[--text] flex items-center gap-1"
      >
        <span className="inline-block w-3 transition-transform" style={{ transform: open ? 'none' : 'rotate(-90deg)' }}>▾</span>
        <span className="truncate flex-1" title={root.path}>{shortenPath(root.path)}</span>
        <span className="text-[10px] opacity-70">
          {aliveInRoot > 0 ? `${aliveInRoot}/${projects.length}` : projects.length}
        </span>
      </button>
      {open && projects.map((p) => (
        <ProjectRow
          key={p.id}
          project={p}
          selected={selectedProjectId === p.id}
          alive={aliveIds.has(p.id)}
          onSelect={onSelect}
          onRename={onRename}
          onEditEnv={onEditEnv}
          indent={22}
        />
      ))}
    </div>
  );
}

/**
 * Rename a project's on-disk folder. Compact modal with an inline warning
 * that live shells will be killed and the git working dir path changes.
 * Focus is auto-set to the input; ⏎ submits, Esc dismisses.
 */
function RenameProjectDialog({
  project, onClose, onDone,
}: {
  project: Project | null;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (project) {
      setName(project.name);
      // Focus + select-all after mount so ⏎ overwrites the old name.
      const id = window.setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 20);
      return () => window.clearTimeout(id);
    }
  }, [project]);
  useEffect(() => {
    if (!project) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [project, onClose]);
  if (!project) return null;
  const trimmed = name.trim();
  const unchanged = trimmed === project.name;
  const canSubmit = trimmed.length > 0 && !unchanged && !busy;
  async function submit() {
    if (!project || !canSubmit) return;
    setBusy(true);
    try {
      await api.invoke('projects:rename', { id: project.id, newName: trimmed });
      toast(`Renamed to ${trimmed}`, { kind: 'success' });
      await onDone();
    } catch (e) {
      toast('Rename failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
      setBusy(false);
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose} data-testid="rename-project">
      <div
        className="bg-[--panel-strong] w-[440px] max-w-[92vw] rounded-xl shadow-2xl border border-[--border] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[--border]">
          <div className="font-semibold text-sm">Rename project folder</div>
          <div className="text-[11px] text-[--text-muted] truncate mt-0.5" title={project.path}>{project.path}</div>
        </div>
        <div className="p-4 space-y-3">
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            placeholder="New folder name"
            className="w-full bg-[--panel] border border-[--border] rounded-md px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-[--accent]/60"
          />
          <div className="text-[11px] text-[--text-muted] leading-relaxed">
            Renames the folder on disk and updates every reference here. Any
            live shells for this project will be closed first (the pty holds
            the old path). If this is a git repo, the working tree moves with
            it — remote URLs are unaffected.
          </div>
        </div>
        <div className="px-4 py-3 border-t border-[--border] flex justify-end gap-2">
          <button
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded-md border border-[--border] text-[--text-muted] hover:text-[--text] hover:bg-[--panel]"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="text-xs font-medium px-3 py-1.5 rounded-md pressable bg-[color:var(--accent)] text-white hover:brightness-110 disabled:opacity-50"
          >
            {busy ? 'Renaming…' : 'Rename'}
          </button>
        </div>
      </div>
    </div>
  );
}

function shortenPath(p: string): string {
  const home = '/Users/';
  if (p.startsWith(home)) {
    const rest = p.slice(home.length);
    const slash = rest.indexOf('/');
    if (slash > 0) return `~/${rest.slice(slash + 1)}`;
  }
  return p;
}
