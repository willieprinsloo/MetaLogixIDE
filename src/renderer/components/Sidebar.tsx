import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rootHueVar } from '@renderer/root-hue';
import { useRoots } from '@renderer/hooks/useRoots';
import { useProjects } from '@renderer/hooks/useProjects';
import { useRecents } from '@renderer/hooks/useRecents';
import { useAliveShellIds } from '@renderer/hooks/useAliveShellIds';
import { useOverallAgentState, useProjectAgentState } from '@renderer/hooks/useAgentStates';
import type { Project, Root } from '@shared/types';
import type { AgentState } from '@shared/agent-state';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';
import { AnimatePresence } from 'motion/react';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { ModalFrame } from './ModalFrame';
import { StatusDot } from './StatusDot';
import { RootFolderGlyph, rootFolderName } from './RootFolderGlyph';
import { ENV_COPY } from '@renderer/project-env-copy';
import { SIDEBAR_COPY, SIDEBAR_TESTIDS, SECTION_PERSIST_KEYS } from '@renderer/sidebar-copy';
import { SIDEBAR_WIDTH } from '@renderer/sidebar-width';
import { SidebarHeader } from './SidebarHeader';
import { PROJECT_SETTINGS_COPY, type ProjectSettingsTarget } from '@renderer/project-settings-contract';

interface Props {
  selectedProjectId: number | null;
  onSelect: (p: Project) => void;
  onNewProject?: () => void;
  /** Opens the environment variables editor for a project (context menu). */
  onEditEnv: (p: Project) => void;
  onProjectSettings: (target: ProjectSettingsTarget) => void;
  width?: number;
}

