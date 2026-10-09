import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { Sidebar } from './components/Sidebar';
import { ProjectSwitcher } from './components/ProjectSwitcher';
import { StatusBar } from './components/StatusBar';
import { TitleGroup } from './components/TitleGroup';
import { CHROME_TESTIDS } from './chrome-testids';
import { SIDEBAR_WIDTH, useSidebarWidth } from './sidebar-width';
import { ShellTab } from './components/ShellTab';
import { FilesTab } from './components/FilesTab';
import { ChatTab } from './components/ChatTab';
import { GitPanel } from './components/GitPanel';
import { Settings } from './components/Settings';
import type { SettingsSection } from './components/settings/nav-icons';
import { ResizeHandle } from './components/ResizeHandle';
import { FileFinder } from './components/FileFinder';
import { NewProjectDialog } from './components/NewProjectDialog';
import { ActivityBar, type ActivityView } from './components/ActivityBar';
import { CommandPalette, type Command } from './components/CommandPalette';
import { ProjectSearch } from './components/ProjectSearch';
import { PromptLibrary } from './components/PromptLibrary';
import { ScrollbackSearch } from './components/ScrollbackSearch';
import { TasksPanel } from './components/TasksPanel';
import { ToastStack } from './components/ToastStack';
import { PermissionModeDialog } from './components/PermissionModeDialog';
import { ProjectEnvTab } from './components/ProjectEnvTab';
import { DiffTab } from './components/DiffTab';
import { ENV_COPY, ENV_TESTIDS } from './project-env-copy';
import { DIFF_COPY, DIFF_TESTIDS } from './diff-tab-copy';
import { diffTabCount } from './diff/diff-selection';
import { isMainTab, type MainTab } from './main-tab';
import { useEnvDrafts } from './hooks/useEnvDrafts';
import { useClaudePermissionMode } from './hooks/useClaudePermissionMode';
import { toast } from './hooks/useToasts';
import { useRoots } from './hooks/useRoots';
import type { Project } from '@shared/types';
import { api } from './api';
import { useTheme, type ThemeMode } from './hooks/useTheme';
import { usePersistedNumber } from './hooks/usePersistedNumber';
import { usePersistedState } from './hooks/usePersistedState';
import { usePoppedShells } from './hooks/usePoppedShells';
import { useProjectShells } from './hooks/useProjectShells';
import { useGitStatus } from './hooks/useGitStatus';
import { terminalFocus, useWindowTerminalFocus } from './hooks/useWindowTerminalFocus';
import { useReportViewedShells } from './hooks/useReportViewedShells';
import { Tooltip } from './components/Tooltip';
import { FoldPane } from './components/FoldPane';
import { usePrefersReducedMotion } from './hooks/usePrefersReducedMotion';
import { useTerminalGeometryHold } from './hooks/useTerminalGeometryHold';
import { useSplitLifecycle } from './hooks/useSplitLifecycle';
import { ErrorBoundary } from './components/ErrorBoundary';
import { StatusDot } from './components/StatusDot';
import { useProjectClaudeState, useShellClaudeState } from './hooks/useClaudeStates';
import { useApplyUiFont } from './fonts/use-apply-ui-font';
import { XIcon } from './components/shell-icons';
import { ShellTabsBar } from './components/ShellTabsBar';
import { ShellSplit } from './components/ShellSplit';
import { ShellTabDot } from './components/ShellTabDot';
import { SPLIT_RATIO_DEFAULT, sanitizeRatio } from './split-ratio';
import { shellChipLabel, stripShells } from './shell-label';


interface PopoutInfo {
  projectId: number;
  shellIndex: number;
}

/** UI state persisted per project. See MainApp for the load/save wiring. */
interface ProjectUiState {
  activeShellIndex: number;
  rightShellIndex: number | null;
  splitRatio: number;
}

/**
 * The sidebar fold's flags and terminal hold. `animate` is sampled when `open` flips: mouse
 * toggles fold (holding terminal geometry until the fold completes), keyboard toggles are instant
 * and take no hold. Returns the `custom` for the fold and its completion handler.
 */
function useSidebarFold(open: boolean, animate: boolean) {
  const reduced = usePrefersReducedMotion();
  const [prevOpen, setPrevOpen] = useState(open);
  const [folding, setFolding] = useState(false);
  if (prevOpen !== open) {
    setPrevOpen(open);
    setFolding(animate);
  }
  useTerminalGeometryHold(folding, open);
  return { custom: { instant: !animate, reduced }, onFoldComplete: () => setFolding(false) };
}

function readPopout(): PopoutInfo | null {
  const q = new URLSearchParams(window.location.search);
  if (q.get('popout') !== '1') return null;
  const projectId = Number(q.get('projectId'));
  const shellIndex = Number(q.get('shellIndex') ?? '0');
  if (!Number.isFinite(projectId) || projectId <= 0) return null;
  return { projectId, shellIndex };
}

/** Selects the renderer shell and applies synchronized application typography. */
export function App() {
  useApplyUiFont();
  useTheme();
  const popout = useMemo(readPopout, []);
  // ErrorBoundary catches render/lifecycle errors so an unhandled throw in
  // any descendant doesn't unmount the whole tree and leave the user with
  // a blank window. See components/ErrorBoundary.tsx for the fallback UI.
  return (
    <ErrorBoundary>
      {popout ? <PopoutShell {...popout} /> : <MainApp />}
    </ErrorBoundary>
  );
}

