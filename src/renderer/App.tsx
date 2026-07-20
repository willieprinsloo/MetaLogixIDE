import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { ProjectSwitcher } from './components/ProjectSwitcher';
import { StatusBar } from './components/StatusBar';
import { ShellTab } from './components/ShellTab';
import { FilesTab } from './components/FilesTab';
import { ChatTab } from './components/ChatTab';
import { Settings } from './components/Settings';
import { ResizeHandle } from './components/ResizeHandle';
import { FileFinder } from './components/FileFinder';
import { NewProjectDialog } from './components/NewProjectDialog';
import { ActivityBar, type ActivityView } from './components/ActivityBar';
import { CommandPalette, type Command } from './components/CommandPalette';
import { ProjectSearch } from './components/ProjectSearch';
import { ToastStack } from './components/ToastStack';
import { toast } from './hooks/useToasts';
import { useRoots } from './hooks/useRoots';
import type { Project } from '@shared/types';
import { api } from './api';
import { useTheme, type ThemeMode } from './hooks/useTheme';
import { usePersistedNumber } from './hooks/usePersistedNumber';
import { usePersistedState } from './hooks/usePersistedState';
import { usePoppedShells } from './hooks/usePoppedShells';
import { useProjectShells } from './hooks/useProjectShells';
import { Tooltip } from './components/Tooltip';

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

function readPopout(): PopoutInfo | null {
  const q = new URLSearchParams(window.location.search);
  if (q.get('popout') !== '1') return null;
  const projectId = Number(q.get('projectId'));
  const shellIndex = Number(q.get('shellIndex') ?? '0');
  if (!Number.isFinite(projectId) || projectId <= 0) return null;
  return { projectId, shellIndex };
}

export function App() {
  const popout = useMemo(readPopout, []);
  if (popout) return <PopoutShell {...popout} />;
  return <MainApp />;
}