export function Sidebar({ selectedProjectId, onSelect, onNewProject, onEditEnv, onProjectSettings, width }: Props) {
  const { roots, refresh: refreshRoots } = useRoots();
  const { projects, refresh: refreshProjects } = useProjects();
  const { recents } = useRecents(10);
  const { aliveIds } = useAliveShellIds();
  const overallAgentState = useOverallAgentState();
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

  const [renameTarget, setRenameTarget] = useState<Project | null>(null);
  const askRename = useCallback((p: Project) => setRenameTarget(p), []);

  return (
    <aside
      data-view="projects"
      className="section-panel h-full flex flex-col gap-7 shrink-0 pt-1 pb-5 pl-2"
      style={{ width: width ?? SIDEBAR_WIDTH.default }}
    >
      <div className="pr-4">
        <SidebarHeader
          filter={filter}
          onFilterChange={setFilter}
          onNewProject={onNewProject}
          roots={roots}
          refreshRoots={refreshRoots}
          refreshProjects={refreshProjects}
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden pr-4 flex flex-col gap-7">
        {inUse.length > 0 && (
          <Section title="In use" testId="section-in-use" accent dotState={overallAgentState}>
            {inUse.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                selected={selectedProjectId === p.id}
                alive
                onSelect={onSelect}
                onRename={askRename}
                onEditEnv={onEditEnv}
                onProjectSettings={onProjectSettings}
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
                onProjectSettings={onProjectSettings}
              />
            ))}
          </Section>
        )}

        <Section title={SIDEBAR_COPY.projectsHeading} persistKey={SECTION_PERSIST_KEYS.projects} testId={SIDEBAR_TESTIDS.sectionAll}>
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
              onProjectSettings={onProjectSettings}
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
  title, persistKey = title, testId, accent = false, dotState, children,
}: {
  title: string;
  /** Collapse-state key; defaults to `title`, so a renamed section can keep its stored state. */
  persistKey?: string;
  testId: string;
  accent?: boolean;
  /** Worst severity among the section's shells, independent of agent identity. */
  dotState?: AgentState;
  children: React.ReactNode;
}) {
  const [collapsedSet, setCollapsedSet] = useState<Set<string>>(readCollapsedSections);
  const collapsed = collapsedSet.has(persistKey);
  function toggle() {
    setCollapsedSet((prev) => {
      const next = new Set(prev);
      if (next.has(persistKey)) next.delete(persistKey);
      else next.add(persistKey);
      writeCollapsedSections(next);
      return next;
    });
  }
  return (
    <div data-testid={testId}>
      <button
        onClick={toggle}
        aria-expanded={!collapsed}
        data-testid={`${testId}-toggle`}
        className="w-full h-[26px] mb-1 px-0 flex items-center gap-2 text-left text-[11px] uppercase tracking-[0.06em] font-medium text-[--text]"
      >
        {accent && <StatusDot state={dotState ?? 'idle'} />}
        <span className={`flex-1 ${accent ? '' : 'text-[--text-muted]'}`}>{title}</span>
        <ChevronIcon collapsed={collapsed} />
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
  onProjectSettings,
  indent = 0,
}: {
  project: Project;
  selected: boolean;
  alive: boolean;
  onSelect: (p: Project) => void;
  /** Lifted so the Rename dialog lives at Sidebar level and stays open across rerenders. */
  onRename: (p: Project) => void;
  onEditEnv: (p: Project) => void;
  onProjectSettings: (target: ProjectSettingsTarget) => void;
  indent?: number;
}) {
  const agentState = useProjectAgentState(project.id);
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
  function openKeyboardMenu(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    setMenu({ x: bounds.left, y: bounds.bottom });
  }
  const menuItems: ContextMenuItem[] = [
    { label: 'Rename folder…',  onClick: () => onRename(project) },
    { label: ENV_COPY.contextMenuItem, onClick: () => onEditEnv(project) },
    { label: PROJECT_SETTINGS_COPY.contextMenuItem, onClick: () => {
      onProjectSettings({ id: project.id, name: project.name, path: project.path });
    } },
    { label: 'Reveal in Finder', onClick: () => void revealInFinder(), separatorAfter: true },
    { label: 'Copy full path',   onClick: () => void copyPath() },
  ];
  return (
    <div
      onContextMenu={onContextMenu}
      title={`${project.path}\n(right-click for options)`}
      className={`group w-full h-[34px] flex items-center gap-2.5 px-2.5 text-sm rounded-lg transition-colors ${
        selected ? 'bg-[--accent-soft] text-[--text] font-medium' : 'hover:bg-[--surface-hover]'
      }`}
    >
      <button
        onKeyDown={openKeyboardMenu}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={() => onSelect(project)}
        data-testid="project-row"
        data-alive={alive ? '1' : '0'}
        className="flex-1 min-w-0 h-full flex items-center gap-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-mark,var(--accent))] rounded-lg"
        style={{ paddingLeft: indent }}
      >
        {alive ? (
          <StatusDot state={agentState} className="shrink-0" />
        ) : (
          <span
            aria-hidden
            className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
              selected ? 'bg-[color:var(--accent-mark,var(--accent))]' : 'bg-[--surface-active]'
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
              ? 'text-[--text-muted] hover:text-[--danger] hover:bg-[--surface-hover] opacity-100'
              : 'text-[--text-muted] hover:text-[--danger] hover:bg-[--surface-hover] opacity-0 group-hover:opacity-100 focus:opacity-100'
          }`}
          title="Unload session (close shell)"
        >
          <RowXIcon />
        </button>
      )}
      <AnimatePresence>
        {menu && (
          <ContextMenu key="context-menu" x={menu.x} y={menu.y} items={menuItems} autoFocus onClose={() => setMenu(null)} />
        )}
      </AnimatePresence>
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
  onRename,
  onEditEnv,
  onProjectSettings,
}: {
  root: Root;
  projects: Project[];
  selectedProjectId: number | null;
  aliveIds: Set<number>;
  onSelect: (p: Project) => void;
  onRename: (p: Project) => void;
  onEditEnv: (p: Project) => void;
  onProjectSettings: (target: ProjectSettingsTarget) => void;
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
        className="w-full text-left px-2.5 py-1 text-xs text-[--text-muted] hover:text-[--text] flex items-center gap-2.5"
      >
        <RootFolderGlyph color={rootHueVar(root.path)} />
        <span className="truncate flex-1" title={root.path}>{rootFolderName(root.path)}</span>
        <span className="text-[10px] opacity-70">
          {aliveInRoot > 0 ? `${aliveInRoot}/${projects.length}` : projects.length}
        </span>
        <ChevronIcon collapsed={!open} />
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
          onProjectSettings={onProjectSettings}
          indent={12}
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
export function RenameProjectDialog({
  project, onClose, onDone,
}: {
  project: Project | null;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}): React.JSX.Element | null {
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
    <ModalFrame
      testId="rename-project"
      tier="modal"
      motion="none"
      layerClassName="flex items-center justify-center"
      onDismiss={onClose}
    >
      <div className="modal-sheet w-[440px] max-w-[92vw] overflow-hidden">
        <div className="px-4 py-3 border-b border-[--border]">
          <div className="font-semibold text-sm">Rename project folder</div>
          <div className="text-[11px] text-[--modal-text-muted] truncate mt-0.5" title={project.path}>{project.path}</div>
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
          <div className="text-[11px] text-[--modal-text-muted] leading-relaxed">
            Renames the folder on disk and updates every reference here. Any
            live shells for this project will be closed first (the pty holds
            the old path). If this is a git repo, the working tree moves with
            it — remote URLs are unaffected.
          </div>
        </div>
        <div className="px-4 py-3 border-t border-[--border] flex justify-end gap-2">
          <button
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded-md border border-[--border] text-[--modal-text-muted] hover:text-[--text] hover:bg-[--panel]"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="text-xs font-medium px-3 py-1.5 rounded-md pressable bg-[color:var(--accent)] text-[--accent-text] hover:brightness-110 disabled:opacity-50"
          >
            {busy ? 'Renaming…' : 'Rename'}
          </button>
        </div>
      </div>
    </ModalFrame>
  );
}

/** Collapse chevron for section and root-group toggles: points down when open, right when collapsed. */
function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      aria-hidden
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-[--text-muted] transition-transform duration-150"
      style={{ transform: collapsed ? 'rotate(-90deg)' : 'none' }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

