import { useCallback, useEffect, useMemo, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { Sidebar } from './components/Sidebar';
import { UnloadSessionDialog } from './components/UnloadSessionDialog';
import { RemoteProjectPane } from './components/RemoteProjectPane';
import type { OpenPaneRequest } from '@renderer/machine-switcher-contract';
import { StatusBar } from './components/StatusBar';
import { useShowStatusBar } from './hooks/useShowStatusBarPorts';
import { SIDEBAR_WIDTH, useSidebarWidth } from './sidebar-width';
import { ShellTab } from './components/ShellTab';
import { FilesTab } from './components/FilesTab';
import { ActivityTab } from './components/ActivityTab';
import { FleetView } from './components/FleetView';
import { ChatTab } from './components/ChatTab';
import { BoardPanel, type BoardLeaseControl } from './metaproject/BoardPanel';
import { MetaprojectSessionProvider, useMetaprojectSession } from './metaproject/session';
import { useAssignment } from './metaproject/useAssignment';
import { GitPanel } from './components/GitPanel';
import { Settings } from './components/Settings';
import { ProjectSettingsTab } from './components/ProjectSettingsTab';
import { PROJECT_SETTINGS_COPY, PROJECT_SETTINGS_TESTIDS, type ProjectSettingsTarget } from './project-settings-contract';
import type { SettingsSection } from './components/settings/nav-icons';
import { ResizeHandle } from './components/ResizeHandle';
import { NewProjectDialog } from './components/NewProjectDialog';
import { UsageMeter } from './components/UsageMeter';
import { ActivityBar, ABButton, type ActivityView } from './components/ActivityBar';
import { CommandPalette } from './components/CommandPalette';
import { ShortcutsHelp } from './components/ShortcutsHelp';
import type { PaletteRequest, PaletteSeed } from './command-palette-contract';
import { buildPaletteCommands } from './palette-commands';
import { paletteKeyAction } from './palette-keys';
import { appShortcutAction } from './app-keys';
import type { AppShortcutAction } from './shortcut-contract';
import { SHORTCUT_COPY } from './shortcut-copy';
import { useShortcutPlatform } from './shortcut-platform';
import { routeTerminalKey, terminalTabAction } from './terminal-keys';
import { GHOSTTY_HOST_SELECTOR } from '@shared/terminal-engine';
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
import { isMainTab, visibleMainTab, type MainTab } from './main-tab';
import { useActivityLogEnabled } from './hooks/useActivityLogEnabled';
import { ACTIVITY_LOG_TESTIDS } from './activity-log-contract';
import { useEnvDrafts } from './hooks/useEnvDrafts';
import { useClaudePermissionMode } from './hooks/useClaudePermissionMode';
import { useTaskCount } from './hooks/useTaskCount';
import { toast } from './hooks/useToasts';
import { useKeepAwake } from './hooks/useKeepAwake';
import { KeepAwakeUntilDialog } from './components/KeepAwakeUntilDialog';
import { useRoots } from './hooks/useRoots';
import type { Project } from '@shared/types';
import { api } from './api';
import { createPendingFileOpen } from './pending-file-open';
import { useTheme, type ThemeMode } from './hooks/useTheme';
import { usePersistedNumber } from './hooks/usePersistedNumber';
import { usePersistedState } from './hooks/usePersistedState';
import { usePoppedShells } from './hooks/usePoppedShells';
import { useProjectShells } from './hooks/useProjectShells';
import { useGitStatus } from './hooks/useGitStatus';
import { useWindowFullscreen } from './hooks/useWindowFullscreen';
import { activeElementKind, terminalFocus, useWindowTerminalFocus } from './hooks/useWindowTerminalFocus';
import { useReportViewedShells } from './hooks/useReportViewedShells';
import { Tooltip } from './components/Tooltip';
import { FoldPane } from './components/FoldPane';
import { usePrefersReducedMotion } from './hooks/usePrefersReducedMotion';
import { useTerminalGeometryHold } from './hooks/useTerminalGeometryHold';

/** Status bar fold and sheet margin/rounding transition length. */
const STATUS_BAR_MS = 200;
/** The status bar's fixed height (StatusBar's h-[34px]); its slot animates to this. */
const STATUS_BAR_HEIGHT = 34;
import { useSplitLifecycle } from './hooks/useSplitLifecycle';
import { ErrorBoundary } from './components/ErrorBoundary';
import { StatusDot } from './components/StatusDot';
import { useShellAgentState } from './hooks/useAgentStates';
import { useApplyUiFont } from './fonts/use-apply-ui-font';
import { ICON_SIZE } from './components/icon-size';
import { ShellTabsBar, type ShellLaunched, type ShellTabMotion } from './components/ShellTabsBar';
import { SplitButton } from './components/SplitButton';
import { ShellSplit } from './components/ShellSplit';
import { WorkspaceTabButton } from './components/WorkspaceTabButton';
import { ShellTabDot } from './components/ShellTabDot';
import { SPLIT_RATIO_DEFAULT, sanitizeRatio } from './split-ratio';
import { shellChipLabel, stripShells } from './shell-label';
import { useFrostedGlassAttributes } from './hooks/useFrostedGlassAttributes';
import { useExternalDragGuard } from './hooks/useExternalDragGuard';
import { isPrimaryVisible } from './unload-session';
import { resolveFileTarget } from './agent-file-targets';
import { useAgentFileFollow } from './hooks/useAgentFileFollow';
import type { SheetContent } from './frosted-chrome-contract';


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
 * A side pane's fold flags and terminal hold (the sidebar, and the activity sheet inside it). `animate` is sampled when `open` flips: mouse
 * toggles fold (holding terminal geometry until the fold completes), keyboard toggles are instant
 * and take no hold. Returns the `custom` for the fold and its completion handler.
 */
function usePaneFold(open: boolean, animate: boolean) {
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
/** Views shown in the sidebar column in place of the project list; Fleet takes over the main area instead. */
function hasSheet(view: ActivityView): boolean {
  return view !== 'projects' && view !== 'fleet';
}

export function App() {
  useApplyUiFont();
  useTheme();
  const popout = useMemo(readPopout, []);
  // ErrorBoundary catches render/lifecycle errors so an unhandled throw in
  // any descendant doesn't unmount the whole tree and leave the user with
  // a blank window. See components/ErrorBoundary.tsx for the fallback UI.
  return (
    <ErrorBoundary>
      {popout ? <PopoutShell {...popout} /> : <MetaprojectSessionProvider><MainApp /></MetaprojectSessionProvider>}
    </ErrorBoundary>
  );
}

function MainApp() {
  const platform = useShortcutPlatform();
  useFrostedGlassAttributes();
  const { snapshot: account, current: currentAccount, promptOpen } = useMetaprojectSession();
  const [boardProject, setBoardProject] = useState<number | null>(null);
  const boardControls = useRef<BoardLeaseControl | null>(null);
  const boardOpener = useRef<HTMLButtonElement>(null);
  const beforeOverlay = useCallback((show: () => void) => {
    const lease = boardControls.current;
    if (lease) void lease.hide().then(show); else show();
  }, []);
  const closeBoard = useCallback(() => { boardControls.current?.close(); setBoardProject(null); }, []);
  const returnToWorkspace = useCallback(() => { closeBoard(); boardOpener.current?.focus(); }, [closeBoard]);
  const [selected, setSelected] = useState<Project | null>(null);
  const selectionRequestRef = useRef(0);
  // A project on a paired machine, shown in place of the local main body until a local project is picked.
  const [remotePane, setRemotePane] = useState<OpenPaneRequest | null>(null);
  const remotePaneRef = useRef(remotePane);
  remotePaneRef.current = remotePane;
  const openPane = useCallback((req: OpenPaneRequest) => { closeBoard(); setRemotePane(req); }, [closeBoard]);
  // -1 never matches a real project id, so this reads idle when nothing is selected.
  // Keep a live ref of `selected` so the shortcut handler (bound once in a
  // useEffect with an empty dep list) always reads the current project.
  const selectedRef = useRef<Project | null>(null);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  const activeShellIndexRef = useRef<number>(0);
  const [fullscreen, toggleFullscreen] = useWindowFullscreen();
  const toggleFullscreenRef = useRef<() => void>(() => undefined);
  useEffect(() => { toggleFullscreenRef.current = toggleFullscreen; }, [toggleFullscreen]);
  const [aliveCount, setAliveCount] = useState(0);
  const [localAliveShells, setLocalAliveShells] = useState<Array<{ projectId: number; projectName: string; projectPath: string; shellIndex: number; launchArgv: string[] }>>([]);
  const [mainTab, persistMainTab] = usePersistedState<MainTab>('metaide.mainTab', 'shell', isMainTab);
  const setMainTab = useCallback((tab: MainTab) => { closeBoard(); persistMainTab(tab); }, [closeBoard, persistMainTab]);
  const assignment = useAssignment(selected?.id ?? null);
  const boardVisible = boardProject !== null && boardProject === selected?.id && !remotePane;
  const mainTabRef = useRef(mainTab);
  mainTabRef.current = mainTab;
  const activityEnabled = useActivityLogEnabled();
  useEffect(() => {
    if (visibleMainTab(mainTab, activityEnabled) !== mainTab) setMainTab('shell');
  }, [mainTab, activityEnabled, setMainTab]);
  const accountEpoch = account?.phase === 'signed-in' ? account.epoch : null;
  const [unread, setUnread] = useState<{ epoch: number; count: number } | null>(null);
  const chatUnread = unread && unread.epoch === accountEpoch ? unread.count : 0;
  const [activeView, persistActiveView] = usePersistedState<ActivityView>(
    'metaide.activeView',
    'projects',
    (v): v is ActivityView => v === 'projects' || v === 'chat' || v === 'git' || v === 'tasks' || v === 'fleet',
  );
  const setActiveView = useCallback((view: ActivityView) => { closeBoard(); persistActiveView(view); }, [closeBoard, persistActiveView]);
  const activeViewRef = useRef<ActivityView>('projects');
  activeViewRef.current = activeView;
  useEffect(() => api.on('metaproject:chat-event', ({ epoch, event }) => {
    const now = currentAccount();
    if (now?.phase !== 'signed-in' || now.epoch !== epoch || event !== 'channel_message' || activeViewRef.current === 'chat') return;
    setUnread((previous) => ({ epoch, count: previous?.epoch === epoch ? previous.count + 1 : 1 }));
  }), [currentAccount]);
  useEffect(() => { if (activeView === 'chat' || accountEpoch === null) setUnread(null); }, [activeView, accountEpoch]);
  // Clear any pending "open this file" request when the project changes —
  // otherwise a relPath captured from project A would fire in project B's
  // FilesTab and either open the wrong file or 404. The one exception is a
  // file opened from another project's terminal path, recorded for exactly
  // this project before the switch.
  const [pendingFileOpen] = useState(createPendingFileOpen);
  useEffect(() => {
    const open = pendingFileOpen.take(selected?.id ?? null);
    setOpenInFiles(open);
    if (open) setMainTab('files');
  }, [selected?.id, pendingFileOpen, setMainTab]);
  const taskCount = useTaskCount(selected?.id ?? null);
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
  useEffect(() => { activeShellIndexRef.current = activeShellIndex; }, [activeShellIndex]);
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
  const primaryAlive = allProjectShells.some((shell) => shell.shellIndex === 0);
  const [unloadTarget, setUnloadTarget] = useState<Pick<Project, 'id' | 'name'> | null>(null);
  const unloadTargetRef = useRef<Pick<Project, 'id' | 'name'> | null>(null);
  const unloadOpenerRef = useRef<HTMLElement | null>(null);
  const openUnloadSession = useCallback((project: Project, opener: HTMLElement | null) => beforeOverlay(() => {
    if (unloadTargetRef.current) return;
    unloadTargetRef.current = { id: project.id, name: project.name };
    unloadOpenerRef.current = opener;
    setUnloadTarget(unloadTargetRef.current);
  }), [beforeOverlay]);
  const closeUnloadSession = useCallback(() => {
    unloadTargetRef.current = null;
    setUnloadTarget(null);
    requestAnimationFrame(() => {
      const opener = unloadOpenerRef.current;
      const fallback = document.querySelector<HTMLElement>('[data-testid="status-bar-palette-hint"]');
      (opener?.isConnected ? opener : fallback)?.focus();
      unloadOpenerRef.current = null;
    });
  }, []);
  // Label shown in the status bar for the visible shell's agent. Read from
  // the same alive-shells list the tab chips use, so the two stay in sync.
  const activeShellAgentLabel: string | null = useMemo(() => {
    const row = allProjectShells.find((s) => s.shellIndex === activeShellIndex);
    return row?.launchName ?? null;
  }, [allProjectShells, activeShellIndex]);
  const activeShellAgentState = useShellAgentState(selected?.id ?? -1, activeShellIndex).state;
  const activeShellAgentStateLabel = activeShellAgentLabel ? activeShellAgentState : null;
  const showStatusBar = useShowStatusBar();
  const reduceMotion = useReducedMotion() ?? false;
  // Hold terminal geometry while the status bar folds, then refit once.
  const [statusBarAnimating, setStatusBarAnimating] = useState(false);
  const statusBarFirst = useRef(true);
  useLayoutEffect(() => {
    if (statusBarFirst.current) { statusBarFirst.current = false; return; }
    setStatusBarAnimating(true);
    const t = window.setTimeout(() => setStatusBarAnimating(false), STATUS_BAR_MS + 80);
    return () => window.clearTimeout(t);
  }, [showStatusBar]);
  useTerminalGeometryHold(statusBarAnimating, showStatusBar);
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
  const sidebarFold = usePaneFold(sidebarOpen, sidebarAnimate);
  const sheetInColumn = hasSheet(activeView) && !remotePane;
  const [columnDragging, setColumnDragging] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth();
  // Chat panel gets its own persisted width so the wider chat view doesn't
  // resize the projects list back to a tiny column when the user flips modes.
  const [chatPanelWidth, setChatPanelWidth] = usePersistedNumber('metaide.chatPanelWidth', 400, 300, 640);
  const [settingsOpen, updateSettingsOpen] = useState(false);
  const setSettingsOpen = useCallback((open: boolean) => { if (open) beforeOverlay(() => updateSettingsOpen(open)); else updateSettingsOpen(false); }, [beforeOverlay]);
  const [projectSettingsTarget, setProjectSettingsTarget] = useState<ProjectSettingsTarget | null>(null);
  const settingsTarget = projectSettingsTarget ?? selected;
  // Bumped by "Environment variables…" so the Settings tab scrolls its env section into view.
  const [envFocusRequest, setEnvFocusRequest] = useState(0);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [newProjectOpen, updateNewProjectOpen] = useState(false);
  const setNewProjectOpen = useCallback((open: boolean) => { if (open) beforeOverlay(() => updateNewProjectOpen(open)); else updateNewProjectOpen(false); }, [beforeOverlay]);
  const [openInFiles, setOpenInFiles] = useState<{ relPath: string; line: number | null } | null>(null);
  const [paletteRequest, setPaletteRequest] = useState<PaletteRequest | null>(null);
  const paletteOpenRef = useRef(false);
  paletteOpenRef.current = paletteRequest != null;
  const paletteSeqRef = useRef(0);
  const openPalette = useCallback((seed: PaletteSeed) => beforeOverlay(() => {
    paletteSeqRef.current += 1;
    setPaletteRequest({ seq: paletteSeqRef.current, seed });
  }), [beforeOverlay]);
  const [helpOpen, updateHelpOpen] = useState(false);
  const setHelpOpen = useCallback((open: boolean) => { if (open) beforeOverlay(() => updateHelpOpen(true)); else updateHelpOpen(false); }, [beforeOverlay]);
  const helpOpenRef = useRef(helpOpen);
  helpOpenRef.current = helpOpen;
  const [searchOpen, updateSearchOpen] = useState(false);
  const setSearchOpen = useCallback((open: boolean) => { if (open) beforeOverlay(() => updateSearchOpen(open)); else updateSearchOpen(false); }, [beforeOverlay]);
  const [promptsOpen, updatePromptsOpen] = useState(false);
  const setPromptsOpen = useCallback((open: boolean) => { if (open) beforeOverlay(() => updatePromptsOpen(open)); else updatePromptsOpen(false); }, [beforeOverlay]);
  const [scrollbackOpen, updateScrollbackOpen] = useState(false);
  const setScrollbackOpen = useCallback((open: boolean) => { if (open) beforeOverlay(() => updateScrollbackOpen(open)); else updateScrollbackOpen(false); }, [beforeOverlay]);
  const keepAwake = useKeepAwake();
  const [keepAwakeUntilOpen, updateKeepAwakeUntilOpen] = useState(false);
  const setKeepAwakeUntilOpen = useCallback((open: boolean) => { if (open) beforeOverlay(() => updateKeepAwakeUntilOpen(open)); else updateKeepAwakeUntilOpen(false); }, [beforeOverlay]);
  const keepAwakeActive = keepAwake?.state.active ?? false;
  const keepAwakeStart = keepAwake?.start;
  const keepAwakeStop = keepAwake?.stop;
  const keepAwakeDarken = keepAwake?.darkenNow;
  const paletteKeepAwake = useMemo(() => (
    keepAwakeStart && keepAwakeStop && keepAwakeDarken
      ? {
          active: keepAwakeActive,
          start: (minutes: number) => { void keepAwakeStart(minutes * 60_000); },
          openUntil: () => setKeepAwakeUntilOpen(true),
          stop: () => { void keepAwakeStop(); },
          darkenNow: () => { void keepAwakeDarken(); },
        }
      : null
  ), [keepAwakeActive, keepAwakeStart, keepAwakeStop, keepAwakeDarken, setKeepAwakeUntilOpen]);
  const envDrafts = useEnvDrafts();
  const envDirty = selected != null && envDrafts.isDirty(selected.id);
  const { mode: themeMode, effective: effectiveTheme, cycle: cycleTheme, setMode: setThemeMode, setPalette: setThemePalette } = useTheme();
  const permissionMode = useClaudePermissionMode();
  const shortcutsBlockedRef = useRef(true);
  shortcutsBlockedRef.current = permissionMode.status !== 'chosen' || unloadTarget !== null || promptOpen;
  const overlayOpen = paletteRequest != null || settingsOpen || newProjectOpen
    || helpOpen || (searchOpen && selected != null) || promptsOpen || scrollbackOpen
    || permissionMode.status === 'unchosen' || unloadTarget !== null || promptOpen || keepAwakeUntilOpen;
  useWindowTerminalFocus(overlayOpen || boardVisible);
  // A request issued while the palette is still open is refused by the overlay rule, so it waits for the close to commit.
  const focusAfterPaletteRef = useRef<number | null>(null);
  useEffect(() => {
    const projectId = focusAfterPaletteRef.current;
    if (paletteRequest != null || projectId == null) return;
    focusAfterPaletteRef.current = null;
    terminalFocus.requestProjectFocus(projectId);
  }, [paletteRequest]);
  useReportViewedShells({ selectedProjectId: boardVisible ? null : selected?.id ?? null, mainTab, activeShellIndex, rightShellIndex });
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

  const tabLaunchRef = useRef(0);
  const tabMotionRef = useRef<ShellTabMotion>(null);
  function selectTerminalTab(shellIndex: number) {
    if (!selected) return;
    ++tabLaunchRef.current;
    terminalFocus.cancelRequest();
    setActiveShellIndex(shellIndex);
  }

  const restoreClosedTerminal = useCallback((projectId: number, shellIndex: number) => {
    if (shellIndex === 0 || selectedRef.current?.id !== projectId || activeShellIndexRef.current !== shellIndex) return;
    setActiveShellIndexFor(projectId, 0);
  }, [setActiveShellIndexFor]);

  const beginTerminalTabLaunch = useCallback((projectId: number, onLaunched?: ShellLaunched) => {
    const launch = ++tabLaunchRef.current;
    terminalFocus.cancelRequest();
    const selection = selectionRequestRef.current;
    const main = mainTabRef.current;
    const view = activeViewRef.current;
    const remote = remotePaneRef.current;
    const opener = document.activeElement;
    const isCurrent = () => launch === tabLaunchRef.current && selection === selectionRequestRef.current &&
      selectedRef.current?.id === projectId && main === mainTabRef.current && view === activeViewRef.current && remote === remotePaneRef.current;
    return (shellIndex: number) => {
      if (!isCurrent()) return;
      onLaunched?.(shellIndex);
      if (opener !== document.activeElement && activeElementKind() === 'text-entry') return;
      setMainTab('shell');
      setActiveShellIndexFor(projectId, shellIndex);
      if (document.hasFocus()) terminalFocus.requestFocus({ projectId, shellIndex });
    };
  }, [setActiveShellIndexFor, setMainTab]);

  /** Launches a plain shell in the selected project: a new tab (⌘T) or, with `newWindow`, a new window (⌘⇧T). */
  const openNewTerminal = useCallback((newWindow: boolean, onLaunched?: ShellLaunched) => {
    const p = selectedRef.current;
    if (!p) return;
    const activate = newWindow ? null : beginTerminalTabLaunch(p.id, onLaunched);
    void (async () => {
      try {
        const { shellIndex } = await api.invoke('shells:launch-plain', { projectId: p.id });
        if (newWindow) {
          await api.invoke('windows:popout-shell', { projectId: p.id, shellIndex });
          toast(`New terminal in ${p.name}`, { kind: 'info' });
        } else activate?.(shellIndex);
      } catch (err) {
        toast('Failed to open terminal', { kind: 'error', detail: String(err).replace(/^Error:\s*/, '') });
      }
    })();
  }, [beginTerminalTabLaunch]);
  const openNewTerminalRef = useRef(openNewTerminal);
  openNewTerminalRef.current = openNewTerminal;

  const commands = useMemo(() => buildPaletteCommands({
    hasProject: selected != null,
    hasPrimary: primaryAlive && remotePane === null,
    sidebarOpen,
    openPalette,
    openProjectSearch: () => setSearchOpen(true),
    openScrollbackSearch: () => setScrollbackOpen(true),
    openPrompts: () => setPromptsOpen(true),
    showTasks: () => setActiveView('tasks'),
    toggleSidebar: () => toggleSidebar(false),
    statusBarVisible: showStatusBar,
    toggleStatusBar: () => { void api.invoke('settings:set', { key: 'show_status_bar', value: !showStatusBar }); },
    showTab: setMainTab,
    openHelp: () => setHelpOpen(true),
    openNewProject: () => setNewProjectOpen(true),
    unloadSession: async () => {
      if (selected && !remotePane && primaryAlive) {
        openUnloadSession(selected, document.querySelector<HTMLElement>('[data-testid="status-bar-palette-hint"]'));
      }
    },
    popOutShell: async () => {
      if (selected) await api.invoke('windows:popout-shell', { projectId: selected.id, shellIndex: 0 });
    },
    findInTerminal: () => toast(SHORTCUT_COPY.findInTerminalToast(platform), { kind: 'info' }),
    openNewTerminal,
    setThemeMode,
    setThemePalette,
    openSettings: (section) => {
      if (section) setSettingsSection(section);
      setSettingsOpen(true);
    },
    keepAwake: paletteKeepAwake,
    platform,
  }), [selected, remotePane, primaryAlive, openUnloadSession, sidebarOpen, openPalette, setActiveView, toggleSidebar, showStatusBar, setMainTab, openNewTerminal, setThemeMode, setThemePalette, paletteKeepAwake, platform, setSearchOpen, setScrollbackOpen, setPromptsOpen, setHelpOpen, setNewProjectOpen, setSettingsOpen]);

  const refreshAlive = useCallback(async () => {
    const { shells } = await api.invoke('shells:alive-list', undefined as never);
    setAliveCount(shells.length);
    // Also expose the full list for the Fleet view (self-row shells).
    setLocalAliveShells(shells.map((r) => ({
      projectId: r.projectId,
      projectName: r.projectName,
      projectPath: r.projectPath,
      shellIndex: r.shellIndex,
      launchArgv: r.launchArgv,
    })));
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
        const defaultCliNow    = fresh.config.defaultCliName ?? null;
        const defaultCliBefore = cur.config.defaultCliName   ?? null;
        const materialChange =
          defaultCliNow !== defaultCliBefore
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
      closeBoard();
      const requestId = ++selectionRequestRef.current;
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
        if (selectionRequestRef.current !== requestId) return;
        await api.invoke('projects:open', { id: project.id });
        if (selectionRequestRef.current !== requestId) return;
        setProjectSettingsTarget(null);
        setRemotePane(null);
        setActiveView('projects');
        setSelected(project);
        try { await api.invoke('shells:launch', { projectId: project.id }); } catch { /* fine */ }
        setMainTab('files');
        if (relPath) requestAnimationFrame(() => setOpenInFiles({ relPath, line: null }));
      } catch (e) {
        toast('Could not open file', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
      }
    });
    return () => { off(); };
  }, [closeBoard, setActiveView, setMainTab]);

  // A clicked fleet notice: open that shell on the paired machine it came from.
  useEffect(() => {
    const off = api.on('p2p:focus-remote-shell', ({ deviceId, deviceName, projectId, projectName, shellIndex }) => {
      setActiveView('projects');
      setRemotePane({ source: { kind: 'remote', deviceId }, deviceName, projectId, projectName, shellIndex });
    });
    return () => { off(); };
  }, [setActiveView]);

  // Click-to-focus for "command done" OS notifications: the main process
  // fires `shell:focus-request` with a (projectId, shellIndex). We look up
  // the project (it may not be the one currently selected), open it, and
  // switch to that shell tab.
  useEffect(() => {
    const off = api.on('shell:focus-request', async ({ projectId, shellIndex }) => {
      closeBoard();
      const requestId = ++selectionRequestRef.current;
      setRemotePane(null);
      terminalFocus.requestFocus({ projectId, shellIndex });
      try {
        const cur = selectedRef.current;
        if (!cur || cur.id !== projectId) {
          const { project } = await api.invoke('projects:open', { id: projectId });
          if (selectionRequestRef.current !== requestId) return;
          setProjectSettingsTarget(null);
          setSelected(project);
        }
        setMainTab('shell');
        requestAnimationFrame(() => setActiveShellIndexFor(projectId, shellIndex));
      } catch (e) {
        toast('Could not focus shell', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
      }
    });
    return () => { off(); };
  }, [closeBoard, setActiveShellIndexFor, setMainTab]);

  useEffect(() => {
    const runAppShortcut: Readonly<Record<AppShortcutAction, () => void>> = {
      'toggle-sidebar': () => toggleSidebar(false),
      'open-settings': () => setSettingsOpen(true),
      'new-project': () => setNewProjectOpen(true),
      'project-search': () => setSearchOpen(true),
      prompts: () => setPromptsOpen(true),
      'scrollback-search': () => setScrollbackOpen(true),
      'toggle-help': () => setHelpOpen(!helpOpenRef.current),
      'new-terminal': () => openNewTerminalRef.current(false, tabMotionRef.current?.launchResult()),
      'new-terminal-window': () => openNewTerminalRef.current(true),
    };
    function onKey(e: KeyboardEvent) {
      if (shortcutsBlockedRef.current) return;
      const palette = paletteKeyAction(e, paletteOpenRef.current, platform);
      if (palette.kind === 'swallow') return;
      if (palette.kind === 'toggle' || palette.kind === 'open') {
        e.preventDefault();
        if (palette.kind === 'open') openPalette(palette.seed);
        else if (paletteOpenRef.current) setPaletteRequest(null);
        else openPalette('');
        return;
      }
      const mod = platform === 'mac' ? e.metaKey : e.ctrlKey;
      if (mod && e.shiftKey && (e.key === 'Enter' || e.key === 'Return')) {
        // ⌘⇧Enter (Ctrl+Shift+Enter on Windows/Linux) → toggle native fullscreen.
        e.preventDefault();
        toggleFullscreenRef.current();
      }
      if (mod && e.key.toLowerCase() === 'w' && !e.shiftKey && !e.altKey) {
        // ⌘W → close the active shell tab in the current project.
        const p = selectedRef.current;
        if (!p) return;
        e.preventDefault();
        const idx = activeShellIndexRef.current;
        const cancelCloseMotion = tabMotionRef.current?.beginClose(idx);
        (async () => {
          try {
            await api.invoke('shells:kill', { projectId: p.id, shellIndex: idx });
            restoreClosedTerminal(p.id, idx);
          } catch (err) {
            cancelCloseMotion?.();
            toast('Failed to close tab', { kind: 'error', detail: String(err).replace(/^Error:\s*/, '') });
          }
        })();
      }
      const action = appShortcutAction(e, platform);
      if (action) { e.preventDefault(); runAppShortcut[action](); }
      if (e.key === 'Escape')                            { setSettingsOpen(false); setPaletteRequest(null); setNewProjectOpen(false); setHelpOpen(false); setSearchOpen(false); setPromptsOpen(false); setScrollbackOpen(false); }
    }
    function ghosttyAppKey(e: KeyboardEvent): boolean {
      return e.target instanceof Element && !!e.target.closest(GHOSTTY_HOST_SELECTOR) &&
        routeTerminalKey(e, platform) === 'app' && terminalTabAction(e, platform) === null;
    }
    function capture(e: KeyboardEvent) { if (ghosttyAppKey(e)) onKey(e); }
    function bubble(e: KeyboardEvent) { if (!ghosttyAppKey(e)) onKey(e); }
    window.addEventListener('keydown', capture, true);
    window.addEventListener('keydown', bubble);
    return () => {
      window.removeEventListener('keydown', capture, true);
      window.removeEventListener('keydown', bubble);
    };
  }, [openPalette, toggleSidebar, platform, restoreClosedTerminal, setSettingsOpen, setNewProjectOpen, setHelpOpen, setSearchOpen, setPromptsOpen, setScrollbackOpen]);

  // Keep the OS window title in sync with the current project so it reads
  // "lawreader — MetaLogix IDE" in Mission Control, Dock previews, and every
  // window-manager surface. Electron picks up document.title changes and
  // pushes them straight to the BrowserWindow's native title.
  useEffect(() => {
    document.title = remotePane ? `${remotePane.projectName} on ${remotePane.deviceName} — MetaLogix IDE` : selected ? `${selected.name} — MetaLogix IDE` : 'MetaLogix IDE';
  }, [selected, remotePane]);

  useExternalDragGuard();

  /** Selects `p` as the sidebar does and launches its shell; resolves true when it selected `p`, false when the open failed or a newer pick superseded it. */
  async function pick(p: Pick<Project, 'id'>): Promise<boolean> {
    closeBoard();
    setProjectSettingsTarget(null);
    setRemotePane(null);
    const requestId = ++selectionRequestRef.current;
    terminalFocus.cancelRequest();
    setActiveView('projects');
    let selectedIt = false;
    try {
      const { project } = await api.invoke('projects:open', { id: p.id });
      if (selectionRequestRef.current !== requestId) return false;
      if (mainTabRef.current === 'shell') terminalFocus.requestProjectFocus(project.id);
      setSelected(project);
      selectedIt = true;
      await api.invoke('shells:launch', { projectId: project.id });
    } catch (e) {
      // Only surface the toast when the failure is for the current pick —
      // otherwise a stale evictee-failure would confuse the user.
      if (selectionRequestRef.current === requestId) {
        toast('Failed to launch shell', { kind: 'error', detail: String(e).replace(/^Error:\s*/, ''), timeoutMs: 8000 });
        // Open Settings → Launch commands so the user can fix the startup command immediately.
        setSettingsSection('launch');
        setSettingsOpen(true);
      }
      console.error(e);
    }
    return selectedIt && selectionRequestRef.current === requestId;
  }

  /**
   * Opens a file a terminal path or hover preview found in another project: records it as pending for that project,
   * then selects the project through the sidebar's `pick` path. The project-change effect opens it in the Files tab
   * when the selection lands; a failed or superseded pick drops it and restores the tab ref.
   */
  async function openFileInProject(projectId: number, relPath: string, line: number | null): Promise<void> {
    pendingFileOpen.request(projectId, { relPath, line });
    const previousTab = mainTabRef.current;
    // Set synchronously so pick() queues no terminal focus for a tab that is about to become Files.
    mainTabRef.current = 'files';
    const selectedIt = await pick({ id: projectId });
    pendingFileOpen.pickSettled(projectId, selectedIt);
    if (!selectedIt) mainTabRef.current = previousTab;
  }

  function editEnv(p: Project) {
    // Set synchronously so pick() sees 'settings' and queues no terminal focus for a later Settings -> Shell switch.
    setProjectSettingsTarget(null);
    mainTabRef.current = 'settings';
    setMainTab('settings');
    setEnvFocusRequest((n) => n + 1);
    void pick(p);
  }

  /** Opens an explicit sidebar target without selecting its project or launching a shell. */
  const openProjectSettings = useCallback((target: ProjectSettingsTarget): void => {
    setEnvFocusRequest(0);
    setRemotePane(null);
    setProjectSettingsTarget(target);
    mainTabRef.current = 'settings';
    setMainTab('settings');
  }, [setMainTab]);

  useLayoutEffect(() => {
    if (boardVisible && selected && assignment.state.kind === 'loaded' && assignment.state.value.kind !== 'linked') openProjectSettings(selected);
  }, [assignment.state, boardVisible, selected, openProjectSettings]);

  /** The main tab always targets the selected project rather than a previous sidebar override. */
  function openSelectedProjectSettings(): void {
    setEnvFocusRequest(0);
    setProjectSettingsTarget(null);
    mainTabRef.current = 'settings';
    setMainTab('settings');
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
            onOpenFile={(relPath, line, targetProjectId) => {
              if (targetProjectId !== undefined && targetProjectId !== project.id) {
                void openFileInProject(targetProjectId, relPath, line);
                return;
              }
              setMainTab('files');
              setOpenInFiles({ relPath, line });
            }}
            onOpenLaunchSettings={() => { setSettingsSection('launch'); setSettingsOpen(true); }}
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
            isFullscreen={fullscreen}
            onFullscreenToggle={toggleFullscreen}
          />
        );
      case 'diff':
        return <DiffTab key={project.id} projectId={project.id} />;
      case 'activity':
        return <ActivityTab key={project.id} projectId={project.id} onOpenTarget={(t) => void openFileTarget(t)} followFiles={followFiles} onFollowFilesChange={setFollowFiles} />;
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

  /** Spawn a named CLI profile (Claude, Llama, custom…). */
  async function launchCliProfile(profileName: string, mode: 'tab' | 'window', onLaunched?: ShellLaunched) {
    if (!selected) return;
    const activate = mode === 'tab' ? beginTerminalTabLaunch(selected.id, onLaunched) : null;
    try {
      const { shellIndex } = await api.invoke('shells:launch-cli', { projectId: selected.id, profileName });
      if (mode === 'window') {
        await api.invoke('windows:popout-shell', { projectId: selected.id, shellIndex });
        toast(`${profileName} in ${selected.name}`, { kind: 'info' });
      } else activate?.(shellIndex);
    } catch (e) {
      toast(`Failed to launch ${profileName}`, { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    }
  }

  /** Run a one-off custom command, optionally saving it as a project profile. */
  async function launchCustomCli(name: string, cmdLine: string, save: boolean, mode: 'tab' | 'window', onLaunched?: ShellLaunched) {
    if (!selected) return;
    // Very small argv splitter: whitespace + double-quoted groups. Not a
    // shell — we don't do variable expansion or piping. Users who need that
    // can invoke `bash -lc "..."` explicitly.
    const argv: string[] = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cmdLine)) !== null) argv.push(m[1] ?? m[2] ?? '');
    if (argv.length === 0) throw new Error('empty command');
    const activate = mode === 'tab' ? beginTerminalTabLaunch(selected.id, onLaunched) : null;
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
      } else activate?.(shellIndex);
    } catch (e) {
      toast('Failed to launch CLI', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    }
  }

  /** Resolve an agent tool target (absolute or project-relative) and open it in the Files viewer. */
  async function openFileTarget(target: string) {
    if (!selected) return;
    const hit = await resolveFileTarget(selected.id, target);
    if (!hit) { toast('Could not resolve that file', { kind: 'info' }); return; }
    setMainTab('files');
    setOpenInFiles({ relPath: hit.relPath, line: null });
  }
  // Agent file-follow: when on, live-open every file the agent edits.
  const [followFiles, setFollowFiles] = usePersistedState<boolean>('metaide.followFiles', false, (v): v is boolean => typeof v === 'boolean');
  useAgentFileFollow(selected?.id ?? null, followFiles && activityEnabled, (t) => void openFileTarget(t));

  async function killShell(shellIndex: number, cancelCloseMotion?: () => void) {
    if (!selected) { cancelCloseMotion?.(); return; }
    try {
      await api.invoke('shells:kill', { projectId: selected.id, shellIndex });
      restoreClosedTerminal(selected.id, shellIndex);
      if (rightShellIndex === shellIndex) setRightShellIndex(null);
    } catch (e) {
      cancelCloseMotion?.();
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

  function applyDefaultAgentProject(project: Project): void {
    if (selectedRef.current?.id !== project.id) return;
    setSelected((current) => current?.id === project.id ? project : current);
  }

  async function tileWindows() {
    try {
      const { arranged } = await api.invoke('windows:tile-all', undefined as never);
      toast(`Tiled ${arranged} window${arranged === 1 ? '' : 's'}`, { kind: 'success', timeoutMs: 1200 });
    } catch (e) { toast('Tile failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') }); }
  }

  const mainSheetContent: SheetContent = !boardVisible && mainTab === 'shell' ? 'shell' : 'other';

  return (
    <div className="h-screen w-screen overflow-hidden flex flex-col bg-[--surface-chrome]" data-chrome-root>
      <div className="flex-1 flex min-h-0">
        <ActivityBar
          active={activeView}
          onSelect={(v) => {
            const next = sidebarOpen && activeView === v && v !== 'projects' ? 'projects' : v;
            setActiveView(next);
            if (!sidebarOpen) toggleSidebar(true, true);
          }}
          onToggleSidebar={() => toggleSidebar(true)}
          sidebarOpen={sidebarOpen}
          chatUnread={chatUnread}
          footer={(
            <>
              <ABButton
                label={`Theme: ${themeMode}${themeMode === 'system' ? ` (following OS — currently ${effectiveTheme})` : ''}. Click to toggle.`}
                onClick={cycleTheme}
                active={false}
                data-testid="theme-toggle"
                data-theme-mode={themeMode}
              >
                <ThemeIcon mode={themeMode} effective={effectiveTheme} />
              </ABButton>
              <ABButton label="Tile all our windows on the screen" onClick={tileWindows} active={false} data-testid="tile-windows">
                <TileIcon />
              </ABButton>
              <ABButton label={SHORTCUT_COPY.settingsTitle(platform)} onClick={() => setSettingsOpen(true)} active={false} data-testid="settings-open">
                <GearIcon />
              </ABButton>
              <UsageMeter />
            </>
          )}
          gitDirty={git.dirty ? Object.keys(git.files).length : undefined}
          taskCount={taskCount || undefined}
        />
        <AnimatePresence initial={false} custom={sidebarFold.custom}>
          {sidebarOpen && (
            <FoldPane key="sidebar" size="intrinsic" anchor="end" className="fleet-projects-pane" custom={sidebarFold.custom} onFoldComplete={sidebarFold.onFoldComplete}>
              {/* One sidebar column whose width animates when its view (and so its remembered width) changes. */}
              <div
                className={`relative h-full shrink-0 overflow-hidden ${columnDragging ? '' : 'transition-[width] duration-200 ease-out motion-reduce:transition-none'}`}
                style={{ width: sheetInColumn ? chatPanelWidth : sidebarWidth }}
                data-testid="sidebar-column"
              >
                {/* Chat, Git and Tasks replace the project list in the same sidebar column. */}
                {sheetInColumn ? (
                    <div
                      data-view={activeView}
                      className="section-panel h-full flex flex-col shrink-0 pt-12"
                      style={{ width: chatPanelWidth }}
                    >
                      <div aria-hidden className="drag absolute inset-x-0 top-0 h-11" />
                      {activeView === 'chat' && (
                        <ChatTab
                          projectId={selected?.id ?? 0}
                          assignment={assignment.state}
                          compact
                          onDismiss={() => setActiveView('projects')}
                        />
                      )}
                      {activeView === 'git' && <GitPanel projectId={selected?.id ?? null} />}
                      {activeView === 'tasks' && (
                        <TasksPanel
                          projectId={selected?.id ?? null}
                          onLaunched={(shellIndex) => { setMainTab('shell'); setActiveShellIndex(shellIndex); }}
                        />
                      )}
                    </div>
                ) : (
                    <Sidebar
                    selectedProjectId={remotePane ? null : selected?.id ?? null}
                    onUnloadSession={openUnloadSession}
                    onSelect={(project) => {
                      void pick(project);
                      if (window.innerWidth < 640) toggleSidebar(false, false);
                    }}
                    onOpenPane={(req) => {
                      openPane(req);
                      if (window.innerWidth < 640) toggleSidebar(false, false);
                    }}
                    onNewProject={() => setNewProjectOpen(true)}
                    onEditEnv={editEnv}
                    onProjectSettings={openProjectSettings}
                    width={sidebarWidth}
                  />
                )}
              </div>
              <ResizeHandle
                value={sheetInColumn ? chatPanelWidth : sidebarWidth}
                onChange={sheetInColumn ? setChatPanelWidth : setSidebarWidth}
                onReset={() => (sheetInColumn ? setChatPanelWidth(400) : setSidebarWidth(SIDEBAR_WIDTH.default))}
                min={sheetInColumn ? 280 : SIDEBAR_WIDTH.min}
                max={sheetInColumn ? 640 : SIDEBAR_WIDTH.max}
                side="left"
                onDraggingChange={setColumnDragging}
              />
            </FoldPane>
          )}
        </AnimatePresence>
        <div className="workspace-header-container flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden" data-testid="main-column">
            <header className="workspace-header-row drag relative shrink-0 items-center gap-x-1.5 gap-y-1 px-3 py-1.5 text-xs" hidden={!!remotePane} data-testid={DIFF_TESTIDS.tabBar}>
              <div className="workspace-destinations flex min-w-0 flex-wrap items-center gap-1.5">
                <WorkspaceTabButton tab="shell" label="Shell" active={!boardVisible && mainTab === 'shell'} onClick={() => setMainTab('shell')} />
                <WorkspaceTabButton tab="files" label="Files" active={!boardVisible && mainTab === 'files'} onClick={() => setMainTab('files')} />
                <WorkspaceTabButton tab="diff" label={DIFF_COPY.tabLabel}
                  active={!boardVisible && mainTab === 'diff'}
                  onClick={() => setMainTab('diff')}
                  testId={DIFF_TESTIDS.tab}
                  ariaLabel={diffCount !== null ? DIFF_COPY.tabCountLabel(diffCount) : undefined}
                >
                  {diffCount !== null && (
                    <span aria-hidden className="ml-1.5 font-mono text-[10px] text-[--hue-orange-text]" data-testid={DIFF_TESTIDS.tabCount}>
                      {diffCount}
                    </span>
                  )}
                </WorkspaceTabButton>
                <WorkspaceTabButton tab="settings" label={PROJECT_SETTINGS_COPY.tab}
                  active={!boardVisible && mainTab === 'settings'}
                  onClick={openSelectedProjectSettings}
                  testId={PROJECT_SETTINGS_TESTIDS.tab}
                  ariaLabel={envDirty ? ENV_COPY.tabUnsavedLabel : undefined}
                >
                  {envDirty && (
                    <span aria-hidden className="ml-1 text-[--accent]" data-testid={ENV_TESTIDS.unsaved}>
                      {ENV_COPY.tabUnsavedMarker}
                    </span>
                  )}
                </WorkspaceTabButton>
                {activityEnabled && (
                  <WorkspaceTabButton tab="activity" label="Activity" active={!boardVisible && mainTab === 'activity'} onClick={() => setMainTab('activity')} testId={ACTIVITY_LOG_TESTIDS.tabButton} />
                )}
              </div>
              {!remotePane && !boardVisible && selected && mainTab === 'shell' && (
                <ShellTabsBar
                  key={`shell-tabs-${selected.id}`}
                  projectId={selected.id}
                  shells={stripShells(projectShells, rightShellIndex, split.hiddenShells)}
                  active={activeShellIndex}
                  onSelect={selectTerminalTab}
                  onClose={killShell}
                  motionRef={tabMotionRef}
                  defaultCliName={selected.config.defaultCliName ?? null}
                  onDefaultCliChanged={applyDefaultAgentProject}
                  onLaunchProfile={(name, onLaunched) => void launchCliProfile(name, 'tab', onLaunched)}
                  onLaunchPlainTab={(onLaunched) => openNewTerminal(false, onLaunched)}
                  onLaunchCustom={(name, cmdLine, save, onLaunched) => void launchCustomCli(name, cmdLine, save, 'tab', onLaunched)}
                />
              )}
              <div className="workspace-project-actions flex min-w-0 flex-wrap items-center justify-end gap-2 pr-2">
                {selected && (
                  <>
                    <button ref={boardOpener} type="button" className="no-drag flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-[--text] hover:bg-[--panel-strong] focus-visible:ring-2 focus-visible:ring-[--accent]"
                      data-testid="metaproject-board" aria-pressed={boardVisible} onClick={() => {
                        if (boardVisible) returnToWorkspace();
                        else if (assignment.state.kind === 'loaded' && assignment.state.value.kind !== 'linked') openProjectSettings(selected);
                        else {
                          if (activeView === 'fleet') setActiveView('projects');
                          terminalFocus.cancelRequest(); setBoardProject(selected.id);
                        }
                      }}><span className="text-[--hue-purple]" aria-hidden="true"><BoardIcon /></span>Board</button>
                    <Tooltip label="Prompt library" shortcut={SHORTCUT_COPY.promptsShortcut(platform)}>
                      <button
                        onClick={() => setPromptsOpen(true)}
                        className="text-[--text-muted] hover:text-[--text] w-7 h-7 flex items-center justify-center rounded hover:bg-[--panel-strong]"
                        data-testid="prompts-open"
                        aria-label="Open prompt library"
                      >
                        <PromptsIcon />
                      </button>
                    </Tooltip>
                    <Tooltip label="Search all shells" shortcut={SHORTCUT_COPY.scrollbackShortcut(platform)}>
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
                    <div className="no-drag flex shrink-0 items-center gap-2">
                      {mainTab === 'shell' && (
                        <SplitButton on={rightShellIndex != null} onToggle={() => (rightShellIndex != null ? split.closeSplit() : void openSplit())} />
                      )}
                      <Tooltip label="Pop the active shell into its own window">
                        <button
                          onClick={popoutCurrent}
                          className="text-[--text-muted] hover:text-[--text] w-7 h-7 flex items-center justify-center rounded hover:bg-[--panel-strong]"
                          data-testid="popout-shell"
                        >
                          <PopoutIcon />
                        </button>
                      </Tooltip>
                    </div>
                  </>
                )}
              </div>
            </header>
          <main
            className={`workspace-sheet mx-2 mt-0.5 flex flex-1 flex-col min-h-0 min-w-0 rounded-[14px] bg-[--surface-sheet] ${showStatusBar ? 'mb-0.5' : 'mb-2'}`}
            data-sheet-content={mainSheetContent}
          >
            <div className="flex-1 relative min-h-0 flex flex-col">
              <div {...(boardVisible ? { inert: '' } : {})} aria-hidden={boardVisible || undefined} className={`flex flex-1 min-h-0 min-w-0 flex-col ${boardVisible ? 'invisible pointer-events-none' : ''}`}>
              {activeView === 'fleet'
                ? <FleetView
                    localShells={localAliveShells}
                    onOpenLocal={(projectId, shellIndex) => {
                      setActiveView('projects');
                      void api.invoke('projects:open', { id: projectId }).then(() => {
                        setMainTab('shell');
                        setActiveShellIndexFor(projectId, shellIndex);
                      });
                    }}
                    onOpenRemote={(req) => { setActiveView('projects'); setRemotePane(req); }}
                  />
                : remotePane
                ? <RemoteProjectPane deviceId={remotePane.source.deviceId} deviceName={remotePane.deviceName} projectId={remotePane.projectId} projectName={remotePane.projectName} initialShellIndex={remotePane.shellIndex} onClose={() => setRemotePane(null)} />
                : mainTab === 'settings'
                ? settingsTarget
                  ? <ProjectSettingsTab key={settingsTarget.id} target={settingsTarget} onSaved={applyDefaultAgentProject} assignmentVisible={!boardVisible}>
                      <ScrollIntoViewOnRequest request={envFocusRequest}>
                        <ProjectEnvTab
                          projectId={settingsTarget.id}
                          projectName={settingsTarget.name}
                          drafts={envDrafts}
                          onOpenAppEnv={() => {
                            setSettingsSection('env');
                            setSettingsOpen(true);
                          }}
                        />
                      </ScrollIntoViewOnRequest>
                    </ProjectSettingsTab>
                  : <section aria-label={PROJECT_SETTINGS_COPY.title} data-testid={PROJECT_SETTINGS_TESTIDS.view}
                      className="flex-1 min-h-0 min-w-0 overflow-auto p-4 text-base text-[--text-muted] sm:p-6">
                      {PROJECT_SETTINGS_COPY.noProject}
                    </section>
                : selected ? mainBody(selected) : <EmptyState />}
              </div>
              {boardVisible && selected && <BoardPanel key={selected.id} projectId={selected.id} name={selected.name}
                assignment={assignment.state} covered={overlayOpen} controls={boardControls} onReload={assignment.reload}
                onClose={returnToWorkspace} onSettings={() => openProjectSettings(selected)} />}
            </div>
          </main>
          {/* Status bar under the main sheet only (not the sidebar); it folds away (height) when hidden. */}
          <AnimatePresence initial={false}>
            {showStatusBar && (
              <m.div
                key="status-bar"
                // The bar hangs from the top of this height-animated slot and the column clips below,
                // so it slides in/out at the bottom while its upward popovers still overlap the sheet.
                className="relative z-10 shrink-0"
                initial={{ height: 0 }}
                animate={{ height: STATUS_BAR_HEIGHT }}
                exit={{ height: 0 }}
                transition={reduceMotion ? { duration: 0 } : { duration: STATUS_BAR_MS / 1000, ease: [0.23, 1, 0.32, 1] }}
              >
                <div className="absolute inset-x-0 top-0">
                  <StatusBar
                    project={remotePane ? null : selected}
                    aliveCount={aliveCount}
                    activeAgent={activeShellAgentLabel}
                    activeAgentState={activeShellAgentStateLabel}
                    onOpenPalette={() => openPalette('')}
                    keepAwake={keepAwake}
                  />
                </div>
              </m.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {unloadTarget && <UnloadSessionDialog key={unloadTarget.id} project={unloadTarget}
        visible={!boardVisible && isPrimaryVisible(unloadTarget.id, { selectedProjectId: selected?.id ?? null, mainTab, activeShellIndex, rightShellIndex })}
        onClose={closeUnloadSession}
        onStopped={() => { toast('Session unloaded', { kind: 'success' }); }}
      />}
      {keepAwakeUntilOpen && keepAwake && (
        <KeepAwakeUntilDialog onStart={(endsAt) => { void keepAwake.startUntil(endsAt); }} onClose={() => setKeepAwakeUntilOpen(false)} />
      )}
      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        section={settingsSection}
        onSection={setSettingsSection}
        envDrafts={envDrafts}
      />
      <NewProjectDialog
        open={newProjectOpen}
        roots={roots}
        defaultRootId={selected ? roots.find((r) => r.id === selected.rootId)?.id ?? null : null}
        onClose={() => setNewProjectOpen(false)}
        onCreated={(project) => { setNewProjectOpen(false); void pick(project); toast(`Created ${project.name}`, { kind: 'success' }); }}
      />
      <CommandPalette
        request={paletteRequest}
        commands={commands}
        currentProject={selected}
        onPickProject={(p) => { void pick(p); }}
        onPickCurrent={(p) => { if (mainTabRef.current === 'shell') focusAfterPaletteRef.current = p.id; }}
        onPickFile={(relPath) => { setMainTab('files'); setOpenInFiles({ relPath, line: null }); }}
        onClose={() => setPaletteRequest(null)}
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
          closeBoard();
          const requestId = ++selectionRequestRef.current;
          setRemotePane(null);
          terminalFocus.cancelRequest();
          try {
            const cur = selectedRef.current;
            if (!cur || cur.id !== projectId) {
              const { project } = await api.invoke('projects:open', { id: projectId });
              if (selectionRequestRef.current !== requestId) return;
              setProjectSettingsTarget(null);
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
  useFrostedGlassAttributes();
  useExternalDragGuard();
  const shellAgentState = useShellAgentState(projectId, shellIndex);
  const [tab, setTab] = useState<'shell' | 'files'>('shell');
  const [openInFiles, setOpenInFiles] = useState<{ relPath: string; line: number | null } | null>(null);
  const [projectName, setProjectName] = useState<string>('');
  const [fullscreen, toggleFullscreen] = useWindowFullscreen();
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
  const popoutSheetContent: SheetContent = tab === 'shell' ? 'shell' : 'other';
  return (
    <div className="h-screen w-screen flex flex-col bg-[--surface-chrome]" data-chrome-root>
      <div className="drag h-11 flex items-center gap-2 pl-[76px] pr-3 shrink-0 min-w-0">
        {/* Prominent project name — the whole reason a user pops shells out
            is to run several projects side by side, so the label needs to
            read at a glance even in a narrow window. Trailing subtitle is
            shortened + hidden first when space runs out. */}
        <StatusDot agent={shellAgentState.agent} state={shellAgentState.state} className="shrink-0" />
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
      <div className="flex-1 min-h-0 bg-[--surface-sheet] rounded-xl mx-2 mb-2" data-sheet-content={popoutSheetContent}>
        {tab === 'shell' ? (
          <ShellTab
            projectId={projectId}
            shellIndex={shellIndex}
            primary
            popout
            onOpenFile={(relPath, line, targetProjectId) => {
              if (targetProjectId !== undefined && targetProjectId !== projectId) return;
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
            isFullscreen={fullscreen}
            onFullscreenToggle={toggleFullscreen}
          />
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  const { roots } = useRoots();
  const platform = useShortcutPlatform();
  // Onboarding: fresh install has no roots yet, so the sidebar shows no
  // projects and the main pane is blank — new users have nothing to click.
  // Surface a welcome card that walks them through the very first action.
  if (roots.length === 0) return <WelcomeOnboarding />;
  return (
    <div className="h-full flex items-center justify-center p-8 text-center">
      <div className="max-w-sm space-y-2">
        <div className="text-sm text-[--text-muted]">No project selected</div>
        <div className="text-xs text-[--text-muted] opacity-70">
          Pick one from the sidebar, or press <kbd className="px-1 py-0.5 rounded bg-[--panel] border border-[--border] text-[10px]">{SHORTCUT_COPY.emptyPaletteKey(platform)}</kbd> to search.
        </div>
      </div>
    </div>
  );
}

function WelcomeOnboarding() {
  const { refresh } = useRoots();
  const platform = useShortcutPlatform();
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
          Tip: press <kbd className="px-1 py-0.5 rounded bg-[--panel] border border-[--border] text-[10px]">{SHORTCUT_COPY.emptySettingsKey(platform)}</kbd> to open settings and change the default CLI or theme.
        </div>
      </div>
    </div>
  );
}

function PromptsIcon() {
  // Lightbulb — reads as "snippets / ideas to paste".
  return (
    <svg width={ICON_SIZE.md} height={ICON_SIZE.md} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18h6" />
      <path d="M10 22h4" />
      <path d="M12 2a7 7 0 0 0-4 12.7c.7.5 1 1.3 1 2.1V18h6v-1.2c0-.8.3-1.6 1-2.1A7 7 0 0 0 12 2z" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width={ICON_SIZE.md} height={ICON_SIZE.md} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  );
}

function RevealFolderIcon() {
  return (
    <svg width={ICON_SIZE.md} height={ICON_SIZE.md} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function PopoutIcon() {
  return (
    <svg width={ICON_SIZE.md} height={ICON_SIZE.md} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3h6v6" />
      <path d="M10 14L21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

function BoardIcon() {
  return (
    <svg width={ICON_SIZE.md} height={ICON_SIZE.md} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
    <svg width={ICON_SIZE.lg} height={ICON_SIZE.lg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3"  y="3" width="4.5" height="18" rx="1" />
      <rect x="9.75"  y="3" width="4.5" height="18" rx="1" />
      <rect x="16.5" y="3" width="4.5" height="18" rx="1" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width={ICON_SIZE.lg} height={ICON_SIZE.lg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

function ThemeIcon({ mode, effective }: { mode: ThemeMode; effective: 'light' | 'dark' }) {
  // system → half moon over sun (auto), light → sun, dark → moon
  if (mode === 'system') {
    return (
      <svg width={ICON_SIZE.lg} height={ICON_SIZE.lg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" opacity={effective === 'dark' ? 0.4 : 1} />
        <path d="M12 8a4 4 0 0 0 0 8" fill="currentColor" opacity={effective === 'dark' ? 1 : 0} />
      </svg>
    );
  }
  if (mode === 'light') {
    return (
      <svg width={ICON_SIZE.lg} height={ICON_SIZE.lg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  return (
    <svg width={ICON_SIZE.lg} height={ICON_SIZE.lg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

/** Scrolls its content into view whenever `request` changes to a non-zero value (and on mount if already non-zero). */
function ScrollIntoViewOnRequest({ request, children }: { request: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (request > 0) ref.current?.scrollIntoView({ block: 'start' });
  }, [request]);
  return <div ref={ref} className="scroll-mt-4">{children}</div>;
}