function MainApp() {
  const [selected, setSelected] = useState<Project | null>(null);
  // Keep a live ref of `selected` so the shortcut handler (bound once in a
  // useEffect with an empty dep list) always reads the current project.
  const selectedRef = useRef<Project | null>(null);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [aliveCount, setAliveCount] = useState(0);
  const [mainTab, setMainTab] = usePersistedState<'shell' | 'files'>(
    'metaide.mainTab',
    'shell',
    (v): v is 'shell' | 'files' => v === 'shell' || v === 'files',
  );
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
    (v): v is ActivityView => v === 'projects' || v === 'chat' || v === 'settings',
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
  const splitRatio = projectState?.splitRatio ?? 0.5;
  const patchProjectState = useCallback((patch: Partial<ProjectUiState>) => {
    if (!projectKey) return;
    setProjectStates((prev) => ({
      ...prev,
      [projectKey]: { activeShellIndex: 0, rightShellIndex: null, splitRatio: 0.5, ...prev[projectKey], ...patch },
    }));
  }, [projectKey, setProjectStates]);
  const setActiveShellIndex = useCallback((idx: number) => patchProjectState({ activeShellIndex: idx }), [patchProjectState]);
  const setRightShellIndex = useCallback((idx: number | null) => patchProjectState({ rightShellIndex: idx }), [patchProjectState]);
  const setSplitRatio = useCallback((r: number) => patchProjectState({ splitRatio: r }), [patchProjectState]);
  const allProjectShells = useProjectShells(selected?.id ?? null);
  const [sidebarOpen, setSidebarOpen] = usePersistedState<boolean>(
    'metaide.sidebarOpen',
    true,
    (v): v is boolean => typeof v === 'boolean',
  );
  const [sidebarWidth, setSidebarWidth] = usePersistedNumber('metaide.sidebarWidth', 288, 200, 560);
  // Chat panel gets its own persisted width so the wider chat view doesn't
  // resize the projects list back to a tiny column when the user flips modes.
  const [chatPanelWidth, setChatPanelWidth] = usePersistedNumber('metaide.chatPanelWidth', 400, 300, 640);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [finderOpen, setFinderOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [openInFiles, setOpenInFiles] = useState<{ relPath: string; line: number | null } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const { mode: themeMode, effective: effectiveTheme, cycle: cycleTheme, setMode: setThemeMode } = useTheme();
  const { roots } = useRoots();
  const { isPopped } = usePoppedShells();
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
    { id: 'view.sidebar',    category: 'View',     title: sidebarOpen ? 'Hide sidebar' : 'Show sidebar', hint: '⌘B', run: () => setSidebarOpen((v) => !v) },
    { id: 'view.shell',      category: 'View',     title: 'Switch to Shell tab',                           run: () => setMainTab('shell') },
    { id: 'view.files',      category: 'View',     title: 'Switch to Files tab',                           run: () => setMainTab('files') },
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
    { id: 'app.settings',    category: 'App',      title: 'Open Settings',                    hint: '⌘,',  run: () => setSettingsOpen(true) },
  ], [selected, sidebarOpen, setThemeMode]);

  const refreshAlive = useCallback(async () => {
    const { shells } = await api.invoke('shells:alive-list', undefined as never);
    setAliveCount(shells.length);
  }, []);

  useEffect(() => { void refreshAlive(); }, [refreshAlive]);
  useEffect(() => {
    const off = api.on('alive-shells:changed', () => { void refreshAlive(); });
    return () => { off(); };
  }, [refreshAlive]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'k')                          { e.preventDefault(); setSwitcherOpen(true); }
      if (mod && e.key === '\\')                         { e.preventDefault(); setSidebarOpen((v) => !v); }
      if (mod && e.key === 'b' && !e.shiftKey && !e.altKey) { e.preventDefault(); setSidebarOpen((v) => !v); }
      if (mod && e.key === ',')                          { e.preventDefault(); setSettingsOpen(true); }
      if (mod && e.key === 'p' && !e.shiftKey)           { e.preventDefault(); setFinderOpen(true); }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); setNewProjectOpen(true); }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); setPaletteOpen(true); }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setSearchOpen(true); }
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
      if (e.key === 'Escape')                            { setSettingsOpen(false); setFinderOpen(false); setNewProjectOpen(false); setPaletteOpen(false); setHelpOpen(false); setSearchOpen(false); }
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

  async function pick(p: Project) {
    const { project } = await api.invoke('projects:open', { id: p.id });
    setSelected(project);
    try {
      await api.invoke('shells:launch', { projectId: project.id });
    } catch (e) {
      toast('Failed to launch shell', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
      console.error(e);
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
      setSplitRatio(0.5);
    } catch (e) {
      toast('Failed to open split', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    }
  }

  /** Close the split. Kills the right pane's shell (it was auto-spawned for the split). */
  async function closeSplit() {
    if (!selected || rightShellIndex == null) return;
    const idx = rightShellIndex;
    setRightShellIndex(null);
    try { await api.invoke('shells:kill', { projectId: selected.id, shellIndex: idx }); }
    catch { /* fine — the shell may already be gone */ }
  }

  async function unloadCurrent() {
    if (!selected) return;
    try {
      await api.invoke('shells:kill', { projectId: selected.id, shellIndex: 0 });
      toast('Session unloaded', { kind: 'success' });
    } catch (e) { console.error(e); }
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-transparent">
      {/* Native-feeling drag region for hidden-inset title bar */}
      <div className="drag h-9 flex items-center pl-[76px] pr-2 shrink-0 bg-[--panel]/70 backdrop-blur-xl border-b border-[--border]">
        <span className="text-xs opacity-70 ml-1 font-medium">MetaLogix IDE</span>
        {selected && (
          <span className="text-[11px] text-[--text-muted] ml-3 truncate max-w-[360px]" title={selected.path}>
            <span className="opacity-60">▸ </span>{selected.name}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1 no-drag">
          <button
            onClick={cycleTheme}
            className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel-strong]"
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
            className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel-strong]"
            title="Tile all our windows on the screen"
            data-testid="tile-windows"
          >
            <TileIcon />
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel-strong]"
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
            if (v === 'settings') { setSettingsOpen(true); return; }
            if (v === 'chat' || v === 'projects') {
              setActiveView(v);
              if (!sidebarOpen) setSidebarOpen(true);
              return;
            }
            setActiveView(v);
          }}
          onToggleSidebar={() => setSidebarOpen((s) => !s)}
          sidebarOpen={sidebarOpen}
          chatUnread={chatUnread}
        />
        {sidebarOpen && (
          <>
            {activeView === 'chat' ? (
              <div
                className="h-full bg-[--panel] border-r border-[--border] flex flex-col backdrop-blur-md shrink-0"
                style={{ width: chatPanelWidth }}
              >
                <ChatTab
                  projectId={selected?.id ?? 0}
                  metaprojectProjectId={selected ? (selected.config.linkedMetaprojectProjectId ?? selected.metaprojectProjectId ?? null) : null}
                  compact
                />
              </div>
            ) : (
              <Sidebar
                selectedProjectId={selected?.id ?? null}
                onSelect={pick}
                onNewProject={() => setNewProjectOpen(true)}
                width={sidebarWidth}
              />
            )}
            <ResizeHandle
              value={activeView === 'chat' ? chatPanelWidth : sidebarWidth}
              onChange={activeView === 'chat' ? setChatPanelWidth : setSidebarWidth}
              onReset={() => activeView === 'chat' ? setChatPanelWidth(400) : setSidebarWidth(288)}
              min={activeView === 'chat' ? 300 : 200}
              max={activeView === 'chat' ? 640 : 560}
              side="left"
            />
          </>
        )}
        <main className="flex-1 flex flex-col min-h-0 bg-[--panel-strong]/40">
          <div className="flex items-stretch border-b border-[--border] text-xs shrink-0 bg-[--panel]/60">
            <TabButton active={mainTab === 'shell'} onClick={() => setMainTab('shell')}>Shell</TabButton>
            <TabButton active={mainTab === 'files'} onClick={() => setMainTab('files')}>Files</TabButton>
            <div className="ml-auto flex items-center gap-1.5 pr-2">
              {selected && (
                <>
                  <span className="flex items-center gap-1.5 text-[--text] pl-2 pr-1 py-0.5 rounded-md bg-[--panel-strong] border border-[--border] text-[11px] max-w-[280px]" title={selected.path}>
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 live-dot" />
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
                  <MetaprojectBoardButton project={selected} />
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
                shells={projectShells}
                active={activeShellIndex}
                onSelect={setActiveShellIndex}
                onClose={killShell}
                onLaunchProfile={(name) => void launchCliProfile(name, 'tab')}
                onLaunchPlainTab={newPlainShellAsTab}
                onLaunchCustom={(name, cmdLine, save) => void launchCustomCli(name, cmdLine, save, 'tab')}
                splitOn={rightShellIndex != null}
                onToggleSplit={() => (rightShellIndex != null ? void closeSplit() : void openSplit())}
              />
            )}
            {selected ? (
              mainTab === 'shell'
                ? (rightShellIndex != null
                    ? <ShellSplit
                        projectId={selected.id}
                        projectName={selected.name}
                        leftIndex={activeShellIndex}
                        rightIndex={rightShellIndex}
                        ratio={splitRatio}
                        onRatioChange={setSplitRatio}
                        isPoppedLeft={isPopped(selected.id, activeShellIndex)}
                        isPoppedRight={isPopped(selected.id, rightShellIndex)}
                        onCloseSplit={closeSplit}
                        onOpenFile={(relPath, line) => {
                          setMainTab('files');
                          setOpenInFiles({ relPath, line });
                        }}
                      />
                    : (isPopped(selected.id, activeShellIndex)
                        ? <PoppedPlaceholder projectId={selected.id} shellIndex={activeShellIndex} name={selected.name} />
                        : <ShellTab
                            key={`${selected.id}:${activeShellIndex}`}
                            projectId={selected.id}
                            shellIndex={activeShellIndex}
                            onOpenFile={(relPath, line) => {
                              setMainTab('files');
                              setOpenInFiles({ relPath, line });
                            }}
                          />))
                : <FilesTab
                    projectId={selected.id}
                    openRelPath={openInFiles?.relPath ?? null}
                    openLine={openInFiles?.line ?? null}
                    onOpenRelPathConsumed={() => setOpenInFiles(null)}
                  />
            ) : <EmptyState />}
          </div>
        </main>
      </div>

      <StatusBar project={selected} aliveCount={aliveCount} />
      <ProjectSwitcher open={switcherOpen} onClose={() => setSwitcherOpen(false)} onPick={pick} />
      <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
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
    </div>
  );
}