function MainApp() {
  // App-boot auto-login: if the user opted into "Remember me" in a previous
  // session, the OS keychain has their password. Try the silent auto-login
  // once at startup so the chat unread badge, event stream, and rail state
  // reflect reality without waiting for the user to open the chat panel.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { username, hasPassword } = await api.invoke('metaproject:credentials-load', undefined as never);
        if (cancelled) return;
        if (!username) return;
        if (!hasPassword) {
          console.warn('[metaproject] saved username but no keychain password — you were signed out; sign in again to persist');
          return;
        }
        const res = await api.invoke('metaproject:auto-login', undefined as never);
        if (cancelled) return;
        if (res.ok && res.userName) {
          toast(`Signed in to metaproject as ${res.userName}`, { kind: 'success' });
        } else if (!res.ok) {
          console.warn('[metaproject] auto-login failed:', res.reason);
          toast('Metaproject auto-login failed — sign in again from the Chat tab', {
            kind: 'error',
            detail: res.reason ?? 'unknown reason',
          });
        }
      } catch (e) {
        console.warn('[metaproject] auto-login threw:', e);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const [selected, setSelected] = useState<Project | null>(null);
  // -1 never matches a real project id, so this reads idle when nothing is selected.
  const selectedClaudeState = useProjectClaudeState(selected?.id ?? -1);
  // Keep a live ref of `selected` so the shortcut handler (bound once in a
  // useEffect with an empty dep list) always reads the current project.
  const selectedRef = useRef<Project | null>(null);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [aliveCount, setAliveCount] = useState(0);
  const [mainTab, setMainTab] = usePersistedState<MainTab>('metaide.mainTab', 'shell', isMainTab);
  const mainTabRef = useRef(mainTab);
  mainTabRef.current = mainTab;
  // Unread chat count for the sidebar badge. Increments on every incoming
  // metaproject `channel_message` that arrives while the user isn't looking
  // at the chat pane. Clears the moment they switch to chat. Persists in
  // localStorage so a badge that hasn't been acknowledged survives an app
  // restart — you won't lose track of unread pings between sessions.
  const [chatUnread, setChatUnread] = usePersistedState<number>(
    'metaide.chatUnread',
    0,
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  );
  const [activeView, setActiveView] = usePersistedState<ActivityView>(
    'metaide.activeView',
    'projects',
    (v): v is ActivityView => v === 'projects' || v === 'chat' || v === 'git' || v === 'tasks',
  );
  // Live-ref of the active view so the metaproject subscriber can decide
  // whether to bump the badge without re-subscribing on every switch.
  const activeViewRef = useRef<ActivityView>('projects');
  useEffect(() => { activeViewRef.current = activeView; }, [activeView]);
  useEffect(() => {
    const off = api.on('metaproject:event', ({ event }) => {
      if (event === 'channel_message' && activeViewRef.current !== 'chat') {
        setChatUnread((n) => n + 1);
      }
    });
    return () => { off(); };
  }, []);
  // Clear unread the instant the chat panel opens.
  useEffect(() => { if (activeView === 'chat') setChatUnread(0); }, [activeView]);
  // Clear any pending "open this file" request when the project changes —
  // otherwise a relPath captured from project A would fire in project B's
  // FilesTab and either open the wrong file or 404.
  useEffect(() => { setOpenInFiles(null); }, [selected?.id]);
  // Refresh task count for the ActivityBar pip whenever the project changes.
  // Cheap: it's a filesystem read of package.json + Makefile + compose.
  useEffect(() => {
    if (!selected) { setTaskCount(0); return; }
    let cancelled = false;
    (async () => {
      try {
        const { tasks } = await api.invoke('tasks:discover', { projectId: selected.id });
        if (!cancelled) setTaskCount(tasks.length);
      } catch { if (!cancelled) setTaskCount(0); }
    })();
    return () => { cancelled = true; };
  }, [selected]);
  // Which shellIndex is currently visible in the Shell tab. Default 0 (the
  // Claude/primary shell); ad-hoc terminals opened as tabs bump this to
  // their fresh index so the user immediately sees the new shell.
  // Per-project UI state: which tab is active, whether the split view is
  // open, and how the divider sits. Persisted as one JSON blob keyed by
  // project id so reopening a project restores its layout.
  const [projectStates, setProjectStates] = usePersistedState<Record<string, ProjectUiState>>(
    'metaide.projectStates',
    {},
    (v): v is Record<string, ProjectUiState> => typeof v === 'object' && v !== null && !Array.isArray(v),
  );
  const projectKey = selected?.id != null ? String(selected.id) : null;
  const projectState = projectKey ? projectStates[projectKey] : undefined;
  const activeShellIndex = projectState?.activeShellIndex ?? 0;
  const rightShellIndex = projectState?.rightShellIndex ?? null;
  const splitRatio = sanitizeRatio(projectState?.splitRatio);
  const patchProjectState = useCallback((patch: Partial<ProjectUiState>) => {
    if (!projectKey) return;
    setProjectStates((prev) => ({
      ...prev,
      [projectKey]: { activeShellIndex: 0, rightShellIndex: null, splitRatio: SPLIT_RATIO_DEFAULT, ...prev[projectKey], ...patch },
    }));
  }, [projectKey, setProjectStates]);
  const setActiveShellIndex = useCallback((idx: number) => patchProjectState({ activeShellIndex: idx }), [patchProjectState]);
  const setRightShellIndex = useCallback((idx: number | null) => patchProjectState({ rightShellIndex: idx }), [patchProjectState]);
  const setSplitRatio = useCallback((r: number) => patchProjectState({ splitRatio: r }), [patchProjectState]);
  /** Sets the active shell of a named project. `setActiveShellIndex` is bound to the render's selected project, so it writes to the previous project when called right after a switch. */
  const setActiveShellIndexFor = useCallback((projectId: number, idx: number) => {
    const key = String(projectId);
    setProjectStates((prev) => ({
      ...prev,
      [key]: { rightShellIndex: null, splitRatio: SPLIT_RATIO_DEFAULT, ...prev[key], activeShellIndex: idx },
    }));
  }, [setProjectStates]);
  const allProjectShells = useProjectShells(selected?.id ?? null);
  const [sidebarOpen, setSidebarOpen] = usePersistedState<boolean>(
    'metaide.sidebarOpen',
    true,
    (v): v is boolean => typeof v === 'boolean',
  );
  // Mouse toggles animate the sidebar; ⌘B, ⌘\ and the palette stay instant
  // because they're used far too often for motion to be anything but lag.
  const [sidebarAnimate, setSidebarAnimate] = useState(false);
  const toggleSidebar = useCallback((animate: boolean, open?: boolean) => {
    setSidebarAnimate(animate);
    setSidebarOpen((v) => open ?? !v);
  }, [setSidebarOpen]);
  const sidebarFold = useSidebarFold(sidebarOpen, sidebarAnimate);
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth();
  // Chat panel gets its own persisted width so the wider chat view doesn't
  // resize the projects list back to a tiny column when the user flips modes.
  const [chatPanelWidth, setChatPanelWidth] = usePersistedNumber('metaide.chatPanelWidth', 400, 300, 640);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [finderOpen, setFinderOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [openInFiles, setOpenInFiles] = useState<{ relPath: string; line: number | null } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [scrollbackOpen, setScrollbackOpen] = useState(false);
  const envDrafts = useEnvDrafts();
  const envDirty = selected != null && envDrafts.isDirty(selected.id);
  const [taskCount, setTaskCount] = useState(0);
  const { mode: themeMode, effective: effectiveTheme, cycle: cycleTheme, setMode: setThemeMode, setPalette: setThemePalette } = useTheme();
  const permissionMode = useClaudePermissionMode();
  const shortcutsBlockedRef = useRef(true);
  shortcutsBlockedRef.current = permissionMode.status !== 'chosen';
  const overlayOpen = switcherOpen || settingsOpen || (finderOpen && selected != null) || newProjectOpen
    || paletteOpen || helpOpen || (searchOpen && selected != null) || promptsOpen || scrollbackOpen
    || permissionMode.status === 'unchosen';
  useWindowTerminalFocus(overlayOpen);
  useReportViewedShells({ selectedProjectId: selected?.id ?? null, mainTab, activeShellIndex, rightShellIndex });
  const { roots } = useRoots();
  const { isPopped } = usePoppedShells();
  const split = useSplitLifecycle({
    selectedId: selected?.id ?? null, mainTab, aliveShells: allProjectShells, activeShellIndex, rightShellIndex, setRightShellIndex, setActiveShellIndexFor, isPopped,
  });
  const { status: git } = useGitStatus(selected?.id ?? null);
  const diffCount = diffTabCount(git);
  // Once a NON-primary shell (idx > 0) is popped out into its own window,
  // hide it from the tab strip — the window is now its home. Closing the
  // window returns the shell to the tab strip. Killing from the strip
  // shouldn't be possible while it's popped, which prevents the "click X
  // and lose the popout" surprise. shellIndex 0 (Claude) keeps its tab
  // slot with a "running in another window" placeholder + Bring back.
  const projectShells = useMemo(
    () => allProjectShells.filter((s) => s.shellIndex === 0 || !isPopped(s.projectId, s.shellIndex)),
    [allProjectShells, isPopped],
  );
  // If the currently-active shell just got popped out, drop focus back to
  // the primary tab so the user doesn't stare at a placeholder.
  useEffect(() => {
    if (!selected) return;
    if (activeShellIndex !== 0 && isPopped(selected.id, activeShellIndex)) {
      setActiveShellIndex(0);
    }
  }, [selected, activeShellIndex, isPopped]);

  const commands = useMemo<Command[]>(() => [
    { id: 'nav.projects',    category: 'Go',       title: 'Open project switcher',           hint: '⌘K',   run: () => setSwitcherOpen(true) },
    { id: 'nav.find-file',   category: 'Go',       title: 'Find file in project',            hint: '⌘P',   run: () => setFinderOpen(true) },
    { id: 'nav.find-in-project', category: 'Go',   title: 'Find in project…',                hint: '⌘⇧F',  run: () => setSearchOpen(true) },
    { id: 'nav.scrollback-search', category: 'Go', title: 'Search all shells…',              hint: '⌘⇧O',  run: () => setScrollbackOpen(true) },
    { id: 'shell.prompts',   category: 'Shell',    title: 'Open prompt library',             hint: '⌘⇧K',  run: () => setPromptsOpen(true) },
    { id: 'view.tasks',      category: 'View',     title: 'Show tasks panel',                              run: () => setActiveView('tasks') },
    { id: 'view.sidebar',    category: 'View',     title: sidebarOpen ? 'Hide sidebar' : 'Show sidebar', hint: '⌘B', run: () => toggleSidebar(false) },
    { id: 'view.shell',      category: 'View',     title: 'Switch to Shell tab',                           run: () => setMainTab('shell') },
    { id: 'view.files',      category: 'View',     title: 'Switch to Files tab',                           run: () => setMainTab('files') },
    { id: 'view.diff',       category: 'View',     title: DIFF_COPY.paletteTitle,                          run: () => setMainTab('diff') },
    { id: 'view.env',        category: 'View',     title: 'Switch to Env tab',                             run: () => setMainTab('env') },
    { id: 'view.help',       category: 'View',     title: 'Show keyboard shortcut cheat sheet',   hint: '⌘/', run: () => setHelpOpen(true) },
    { id: 'proj.new',        category: 'Project',  title: 'New project…',                    hint: '⌘⇧N',  run: () => setNewProjectOpen(true) },
    { id: 'shell.unload',    category: 'Shell',    title: 'Unload current session',                        run: async () => { if (selected) { await api.invoke('shells:kill', { projectId: selected.id, shellIndex: 0 }); toast('Session unloaded', { kind: 'success' }); } } },
    { id: 'shell.popout',    category: 'Shell',    title: 'Pop current shell into a new window',          run: async () => { if (selected) await api.invoke('windows:popout-shell', { projectId: selected.id, shellIndex: 0 }); } },
    { id: 'shell.find',      category: 'Shell',    title: 'Find in terminal',                  hint: '⌘F', run: () => { /* handled inside ShellTab when focused */ toast('Focus the shell first, then ⌘F', { kind: 'info' }); } },
    { id: 'shell.zoom.in',   category: 'Shell',    title: 'Zoom in',                          hint: '⌘=', run: () => { /* handled inside ShellTab */ } },
    { id: 'shell.zoom.out',  category: 'Shell',    title: 'Zoom out',                         hint: '⌘-', run: () => { /* handled inside ShellTab */ } },
    { id: 'shell.zoom.reset',category: 'Shell',    title: 'Reset zoom',                       hint: '⌘0', run: () => { /* handled inside ShellTab */ } },
    { id: 'theme.system',    category: 'Theme',    title: 'Follow system theme',                          run: () => setThemeMode('system') },
    { id: 'theme.light',     category: 'Theme',    title: 'Use light theme',                              run: () => setThemeMode('light') },
    { id: 'theme.dark',      category: 'Theme',    title: 'Use dark theme',                               run: () => setThemeMode('dark') },
    { id: 'theme.default',   category: 'Theme',    title: 'Use Default palette',                           run: () => setThemePalette('default') },
    { id: 'theme.catppuccin', category: 'Theme',   title: 'Use Catppuccin palette',                        run: () => setThemePalette('catppuccin') },
    { id: 'theme.rose-pine', category: 'Theme',    title: 'Use Rosé Pine palette',                         run: () => setThemePalette('rose-pine') },
    { id: 'app.settings',    category: 'App',      title: 'Open Settings',                    hint: '⌘,',  run: () => setSettingsOpen(true) },
  ], [selected, sidebarOpen, setThemeMode, setThemePalette]);

  const refreshAlive = useCallback(async () => {
    const { shells } = await api.invoke('shells:alive-list', undefined as never);
    setAliveCount(shells.length);
  }, []);

  useEffect(() => { void refreshAlive(); }, [refreshAlive]);
  useEffect(() => {
    const off = api.on('alive-shells:changed', () => { void refreshAlive(); });
    return () => { off(); };
  }, [refreshAlive]);

  // Refresh the selected-project object when anything (link/unlink,
  // config update, name change) mutates it in the DB.
  //
  // History: this used to blindly setSelected on every projects:changed
  // event. That was buggy — projects:open ALSO emits projects:changed, so
  // clicking project B would trigger the listener with cur=A (ref stale
  // relative to the queued pick(B)), and after the async list fetch we'd
  // setSelected(A), reverting the user's click. The two guards below fix
  // both parts of the race:
  //   (1) capture the id-at-start and abort if selection changed during
  //       the await — the user's later pick wins;
  //   (2) only setSelected when the fields that actually matter to the
  //       shell/chat/git views changed, so open-then-refresh doesn't emit
  //       redundant renders even when we DO stay on the same project.
  useEffect(() => {
    const off = api.on('projects:changed', async () => {
      const idAtStart = selectedRef.current?.id;
      if (idAtStart == null) return;
      try {
        const { projects } = await api.invoke('projects:list', undefined as never);
        if (selectedRef.current?.id !== idAtStart) return;   // (1)
        const cur   = selectedRef.current!;
        const fresh = projects.find((p) => p.id === idAtStart);
        if (!fresh) return;
        const linkedNow    = fresh.config.linkedMetaprojectProjectId ?? fresh.metaprojectProjectId ?? null;
        const linkedBefore = cur.config.linkedMetaprojectProjectId   ?? cur.metaprojectProjectId   ?? null;
        const defaultCliNow    = fresh.config.defaultCliName ?? null;
        const defaultCliBefore = cur.config.defaultCliName   ?? null;
        const materialChange =
          linkedNow !== linkedBefore
          || defaultCliNow !== defaultCliBefore
          || fresh.name !== cur.name
          || fresh.path !== cur.path;
        if (materialChange) setSelected(fresh);              // (2)
      } catch { /* fine — next user action will refresh */ }
    });
    return () => { off(); };
  }, []);

  // Handle "open a file with metaIDE" requests forwarded by the main
  // process — double-clicks in Finder, "Open With", the Dock drop, a
  // second `metaide <path>` invocation. We match the incoming absolute
  // path against every registered root; the longest-prefix root wins and
  // the file opens in that project's Files tab. If no root contains the
  // file, prompt to add its directory as a new root (one confirm — the
  // user just asked to open it, so a friction-free path matters).
  // Main buffers file opens until this signal, so holding it until a
  // permission mode is chosen defers the file's shell launch (spec AC5).
  const permissionChosen = permissionMode.status === 'chosen';
  useEffect(() => {
    if (!permissionChosen) return;
    void api.invoke('app:renderer-ready-for-files', undefined as never).catch(() => {});
  }, [permissionChosen]);

  useEffect(() => {
    const off = api.on('app:open-file-request', async ({ path }) => {
      try {
        const { projects } = await api.invoke('projects:list', undefined as never);
        // Longest-prefix wins — a project nested inside a parent project
        // (rare, but possible with multiple roots) still routes correctly.
        const match = projects
          .filter((p) => path === p.path || path.startsWith(p.path.endsWith('/') ? p.path : p.path + '/'))
          .sort((a, b) => b.path.length - a.path.length)[0];
        // Silently ensure a project exists for this file — creates a root +
        // project for the parent dir if none already contains it. User asked
        // to open a file; they shouldn't have to answer a confirm to do it.
        const { project, relPath } = match
          ? { project: match, relPath: path === match.path ? '' : path.slice(match.path.length + 1) }
          : await api.invoke('projects:ensure-for-file', { path });
        await api.invoke('projects:open', { id: project.id });
        lastPickIdRef.current = project.id;
        setSelected(project);
        try { await api.invoke('shells:launch', { projectId: project.id }); } catch { /* fine */ }
        setMainTab('files');
        if (relPath) requestAnimationFrame(() => setOpenInFiles({ relPath, line: null }));
      } catch (e) {
        toast('Could not open file', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
      }
    });
    return () => { off(); };
  }, []);

  // Click-to-focus for "command done" OS notifications: the main process
  // fires `shell:focus-request` with a (projectId, shellIndex). We look up
  // the project (it may not be the one currently selected), open it, and
  // switch to that shell tab.
  useEffect(() => {
    const off = api.on('shell:focus-request', async ({ projectId, shellIndex }) => {
      terminalFocus.requestFocus({ projectId, shellIndex });
      try {
        const cur = selectedRef.current;
        if (!cur || cur.id !== projectId) {
          const { project } = await api.invoke('projects:open', { id: projectId });
          setSelected(project);
        }
        setMainTab('shell');
        requestAnimationFrame(() => setActiveShellIndexFor(projectId, shellIndex));
      } catch (e) {
        toast('Could not focus shell', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
      }
    });
    return () => { off(); };
  }, [setActiveShellIndexFor, setMainTab]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (shortcutsBlockedRef.current) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'k')                          { e.preventDefault(); setSwitcherOpen(true); }
      if (mod && e.key === '\\')                         { e.preventDefault(); toggleSidebar(false); }
      if (mod && e.key === 'b' && !e.shiftKey && !e.altKey) { e.preventDefault(); toggleSidebar(false); }
      if (mod && e.key === ',')                          { e.preventDefault(); setSettingsOpen(true); }
      if (mod && e.key === 'p' && !e.shiftKey)           { e.preventDefault(); setFinderOpen(true); }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); setNewProjectOpen(true); }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); setPaletteOpen(true); }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setSearchOpen(true); }
      // ⌘⇧K → prompt library (paste snippets into the active shell)
      if (mod && e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); setPromptsOpen(true); }
      // ⌘⇧O → search across every alive shell's scrollback
      if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); setScrollbackOpen(true); }
      if (mod && e.key === '/')                          { e.preventDefault(); setHelpOpen((v) => !v); }
      if (mod && e.key.toLowerCase() === 't') {
        e.preventDefault();
        const p = selectedRef.current;
        if (!p) return;
        (async () => {
          try {
            const { shellIndex } = await api.invoke('shells:launch-plain', { projectId: p.id });
            if (e.shiftKey) {
              // ⌘⇧T → new window
              await api.invoke('windows:popout-shell', { projectId: p.id, shellIndex });
              toast(`New terminal in ${p.name}`, { kind: 'info' });
            } else {
              // ⌘T → new tab in the main window
              setMainTab('shell');
              setActiveShellIndex(shellIndex);
            }
          } catch (err) {
            toast('Failed to open terminal', { kind: 'error', detail: String(err).replace(/^Error:\s*/, '') });
          }
        })();
      }
      if (e.key === 'Escape')                            { setSettingsOpen(false); setFinderOpen(false); setNewProjectOpen(false); setPaletteOpen(false); setHelpOpen(false); setSearchOpen(false); setPromptsOpen(false); setScrollbackOpen(false); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Keep the OS window title in sync with the current project so it reads
  // "lawreader — MetaLogix IDE" in Mission Control, Dock previews, and every
  // window-manager surface. Electron picks up document.title changes and
  // pushes them straight to the BrowserWindow's native title.
  useEffect(() => {
    document.title = selected ? `${selected.name} — MetaLogix IDE` : 'MetaLogix IDE';
  }, [selected]);

  // Global drag/drop guard. Chromium's default behaviour on a file drop is
  // to navigate the whole webview to `file://<dropped-path>` — which flashes
  // an error page and unmounts the app. We swallow drops that don't hit a
  // component that opted in (ShellTab handles its own drop event).
  useEffect(() => {
    const swallow = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
    };
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);
    return () => {
      window.removeEventListener('dragover', swallow);
      window.removeEventListener('drop', swallow);
    };
  }, []);

  // Guards against the "clicked another project but nothing happens" bug:
  // a slow projects:open (or the shells:launch that runs after it) can
  // resolve after the user has clicked a DIFFERENT project. Without this
  // ref the stale earlier setSelected would win, reverting the click.
  const lastPickIdRef = useRef<number | null>(null);
  async function pick(p: Project) {
    lastPickIdRef.current = p.id;
    terminalFocus.cancelRequest();
    try {
      const { project } = await api.invoke('projects:open', { id: p.id });
      if (lastPickIdRef.current !== p.id) return;    // superseded by a newer click
      if (mainTabRef.current === 'shell') terminalFocus.requestProjectFocus(project.id);
      setSelected(project);
      await api.invoke('shells:launch', { projectId: project.id });
    } catch (e) {
      // Only surface the toast when the failure is for the current pick —
      // otherwise a stale evictee-failure would confuse the user.
      if (lastPickIdRef.current === p.id) {
        toast('Failed to launch shell', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
      }
      console.error(e);
    }
  }

  function editEnv(p: Project) {
    // Set synchronously so pick() sees 'env' and queues no terminal focus for a later Env -> Shell switch.
    mainTabRef.current = 'env';
    setMainTab('env');
    void pick(p);
  }

  /** One split pane's shell: the chip's label and dot inputs, falling back to the full shell list for a popped right shell that has left the strip. */
  function splitPane(projectId: number, index: number) {
    return {
      index,
      label: shellChipLabel(projectShells, index) || shellChipLabel(allProjectShells, index),
      dot: <ShellTabDot projectId={projectId} shellIndex={index} isActive={index === activeShellIndex} />,
      popped: isPopped(projectId, index),
    };
  }

  function mainBody(project: Project) {
    switch (mainTab) {
      case 'shell':
        return (
          <ShellSplit
            key={project.id}
            projectId={project.id}
            projectName={project.name}
            panes={{
              left: splitPane(project.id, activeShellIndex),
              right: rightShellIndex != null ? splitPane(project.id, rightShellIndex) : null,
              path: project.path,
              ...split.paneActions(project.id),
            }}
            ratio={splitRatio}
            onRatioChange={setSplitRatio}
            onOpenFile={(relPath, line) => {
              setMainTab('files');
              setOpenInFiles({ relPath, line });
            }}
          />
        );
      case 'files':
        return (
          <FilesTab
            key={project.id}
            projectId={project.id}
            openRelPath={openInFiles?.relPath ?? null}
            openLine={openInFiles?.line ?? null}
            onOpenRelPathConsumed={() => setOpenInFiles(null)}
          />
        );
      case 'diff':
        return <DiffTab key={project.id} projectId={project.id} />;
      case 'env':
        return (
          <ProjectEnvTab
            key={project.id}
            projectId={project.id}
            projectName={project.name}
            drafts={envDrafts}
            onOpenAppEnv={() => {
              setSettingsSection('env');
              setSettingsOpen(true);
            }}
          />
        );
    }
  }

  async function popoutCurrent() {
    if (!selected) return;
    try {
      // Pop out whichever shell tab is currently visible — not always the
      // primary. Matches the mental model "click popout to move THIS shell
      // to its own window".
      await api.invoke('windows:popout-shell', { projectId: selected.id, shellIndex: activeShellIndex });
      toast(`Popped out ${selected.name}`, { kind: 'info', detail: 'The shell now runs in its own window. Click "Bring back" to return it here.' });
    } catch (e) {
      toast('Failed to pop out shell', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
      console.error(e);
    }
  }

  /** Spawn an ad-hoc plain shell in the project's cwd as an inline tab. */
  async function newPlainShellAsTab() {
    if (!selected) return;
    try {
      const { shellIndex } = await api.invoke('shells:launch-plain', { projectId: selected.id });
      setMainTab('shell');
      setActiveShellIndex(shellIndex);
    } catch (e) {
      toast('Failed to open terminal', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
      console.error(e);
    }
  }

  /** Spawn a named CLI profile (Claude, Llama, custom…). */
  async function launchCliProfile(profileName: string, mode: 'tab' | 'window') {
    if (!selected) return;
    try {
      const { shellIndex } = await api.invoke('shells:launch-cli', { projectId: selected.id, profileName });
      if (mode === 'window') {
        await api.invoke('windows:popout-shell', { projectId: selected.id, shellIndex });
        toast(`${profileName} in ${selected.name}`, { kind: 'info' });
      } else {
        setMainTab('shell');
        setActiveShellIndex(shellIndex);
      }
    } catch (e) {
      toast(`Failed to launch ${profileName}`, { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    }
  }

  /** Run a one-off custom command, optionally saving it as a project profile. */
  async function launchCustomCli(name: string, cmdLine: string, save: boolean, mode: 'tab' | 'window') {
    if (!selected) return;
    // Very small argv splitter: whitespace + double-quoted groups. Not a
    // shell — we don't do variable expansion or piping. Users who need that
    // can invoke `bash -lc "..."` explicitly.
    const argv: string[] = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cmdLine)) !== null) argv.push(m[1] ?? m[2] ?? '');
    if (argv.length === 0) throw new Error('empty command');
    try {
      const { shellIndex } = await api.invoke('shells:launch-cli', {
        projectId: selected.id,
        profileName: name || undefined,
        argv,
        save,
      });
      if (mode === 'window') {
        await api.invoke('windows:popout-shell', { projectId: selected.id, shellIndex });
        toast(`${name || argv[0]} in ${selected.name}`, { kind: 'info' });
      } else {
        setMainTab('shell');
        setActiveShellIndex(shellIndex);
      }
    } catch (e) {
      toast('Failed to launch CLI', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    }
  }

  async function killShell(shellIndex: number) {
    if (!selected) return;
    try {
      await api.invoke('shells:kill', { projectId: selected.id, shellIndex });
      if (activeShellIndex === shellIndex) setActiveShellIndex(0);
      if (rightShellIndex === shellIndex) setRightShellIndex(null);
    } catch (e) {
      toast('Failed to close terminal', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    }
  }

  /** Open a side-by-side split — spawns a fresh plain shell as the right pane. */
  async function openSplit() {
    if (!selected || rightShellIndex != null) return;
    try {
      const { shellIndex } = await api.invoke('shells:launch-plain', { projectId: selected.id });
      setRightShellIndex(shellIndex);
      setSplitRatio(SPLIT_RATIO_DEFAULT);
    } catch (e) {
      toast('Failed to open split', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    }
  }

  async function unloadCurrent() {
    if (!selected) return;
    try {
      await api.invoke('shells:kill', { projectId: selected.id, shellIndex: 0 });
      toast('Session unloaded', { kind: 'success' });
    } catch (e) { console.error(e); }
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-[--surface-chrome]">
      {/* Native-feeling drag region for hidden-inset title bar. pr-[3px] puts the
          last button's 14px glyph 12px from the right edge, mirroring the traffic lights' inset. */}
      <div className="drag relative h-11 flex items-center pl-[76px] pr-[3px] shrink-0">
        <div className="absolute inset-y-0 left-[130px] right-[130px] flex items-center justify-center min-w-0 pointer-events-none">
          <TitleGroup
            projectName={selected?.name ?? null}
            branch={git.isRepo ? (git.branch ?? 'HEAD') : null}
          />
        </div>
        <div className="ml-auto flex items-center gap-0.5 no-drag" data-testid={CHROME_TESTIDS.titleButtons}>
          <button
            onClick={cycleTheme}
            className="text-[--text-muted] hover:text-[--text] w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[--panel-strong]"
            title={`Theme: ${themeMode}${themeMode === 'system' ? ` (following OS — currently ${effectiveTheme})` : ''}. Click to toggle.`}
            data-testid="theme-toggle"
            data-theme-mode={themeMode}
          >
            <ThemeIcon mode={themeMode} effective={effectiveTheme} />
          </button>
          <button
            onClick={async () => {
              try {
                const { arranged } = await api.invoke('windows:tile-all', undefined as never);
                toast(`Tiled ${arranged} window${arranged === 1 ? '' : 's'}`, { kind: 'success', timeoutMs: 1200 });
              } catch (e) { toast('Tile failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') }); }
            }}
            className="text-[--text-muted] hover:text-[--text] w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[--panel-strong]"
            title="Tile all our windows on the screen"
            data-testid="tile-windows"
          >
            <TileIcon />
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="text-[--text-muted] hover:text-[--text] w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[--panel-strong]"
            title="Settings (⌘,)"
            data-testid="settings-open"
          >
            <GearIcon />
          </button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        <ActivityBar
          active={activeView}
          onSelect={(v) => {
            // Toggle if the same view is clicked twice — quality-of-life.
            setActiveView(activeView === v && v !== 'projects' ? 'projects' : v);
            if (!sidebarOpen) toggleSidebar(true, true);
          }}
          onToggleSidebar={() => toggleSidebar(true)}
          sidebarOpen={sidebarOpen}
          chatUnread={chatUnread}
          gitDirty={git.dirty ? Object.keys(git.files).length : undefined}
          taskCount={taskCount || undefined}
        />
        <AnimatePresence initial={false} custom={sidebarFold.custom}>
          {sidebarOpen && (
            <FoldPane key="sidebar" size="intrinsic" anchor="end" custom={sidebarFold.custom} onFoldComplete={sidebarFold.onFoldComplete}>
              {/* Project sidebar is ALWAYS visible when the sidebar is open — chat
                  sits alongside it in its own resizable column instead of
                  replacing it, so the user never has to swap views just to pick
                  a different project. */}
              <Sidebar
                selectedProjectId={selected?.id ?? null}
                onSelect={pick}
                onNewProject={() => setNewProjectOpen(true)}
                onEditEnv={editEnv}
                width={sidebarWidth}
              />
              <ResizeHandle
                value={sidebarWidth}
                onChange={setSidebarWidth}
                onReset={() => setSidebarWidth(SIDEBAR_WIDTH.default)}
                min={SIDEBAR_WIDTH.min}
                max={SIDEBAR_WIDTH.max}
                side="left"
              />
              {activeView === 'chat' && (
                <>
                  <div
                    data-view="chat"
                    className="section-panel h-full flex flex-col shrink-0"
                    style={{ width: chatPanelWidth }}
                  >
                    <ChatTab
                      projectId={selected?.id ?? 0}
                      metaprojectProjectId={selected ? (selected.config.linkedMetaprojectProjectId ?? selected.metaprojectProjectId ?? null) : null}
                      compact
                      onDismiss={() => setActiveView('projects')}
                    />
                  </div>
                  <ResizeHandle
                    value={chatPanelWidth}
                    onChange={setChatPanelWidth}
                    onReset={() => setChatPanelWidth(400)}
                    min={300}
                    max={640}
                    side="left"
                  />
                </>
              )}
              {activeView === 'git' && (
                <>
                  <div
                    data-view="git"
                    className="section-panel h-full flex flex-col shrink-0"
                    style={{ width: chatPanelWidth }}
                  >
                    <GitPanel projectId={selected?.id ?? null} />
                  </div>
                  <ResizeHandle
                    value={chatPanelWidth}
                    onChange={setChatPanelWidth}
                    onReset={() => setChatPanelWidth(400)}
                    min={280}
                    max={640}
                    side="left"
                  />
                </>
              )}
              {activeView === 'tasks' && (
                <>
                  <div
                    data-view="tasks"
                    className="section-panel h-full flex flex-col shrink-0"
                    style={{ width: chatPanelWidth }}
                  >
                    <TasksPanel
                      projectId={selected?.id ?? null}
                      onLaunched={(shellIndex) => { setMainTab('shell'); setActiveShellIndex(shellIndex); }}
                    />
                  </div>
                  <ResizeHandle
                    value={chatPanelWidth}
                    onChange={setChatPanelWidth}
                    onReset={() => setChatPanelWidth(400)}
                    min={280}
                    max={640}
                    side="left"
                  />
                </>
              )}
            </FoldPane>
          )}
        </AnimatePresence>
        <main className="flex-1 flex flex-col min-h-0 min-w-0 bg-[--surface-sheet] rounded-[14px] mr-2">
          <div className="flex items-center gap-1 px-2 pt-1.5 pb-1 text-xs shrink-0" data-testid={DIFF_TESTIDS.tabBar}>
            <TabButton active={mainTab === 'shell'} onClick={() => setMainTab('shell')}>Shell</TabButton>
            <TabButton active={mainTab === 'files'} onClick={() => setMainTab('files')}>Files</TabButton>
            <TabButton
              active={mainTab === 'diff'}
              onClick={() => setMainTab('diff')}
              testId={DIFF_TESTIDS.tab}
              ariaLabel={diffCount !== null ? DIFF_COPY.tabCountLabel(diffCount) : undefined}
            >
              {DIFF_COPY.tabLabel}
              {diffCount !== null && (
                <span aria-hidden className="ml-1.5 font-mono text-[10px] text-[--hue-orange-text]" data-testid={DIFF_TESTIDS.tabCount}>
                  {diffCount}
                </span>
              )}
            </TabButton>
            <TabButton
              active={mainTab === 'env'}
              onClick={() => setMainTab('env')}
              testId={ENV_TESTIDS.tab}
              ariaLabel={envDirty ? ENV_COPY.tabUnsavedLabel : undefined}
            >
              {ENV_COPY.tabLabel}
              {envDirty && (
                <span aria-hidden className="ml-1 text-[--accent]" data-testid={ENV_TESTIDS.unsaved}>
                  {ENV_COPY.tabUnsavedMarker}
                </span>
              )}
            </TabButton>
            <div className="ml-auto flex items-center gap-1.5 pr-2">
              {selected && (
                <>
                  <span className="flex items-center gap-1.5 text-[--text] pl-2 pr-1 py-0.5 rounded-md bg-[--surface-active] text-[11px] max-w-[280px]" title={selected.path}>
                    <StatusDot state={selectedClaudeState} />
                    <span className="truncate font-medium">{selected.name}</span>
                    <button
                      onClick={unloadCurrent}
                      className="ml-1 text-[--text-muted] hover:text-[--danger] hover:bg-[--panel]/60 w-4 h-4 flex items-center justify-center rounded"
                      title="Unload session (close shell)"
                      data-testid="unload-current"
                    >
                      <XIcon />
                    </button>
                  </span>
                  <MetaprojectBoardButton project={selected} onRequestLink={() => setActiveView('chat')} />
                  <Tooltip label="Prompt library" shortcut="⌘⇧K">
                    <button
                      onClick={() => setPromptsOpen(true)}
                      className="text-[--text-muted] hover:text-[--text] w-7 h-7 flex items-center justify-center rounded hover:bg-[--panel-strong]"
                      data-testid="prompts-open"
                      aria-label="Open prompt library"
                    >
                      <PromptsIcon />
                    </button>
                  </Tooltip>
                  <Tooltip label="Search all shells" shortcut="⌘⇧O">
                    <button
                      onClick={() => setScrollbackOpen(true)}
                      className="text-[--text-muted] hover:text-[--text] w-7 h-7 flex items-center justify-center rounded hover:bg-[--panel-strong]"
                      data-testid="scrollback-open"
                      aria-label="Search across all live shells"
                    >
                      <SearchIcon />
                    </button>
                  </Tooltip>
                  <Tooltip label="Reveal project folder in Finder">
                    <button
                      onClick={async () => {
                        try {
                          await api.invoke('files:reveal', { projectId: selected.id, relPath: '' });
                        } catch (e) {
                          toast('Could not open the folder', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
                        }
                      }}
                      className="text-[--text-muted] hover:text-[--text] w-7 h-7 flex items-center justify-center rounded hover:bg-[--panel-strong]"
                      data-testid="reveal-project-folder"
                    >
                      <RevealFolderIcon />
                    </button>
                  </Tooltip>
                  <Tooltip label="Pop the active shell into its own window">
                    <button
                      onClick={popoutCurrent}
                      className="text-[--text-muted] hover:text-[--text] w-7 h-7 flex items-center justify-center rounded hover:bg-[--panel-strong]"
                      data-testid="popout-shell"
                    >
                      <PopoutIcon />
                    </button>
                  </Tooltip>
                </>
              )}
            </div>
          </div>
          <div className="flex-1 relative min-h-0 flex flex-col">
            {selected && mainTab === 'shell' && (
              <ShellTabsBar
                projectId={selected.id}
                shells={stripShells(projectShells, rightShellIndex, split.hiddenShells)}
                active={activeShellIndex}
                onSelect={setActiveShellIndex}
                onClose={killShell}
                defaultCliName={selected.config.defaultCliName ?? null}
                onDefaultCliChanged={(name) => {
                  // Optimistic local update so the star reflects the click
                  // immediately; the projects:changed broadcast from main
                  // will backfill any remote-side normalisation.
                  setSelected((cur) => cur ? { ...cur, config: { ...cur.config, defaultCliName: name } } : cur);
                }}
                onLaunchProfile={(name) => void launchCliProfile(name, 'tab')}
                onLaunchPlainTab={newPlainShellAsTab}
                onLaunchCustom={(name, cmdLine, save) => void launchCustomCli(name, cmdLine, save, 'tab')}
                splitOn={rightShellIndex != null}
                onToggleSplit={() => (rightShellIndex != null ? split.closeSplit() : void openSplit())}
              />
            )}
            {selected ? mainBody(selected) : <EmptyState />}
          </div>
        </main>
      </div>

      <StatusBar project={selected} aliveCount={aliveCount} />
      <ProjectSwitcher open={switcherOpen} onClose={() => setSwitcherOpen(false)} onPick={pick} />
      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        section={settingsSection}
        onSection={setSettingsSection}
        envDrafts={envDrafts}
      />
      <FileFinder
        open={finderOpen && selected != null}
        projectId={selected?.id ?? null}
        onClose={() => setFinderOpen(false)}
        onPick={(relPath) => {
          setMainTab('files');
          setOpenInFiles({ relPath, line: null });
        }}
      />
      <NewProjectDialog
        open={newProjectOpen}
        roots={roots}
        defaultRootId={selected ? roots.find((r) => r.id === selected.rootId)?.id ?? null : null}
        onClose={() => setNewProjectOpen(false)}
        onCreated={(project) => { setNewProjectOpen(false); void pick(project); toast(`Created ${project.name}`, { kind: 'success' }); }}
      />
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />
      <ToastStack />
      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
         <ProjectSearch
        open={searchOpen && selected != null}
        projectId={selected?.id ?? null}
        onClose={() => setSearchOpen(false)}
        onOpenMatch={(relPath, line) => {
          setMainTab('files');
          setOpenInFiles({ relPath, line });
        }}
      />
      <PromptLibrary
        open={promptsOpen}
        onClose={() => setPromptsOpen(false)}
        projectId={selected?.id ?? null}
        activeShell={selected ? { projectId: selected.id, shellIndex: activeShellIndex } : null}
        activeShellLabel={selected ? `${selected.name} · shell ${activeShellIndex}` : undefined}
      />
      <ScrollbackSearch
        open={scrollbackOpen}
        onClose={() => setScrollbackOpen(false)}
        onFocus={async (projectId, shellIndex) => {
          terminalFocus.cancelRequest();
          try {
            const cur = selectedRef.current;
            if (!cur || cur.id !== projectId) {
              const { project } = await api.invoke('projects:open', { id: projectId });
              setSelected(project);
            }
            setMainTab('shell');
            requestAnimationFrame(() => {
              setActiveShellIndexFor(projectId, shellIndex);
              terminalFocus.requestFocus({ projectId, shellIndex });
            });
          } catch (e) {
            toast('Could not focus shell', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
          }
        }}
      />
      {permissionMode.status === 'unchosen' && (
        <PermissionModeDialog onConfirm={permissionMode.choose} error={permissionMode.error} />
      )}
    </div>
  );
}

function PopoutShell({ projectId, shellIndex }: PopoutInfo) {
  const claudeState = useShellClaudeState(projectId, shellIndex);
  const [tab, setTab] = useState<'shell' | 'files'>('shell');
  const [openInFiles, setOpenInFiles] = useState<{ relPath: string; line: number | null } | null>(null);
  const [projectName, setProjectName] = useState<string>('');
  useWindowTerminalFocus(false);
  useEffect(() => {
    terminalFocus.requestFocus({ projectId, shellIndex });
  }, [projectId, shellIndex]);
  useEffect(() => {
    (async () => {
      try {
        const { project } = await api.invoke('projects:open', { id: projectId });
        setProjectName(project.name);
      } catch { /* fall back to id-only title */ }
    })();
  }, [projectId]);
  // Popout window title always includes the project so users can tell
  // stacked popouts apart. Falls back to a generic label until the
  // project fetch resolves.
  useEffect(() => {
    document.title = projectName
      ? `${projectName} — Shell ${shellIndex} — MetaLogix IDE`
      : `MetaLogix IDE · shell`;
  }, [projectName, shellIndex]);
  return (
    <div className="h-screen w-screen flex flex-col bg-[--surface-chrome]">
      <div className="drag h-11 flex items-center gap-2 pl-[76px] pr-3 shrink-0 min-w-0">
        {/* Prominent project name — the whole reason a user pops shells out
            is to run several projects side by side, so the label needs to
            read at a glance even in a narrow window. Trailing subtitle is
            shortened + hidden first when space runs out. */}
        <StatusDot state={claudeState} className="shrink-0" />
        <span className="text-sm font-semibold text-[--text] truncate min-w-0" title={projectName}>
          {projectName || 'MetaLogix IDE'}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-[--text-muted] font-semibold shrink-0">
          Shell {shellIndex}
        </span>
        <span className="ml-auto text-[10px] text-[--text-muted] opacity-60 truncate hidden sm:inline">
          MetaLogix IDE
        </span>
      </div>
      <div className="flex items-center gap-1 px-2 pt-1.5 pb-1 text-xs shrink-0">
        <button
          onClick={() => setTab('shell')}
          className={`px-3 py-1 rounded-md transition-colors ${tab === 'shell' ? 'bg-[--accent-soft] text-[--accent-soft-text] font-medium' : 'text-[--text-muted] hover:text-[--text] hover:bg-[--surface-hover]'}`}
        >Shell</button>
        <button
          onClick={() => setTab('files')}
          className={`px-3 py-1 rounded-md transition-colors ${tab === 'files' ? 'bg-[--accent-soft] text-[--accent-soft-text] font-medium' : 'text-[--text-muted] hover:text-[--text] hover:bg-[--surface-hover]'}`}
        >Files</button>
      </div>
      <div className="flex-1 min-h-0 bg-[--surface-sheet] rounded-xl mx-2 mb-2">
        {tab === 'shell' ? (
          <ShellTab
            projectId={projectId}
            shellIndex={shellIndex}
            primary
            onOpenFile={(relPath, line) => {
              // Open the editor inline in this popout window instead of
              // dropping the user back to Finder.
              setTab('files');
              setOpenInFiles({ relPath, line });
            }}
          />
        ) : (
          <FilesTab
            projectId={projectId}
            openRelPath={openInFiles?.relPath ?? null}
            openLine={openInFiles?.line ?? null}
            onOpenRelPathConsumed={() => setOpenInFiles(null)}
          />
        )}
      </div>
    </div>
  );
}

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  testId?: string;
  ariaLabel?: string;
  children: React.ReactNode;
}

function TabButton({ active, onClick, testId, ariaLabel, children }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      aria-label={ariaLabel}
      aria-current={active ? 'page' : undefined}
      className={`h-8 px-3 rounded-lg transition-colors ${
        active
          ? 'bg-[--accent-soft] text-[--accent-soft-text] font-medium'
          : 'text-[--text-muted] hover:text-[--text] hover:bg-[--surface-hover]'
      }`}
    >
      {children}
    </button>
  );
}

const SHORTCUT_GROUPS: Array<{ title: string; items: Array<[string, string]> }> = [
  { title: 'Go',       items: [['⌘K', 'Project switcher'], ['⌘P', 'Find file in project'], ['⌘⇧F', 'Find in project']] },
  { title: 'Views',    items: [['⌘B', 'Toggle sidebar'], ['⌘,', 'Settings'], ['⌘/', 'This cheat sheet']] },
  { title: 'Palette',  items: [['⌘⇧P', 'Command palette'], ['⌘⇧N', 'New project']] },
  { title: 'Shell',    items: [['⌘F', 'Find in terminal'], ['⌘⇧O', 'Search all shells'], ['⌘⇧K', 'Prompt library'], ['⌘=', 'Zoom in'], ['⌘-', 'Zoom out'], ['⌘0', 'Reset zoom']] },
];

function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
      data-testid="shortcuts-help"
    >
      <div
        className="bg-[--panel-strong] w-[560px] max-w-[92vw] rounded-xl shadow-2xl border border-[--border] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[--border] flex items-center justify-between">
          <div className="font-semibold text-sm">Keyboard shortcuts</div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded text-[--text-muted] hover:text-[--text] hover:bg-[--panel]"
            title="Close (Esc)"
            aria-label="Close shortcuts"
          >
            <XIcon />
          </button>
        </div>
        <div className="p-5 grid grid-cols-2 gap-x-8 gap-y-4">
          {SHORTCUT_GROUPS.map((g) => (
            <div key={g.title}>
              <div className="text-[10px] uppercase tracking-wider text-[--text-muted] font-semibold mb-2">{g.title}</div>
              <div className="space-y-1.5">
                {g.items.map(([keys, desc]) => (
                  <div key={keys} className="flex items-center justify-between gap-4 text-sm">
                    <span className="text-[--text-muted]">{desc}</span>
                    <kbd>{keys}</kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="px-4 py-2 border-t border-[--border] text-[11px] text-[--text-muted] text-right">
          <kbd>Esc</kbd> to close
        </div>
      </div>
    </div>
  );
}


function EmptyState() {
  const { roots } = useRoots();
  // Onboarding: fresh install has no roots yet, so the sidebar shows no
  // projects and the main pane is blank — new users have nothing to click.
  // Surface a welcome card that walks them through the very first action.
  if (roots.length === 0) return <WelcomeOnboarding />;
  return (
    <div className="h-full flex items-center justify-center p-8 text-center">
      <div className="max-w-sm space-y-2">
        <div className="text-sm text-[--text-muted]">No project selected</div>
        <div className="text-xs text-[--text-muted] opacity-70">
          Pick one from the sidebar, or press <kbd className="px-1 py-0.5 rounded bg-[--panel] border border-[--border] text-[10px]">⌘K</kbd> to search.
        </div>
      </div>
    </div>
  );
}

function WelcomeOnboarding() {
  const { refresh } = useRoots();
  async function addRoot() {
    const picked = await api.invoke('dialogs:pick-directory', undefined as never);
    if (picked.path) {
      await api.invoke('roots:add', { path: picked.path });
      void refresh();
    }
  }
  return (
    <div className="h-full flex items-center justify-center p-10">
      <div className="max-w-lg w-full space-y-5 text-center">
        <div className="text-3xl font-semibold">Welcome to MetaLogix IDE</div>
        <div className="text-sm text-[--text-muted] leading-relaxed">
          Add the parent folder that holds your projects and MetaLogix IDE
          will discover them automatically. You&apos;ll get a Claude shell,
          side-by-side splits, popout windows, and per-project team chat —
          all keyed off the folders in that root.
        </div>
        <div className="flex gap-2 justify-center pt-2">
          <button
            onClick={addRoot}
            className="pressable bg-[color:var(--accent)] text-[--accent-text] text-sm font-medium px-4 py-2 rounded-md hover:brightness-110 shadow-sm"
            data-testid="welcome-add-root"
          >
            + Add a root folder
          </button>
        </div>
        <div className="text-[11px] text-[--text-muted] opacity-70 pt-4">
          Tip: press <kbd className="px-1 py-0.5 rounded bg-[--panel] border border-[--border] text-[10px]">⌘,</kbd> to open settings and change the default CLI or theme.
        </div>
      </div>
    </div>
  );
}

function PromptsIcon() {
  // Lightbulb — reads as "snippets / ideas to paste".
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18h6" />
      <path d="M10 22h4" />
      <path d="M12 2a7 7 0 0 0-4 12.7c.7.5 1 1.3 1 2.1V18h6v-1.2c0-.8.3-1.6 1-2.1A7 7 0 0 0 12 2z" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  );
}

function RevealFolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function PopoutIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3h6v6" />
      <path d="M10 14L21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

function MetaprojectBoardButton({ project, onRequestLink }: { project: Project; onRequestLink: () => void }) {
  // Seed with the default so a click during the settings-fetch race doesn't
  // dead-end on a "not configured" toast — the vast majority of users will
  // hit the default anyway, and settings:get overwrites it when it resolves.
  const DEFAULT_BASE = 'https://projects.metalogix.solutions';
  const [baseUrl, setBaseUrl] = useState<string>(DEFAULT_BASE);
  useEffect(() => {
    (async () => {
      try {
        const { value } = await api.invoke('settings:get', { key: 'metaproject_base_url' });
        if (typeof value === 'string' && value) setBaseUrl(value);
      } catch { /* keep default */ }
    })();
  }, []);
  const linked = project.config.linkedMetaprojectProjectId ?? project.metaprojectProjectId;
  // Strip any leading identifier prefix ("PROJ-42" → "42"). The public URL
  // is `/projects/<int_id>` which auto-redirects to the kanban board.
  const numericId = linked ? Number(String(linked).replace(/^[A-Za-z]+-/, '')) : null;
  const isLinked = !!(linked && numericId && Number.isFinite(numericId));
  // Normalize baseUrl: users often save a bare host like
  // `projects.metalogix.solutions` without a scheme, which then fails the
  // main-process URL-scheme allowlist. Prepend `https://` when missing and
  // strip a trailing slash so the join is clean.
  const normalizedBase = /^https?:\/\//i.test(baseUrl)
    ? baseUrl.replace(/\/$/, '')
    : `https://${baseUrl.replace(/^\/+/, '').replace(/\/$/, '')}`;
  const url = isLinked ? `${normalizedBase}/projects/${numericId}` : '';
  return (
    <button
      onClick={async () => {
        // Unlinked → surface the link/create banner in the chat rail so the
        // user can wire this local project to a metaproject board in one
        // click; the banner already has both "Link existing" and "Create new".
        if (!isLinked) {
          toast('Not linked yet — pick or create a metaproject board', { kind: 'info' });
          onRequestLink();
          return;
        }
        try {
          await api.invoke('app:open-external', { url });
        } catch (e) {
          toast('Could not open the board', { kind: 'error', detail: `${String(e).replace(/^Error:\s*/, '')} — URL: ${url}` });
        }
      }}
      className={`text-[11px] px-2 py-0.5 rounded-md flex items-center gap-1.5 ${
        isLinked ? 'hover:bg-[--panel-strong] text-[--text]' : 'text-[--text-muted] hover:bg-[--panel-strong] hover:text-[--text]'
      }`}
      title={isLinked ? `Open ${linked} on the metaproject board` : 'Not linked to a metaproject board — click to link or create one'}
      data-testid="metaproject-board"
    >
      <span className="text-[--hue-purple]"><BoardIcon /></span>
      <span>{isLinked ? 'Board' : 'Board · link'}</span>
    </button>
  );
}

function BoardIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
      <line x1="15" y1="4" x2="15" y2="20" />
    </svg>
  );
}

function TileIcon() {
  // Three tall bars side-by-side — matches how tileAllOurWindows lays
  // shells out in a chatbot-style row of columns.
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3"  y="3" width="4.5" height="18" rx="1" />
      <rect x="9.75"  y="3" width="4.5" height="18" rx="1" />
      <rect x="16.5" y="3" width="4.5" height="18" rx="1" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

function ThemeIcon({ mode, effective }: { mode: ThemeMode; effective: 'light' | 'dark' }) {
  // system → half moon over sun (auto), light → sun, dark → moon
  if (mode === 'system') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" opacity={effective === 'dark' ? 0.4 : 1} />
        <path d="M12 8a4 4 0 0 0 0 8" fill="currentColor" opacity={effective === 'dark' ? 1 : 0} />
      </svg>
    );
  }
  if (mode === 'light') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
