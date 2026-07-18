import { useEffect, useMemo, useRef, useState } from 'react';
import { useRoots } from '@renderer/hooks/useRoots';
import { useProjects } from '@renderer/hooks/useProjects';
import { useRecents } from '@renderer/hooks/useRecents';
import { useAliveShellIds } from '@renderer/hooks/useAliveShellIds';
import type { Project, Root } from '@shared/types';
import { api } from '@renderer/api';

interface Props {
  selectedProjectId: number | null;
  onSelect: (p: Project) => void;
  onNewProject?: () => void;
  width?: number;
}

export function Sidebar({ selectedProjectId, onSelect, onNewProject, width }: Props) {
  const { roots, refresh: refreshRoots } = useRoots();
  const { projects, refresh: refreshProjects } = useProjects();
  const { recents } = useRecents(10);
  const { aliveIds } = useAliveShellIds();
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

  async function addRoot() {
    const picked = await api.invoke('dialogs:pick-directory', undefined as never);
    const path = picked.path ?? window.prompt('Root directory path (absolute):');
    if (!path) return;
    await api.invoke('roots:add', { path });
    await refreshRoots();
    await refreshProjects();
  }

  return (
    <aside
      className="h-full bg-[--panel] border-r border-[--border] flex flex-col backdrop-blur-md shrink-0"
      style={{ width: width ?? 288 }}
    >
      <div className="p-3 border-b border-[--border] space-y-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          className="w-full bg-[--panel-strong] text-sm px-2.5 py-1.5 rounded-md border border-[--border] focus:outline-none focus:ring-1 focus:ring-[--accent]/60"
        />
        <div className="flex gap-1">
          <button
            onClick={addRoot}
            className="flex-1 text-xs font-medium bg-[--panel-strong] border border-[--border] hover:bg-[--panel] transition rounded-md py-1.5"
            title="Add a root directory"
          >
            + Root
          </button>
          <button
            onClick={onNewProject}
            className="flex-1 text-xs font-medium bg-[color:var(--accent)] text-white hover:brightness-110 active:brightness-95 transition rounded-md py-1.5"
            title="Create a new project (⌘⇧N)"
            data-testid="new-project-btn"
            disabled={!onNewProject}
          >
            + Project
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {inUse.length > 0 && (
          <Section title="In use" testId="section-in-use" accent>
            {inUse.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                selected={selectedProjectId === p.id}
                alive
                onSelect={onSelect}
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
            />
          ))}
        </Section>
      </div>
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
  title, testId, accent = false, children,
}: { title: string; testId: string; accent?: boolean; children: React.ReactNode }) {
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
        {accent && <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 live-dot" />}
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
  indent = 12,
}: {
  project: Project;
  selected: boolean;
  alive: boolean;
  onSelect: (p: Project) => void;
  indent?: number;
}) {
  async function unload(e: React.MouseEvent) {
    e.stopPropagation();
    try { await api.invoke('shells:kill', { projectId: project.id, shellIndex: 0 }); }
    catch (err) { console.error(err); }
  }
  return (
    <div
      className={`group w-full flex items-center gap-2 pr-1 py-1 text-sm rounded-md mx-1 transition ${
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
        <span
          aria-hidden
          className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
            alive ? 'bg-green-500 live-dot' : selected ? 'bg-white/70' : 'bg-transparent border border-[--border]'
          }`}
        />
        <span className="truncate">{project.name}</span>
      </button>
      {alive && (
        <button
          onClick={unload}
          data-testid="row-unload"
          className={`w-4 h-4 flex items-center justify-center rounded transition ${
            selected
              ? 'text-white/80 hover:text-white hover:bg-white/15 opacity-100'
              : 'text-[--text-muted] hover:text-[--danger] hover:bg-[--panel] opacity-0 group-hover:opacity-100 focus:opacity-100'
          }`}
          title="Unload session (close shell)"
        >
          <RowXIcon />
        </button>
      )}
    </div>
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
}: {
  root: Root;
  projects: Project[];
  selectedProjectId: number | null;
  aliveIds: Set<number>;
  onSelect: (p: Project) => void;
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
          indent={22}
        />
      ))}
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