function PopoutShell({ projectId, shellIndex }: PopoutInfo) {
  const [tab, setTab] = useState<'shell' | 'files'>('shell');
  const [openInFiles, setOpenInFiles] = useState<{ relPath: string; line: number | null } | null>(null);
  const [projectName, setProjectName] = useState<string>('');
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
    <div className="h-screen w-screen flex flex-col bg-transparent">
      <div className="drag h-9 flex items-center gap-2 pl-[76px] pr-3 shrink-0 bg-[--panel]/70 backdrop-blur-xl border-b border-[--border] min-w-0">
        {/* Prominent project name — the whole reason a user pops shells out
            is to run several projects side by side, so the label needs to
            read at a glance even in a narrow window. Trailing subtitle is
            shortened + hidden first when space runs out. */}
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 live-dot shrink-0" aria-hidden />
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
      <div className="flex items-stretch border-b border-[--border] text-xs shrink-0 bg-[--panel]/60">
        <button
          onClick={() => setTab('shell')}
          className={`px-3 py-1.5 border-b-2 transition ${tab === 'shell' ? 'border-[--accent] text-[--text]' : 'border-transparent text-[--text-muted] hover:text-[--text]'}`}
        >Shell</button>
        <button
          onClick={() => setTab('files')}
          className={`px-3 py-1.5 border-b-2 transition ${tab === 'files' ? 'border-[--accent] text-[--text]' : 'border-transparent text-[--text-muted] hover:text-[--text]'}`}
        >Files</button>
      </div>
      <div className="flex-1 min-h-0 bg-[--panel-strong]/40">
        {tab === 'shell' ? (
          <ShellTab
            projectId={projectId}
            shellIndex={shellIndex}
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

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 border-b-2 transition ${
        active
          ? 'border-[--accent] text-[--text]'
          : 'border-transparent text-[--text-muted] hover:text-[--text]'
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
  { title: 'Shell',    items: [['⌘F', 'Find in terminal'], ['⌘=', 'Zoom in'], ['⌘-', 'Zoom out'], ['⌘0', 'Reset zoom']] },
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

interface CliProfileEntry {
  name: string;
  argv: string[];
  env?: Record<string, string>;
  icon?: string;
  scope: 'project' | 'global';
}

function NewShellMenu({
  projectId,
  onLaunchProfile,
  onLaunchPlainTab,
  onLaunchCustom,
  onClose,
}: {
  projectId: number;
  onLaunchProfile: (name: string) => void;
  onLaunchPlainTab: () => void;
  onLaunchCustom: (name: string, cmdLine: string, save: boolean) => void;
  onClose: () => void;
}) {
  const [profiles, setProfiles] = useState<CliProfileEntry[]>([]);
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customCmd, setCustomCmd] = useState('');
  const [customSave, setCustomSave] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const { profiles } = await api.invoke('shells:cli-profiles-list', { projectId });
        setProfiles(profiles);
      } catch { /* ignore */ }
    })();
  }, [projectId]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (t && t.closest('[data-new-shell-menu="1"]')) return;
      onClose();
    }
    function onEsc(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [onClose]);

  async function removeProfile(name: string) {
    try {
      await api.invoke('shells:cli-profiles-remove', { projectId, name });
      setProfiles(prev => prev.filter(p => p.name !== name));
    } catch { /* ignore */ }
  }

  if (customOpen) {
    return (
      <div
        data-new-shell-menu="1"
        className="absolute top-full right-0 mt-1 z-40 w-80 rounded-md border border-[--border] bg-[--panel-strong] shadow-xl overflow-hidden p-3 space-y-2 text-xs"
      >
        <div className="font-semibold text-sm">Run a custom command</div>
        <input
          value={customName}
          onChange={(e) => setCustomName(e.target.value)}
          placeholder="Name (optional, e.g. Llama)"
          className="w-full bg-[--panel] border border-[--border] rounded px-2 py-1 outline-none focus:ring-1 focus:ring-[--accent]/60"
          autoFocus
        />
        <input
          value={customCmd}
          onChange={(e) => setCustomCmd(e.target.value)}
          placeholder='Command, e.g. `llama chat --model llama3`'
          className="w-full bg-[--panel] border border-[--border] rounded px-2 py-1 font-mono outline-none focus:ring-1 focus:ring-[--accent]/60"
        />
        <label className="flex items-center gap-2 text-[--text-muted]">
          <input type="checkbox" checked={customSave} onChange={(e) => setCustomSave(e.target.checked)} className="accent-[color:var(--accent)]" />
          <span>Save to this project&apos;s CLI list</span>
        </label>
        <div className="flex gap-2">
          <button
            className="flex-1 px-2 py-1.5 rounded bg-[color:var(--accent)] text-white hover:brightness-110 disabled:opacity-40"
            disabled={!customCmd.trim()}
            onClick={() => onLaunchCustom(customName.trim(), customCmd.trim(), customSave && !!customName.trim())}
          >
            Run
          </button>
          <button className="px-3 py-1.5 rounded border border-[--border] hover:bg-[--panel] text-[--text-muted]" onClick={() => setCustomOpen(false)}>Back</button>
        </div>
        <div className="text-[10px] text-[--text-muted]">
          Adds this as a new tab. To move it to a separate window afterwards, click the popout icon in the top bar.
        </div>
      </div>
    );
  }

  return (
    <div
      data-new-shell-menu="1"
      className="absolute top-full right-0 mt-1 z-40 w-72 rounded-md border border-[--border] bg-[--panel-strong] shadow-xl overflow-hidden"
    >
      <div className="px-3 py-2 border-b border-[--border]">
        <div className="text-[10px] uppercase tracking-wider text-[--text-muted] font-semibold">
          Add a shell
        </div>
        <div className="text-[10px] text-[--text-muted] mt-0.5">
          Opens as a new tab. Use the popout icon to move it to its own window.
        </div>
      </div>
      {profiles.length === 0 && (
        <div className="px-3 py-4 text-xs text-[--text-muted] text-center">
          No CLIs configured yet. Add one below.
        </div>
      )}
      {profiles.map((p) => (
        <div key={p.name} className="group flex items-stretch hover:bg-[--panel]">
          <button
            className="flex-1 text-left px-3 py-2 text-xs flex items-center gap-2"
            onClick={() => onLaunchProfile(p.name)}
            title={p.argv.join(' ')}
          >
            <span className="w-5 text-center text-base leading-none">{p.icon ?? '▸'}</span>
            <span className="flex-1 truncate font-medium">{p.name}</span>
            {p.scope === 'project' && <span className="text-[9px] uppercase text-[--text-muted] px-1 py-0.5 rounded bg-[--panel] border border-[--border]">saved</span>}
          </button>
          {p.scope === 'project' && (
            <button
              className="px-2 opacity-0 group-hover:opacity-60 hover:opacity-100 hover:text-[--danger] flex items-center"
              onClick={() => removeProfile(p.name)}
              title="Remove from this project"
            >
              <XIcon />
            </button>
          )}
        </div>
      ))}
      <div className="border-t border-[--border]">
        <button
          onClick={() => setCustomOpen(true)}
          className="w-full text-left px-3 py-2 text-xs hover:bg-[--panel] flex items-center gap-2 text-[--text-muted] hover:text-[--text]"
        >
          <span className="w-5 text-center text-base leading-none">＋</span>
          <span>Add a custom command…</span>
        </button>
      </div>
      <div className="border-t border-[--border]">
        <button
          onClick={onLaunchPlainTab}
          className="w-full text-left px-3 py-2 text-xs hover:bg-[--panel] flex items-center justify-between"
          title="Opens your login shell ($SHELL) at the project's directory"
        >
          <span className="flex items-center gap-2">
            <span className="w-5 text-center text-base leading-none">⌨️</span>
            <span>Terminal</span>
          </span>
          <span className="opacity-60 font-mono">⌘T</span>
        </button>
      </div>
    </div>
  );
}

interface ShellTabsBarItem {
  projectId: number;
  shellIndex: number;
  pinned: boolean;
  startedAt: string | null;
  lastActiveAt: string | null;
  launchName: string;
}

function ShellTabsBar({
  projectId, shells, active, onSelect, onClose,
  onLaunchProfile, onLaunchPlainTab, onLaunchCustom,
  splitOn, onToggleSplit,
}: {
  projectId: number;
  shells: ShellTabsBarItem[];
  active: number;
  onSelect: (idx: number) => void;
  onClose: (idx: number) => void;
  onLaunchProfile: (name: string) => void;
  onLaunchPlainTab: () => void;
  onLaunchCustom: (name: string, cmdLine: string, save: boolean) => void;
  /** True when the split view is active — the toggle icon reflects it. */
  splitOn: boolean;
  onToggleSplit: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="flex items-center gap-1 px-2 py-1 border-b border-[--border] bg-[--panel]/40 text-xs shrink-0 overflow-visible">
      <div className="flex items-center gap-1 flex-1 overflow-x-auto">
        {shells.map((s) => {
          // Show the name of the running CLI (e.g. "Claude", "Llama", "Terminal").
          // When the same CLI runs twice, disambiguate with a #N suffix.
          const dupes = shells.filter(x => x.launchName === s.launchName);
          const suffix = dupes.length > 1 ? ` ${dupes.indexOf(s) + 1}` : '';
          const label = `${s.launchName}${suffix}`;
          const isActive = s.shellIndex === active;
          return (
            <div
              key={s.shellIndex}
              className={`group flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md cursor-pointer whitespace-nowrap
                ${isActive ? 'bg-[--panel-strong] border border-[--border]' : 'hover:bg-[--panel-strong]/60 border border-transparent'}`}
              onClick={() => onSelect(s.shellIndex)}
            >
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${isActive ? 'bg-green-500 live-dot' : 'bg-[--text-muted]'}`} />
              <span className={`${isActive ? 'text-[--text] font-medium' : 'text-[--text-muted]'}`}>{label}</span>
              {s.shellIndex !== 0 && (
                <button
                  onClick={(e) => { e.stopPropagation(); onClose(s.shellIndex); }}
                  className="ml-0.5 opacity-0 group-hover:opacity-70 hover:opacity-100 hover:text-[--danger] w-4 h-4 flex items-center justify-center rounded"
                  title={`Close ${label}`}
                >
                  <XIcon />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {/* Split-view toggle. Opens a right pane with an auto-spawned plain
          shell, so the user can watch Claude on the left and run one-off
          commands on the right without leaving the main window. */}
      <Tooltip label={splitOn ? 'Close split' : 'Split shell right'}>
        <button
          onClick={onToggleSplit}
          className={`shrink-0 w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel-strong] ${splitOn ? 'text-[color:var(--accent)]' : 'text-[--text-muted] hover:text-[--text]'}`}
          data-testid="tabbar-split"
        >
          <SplitIcon />
        </button>
      </Tooltip>
      {/* Add button lives at the RIGHT END of the tab strip. Click opens a
          menu of CLIs; the selected one is added as another tab. To put it
          in its own window instead, use the popout icon in the top toolbar
          (it moves the currently-active tab out). */}
      <div className="relative shrink-0">
        <Tooltip label="Add a shell" shortcut="⌘T">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel-strong]"
            data-testid="tabbar-new-shell"
          >
            <PlusIcon />
          </button>
        </Tooltip>
        {menuOpen && (
          <NewShellMenu
            projectId={projectId}
            onLaunchProfile={(name) => { setMenuOpen(false); onLaunchProfile(name); }}
            onLaunchPlainTab={() => { setMenuOpen(false); onLaunchPlainTab(); }}
            onLaunchCustom={(name, cmdLine, save) => {
              setMenuOpen(false);
              onLaunchCustom(name, cmdLine, save);
            }}
            onClose={() => setMenuOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

function ShellSplit({
  projectId, projectName,
  leftIndex, rightIndex,
  ratio, onRatioChange,
  isPoppedLeft, isPoppedRight,
  onCloseSplit, onOpenFile,
}: {
  projectId: number;
  projectName: string;
  leftIndex: number;
  rightIndex: number;
  ratio: number;                       // 0..1, share of horizontal space for LEFT
  onRatioChange: (r: number) => void;
  isPoppedLeft: boolean;
  isPoppedRight: boolean;
  onCloseSplit: () => void;
  onOpenFile: (relPath: string, line: number | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      const el = wrapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const r = (e.clientX - rect.left) / rect.width;
      // Clamp so neither pane collapses.
      onRatioChange(Math.max(0.15, Math.min(0.85, r)));
    }
    function onUp() { setDragging(false); }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, onRatioChange]);

  const leftPercent = `${(ratio * 100).toFixed(2)}%`;
  return (
    <div ref={wrapRef} className="h-full w-full flex min-h-0">
      <div className="min-h-0 min-w-0 relative" style={{ width: leftPercent }}>
        {isPoppedLeft
          ? <PoppedPlaceholder projectId={projectId} shellIndex={leftIndex} name={projectName} />
          : <ShellTab
              key={`${projectId}:${leftIndex}:left`}
              projectId={projectId}
              shellIndex={leftIndex}
              onOpenFile={onOpenFile}
            />
        }
      </div>
      {/* Draggable divider — 4 px hit target, 1 px visible line. */}
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={() => setDragging(true)}
        className={`shrink-0 w-1 cursor-col-resize bg-transparent hover:bg-[color:var(--accent)]/40 border-l border-[--border] ${dragging ? 'bg-[color:var(--accent)]/60' : ''}`}
      />
      <div className="flex-1 min-h-0 min-w-0 relative">
        <button
          onClick={onCloseSplit}
          title="Close split (returns to single shell view)"
          className="absolute top-1 right-1 z-10 w-6 h-6 flex items-center justify-center rounded-md text-[--text-muted] hover:text-[--danger] hover:bg-[--panel-strong]"
        >
          <XIcon />
        </button>
        {isPoppedRight
          ? <PoppedPlaceholder projectId={projectId} shellIndex={rightIndex} name={projectName} />
          : <ShellTab
              key={`${projectId}:${rightIndex}:right`}
              projectId={projectId}
              shellIndex={rightIndex}
              onOpenFile={onOpenFile}
            />
        }
      </div>
    </div>
  );
}

function PoppedPlaceholder({ projectId, shellIndex, name }: { projectId: number; shellIndex: number; name: string }) {
  return (
    <div className="h-full flex items-center justify-center p-8 text-center">
      <div className="max-w-md space-y-3">
        <div className="text-sm text-[--text-muted]">Shell is running in a separate window</div>
        <div className="text-lg font-semibold">{name}</div>
        <button
          onClick={async () => { await api.invoke('windows:return-shell', { projectId, shellIndex }); }}
          className="text-sm px-4 py-1.5 rounded-md bg-[color:var(--accent)] text-white hover:brightness-110"
          data-testid="return-popout"
        >
          Bring back to this window
        </button>
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
            className="bg-[color:var(--accent)] text-white text-sm font-medium px-4 py-2 rounded-md hover:brightness-110 shadow-sm"
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

function XIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function SplitIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="12" y1="4" x2="12" y2="20" />
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

function MetaprojectBoardButton({ project }: { project: Project }) {
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const { value } = await api.invoke('settings:get', { key: 'metaproject_base_url' });
        setBaseUrl(typeof value === 'string' ? value : null);
      } catch { setBaseUrl(null); }
    })();
  }, []);
  const linked = project.config.linkedMetaprojectProjectId ?? project.metaprojectProjectId;
  if (!linked) return null;
  const disabled = !baseUrl;
  const url = baseUrl ? `${baseUrl.replace(/\/$/, '')}/board/${encodeURIComponent(linked)}` : '';
  return (
    <button
      onClick={() => {
        if (disabled) {
          toast('Set the Metaproject base URL in Settings', { kind: 'warning' });
          return;
        }
        void api.invoke('app:open-external', { url });
      }}
      className={`text-[11px] px-2 py-0.5 rounded-md border border-[--border] flex items-center gap-1 ${
        disabled ? 'text-[--text-muted]' : 'hover:bg-[--panel-strong] text-[--text]'
      }`}
      title={disabled ? 'Metaproject base URL not configured' : `Open ${linked} on the metaproject board`}
      data-testid="metaproject-board"
    >
      <BoardIcon />
      <span>Board</span>
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
