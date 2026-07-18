import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { ProjectSwitcher } from './components/ProjectSwitcher';
import { StatusBar } from './components/StatusBar';
import { ShellTab } from './components/ShellTab';
import { FilesTab } from './components/FilesTab';
import { AliveShellsPanel } from './components/AliveShellsPanel';
import { Settings } from './components/Settings';
import { ResizeHandle } from './components/ResizeHandle';
import { FileFinder } from './components/FileFinder';
import { NewProjectDialog } from './components/NewProjectDialog';
import { ActivityBar, type ActivityView } from './components/ActivityBar';
import { CommandPalette, type Command } from './components/CommandPalette';
import { ToastStack } from './components/ToastStack';
import { toast } from './hooks/useToasts';
import { useRoots } from './hooks/useRoots';
import type { Project } from '@shared/types';
import { api } from './api';
import { useTheme, type ThemeMode } from './hooks/useTheme';
import { usePersistedNumber } from './hooks/usePersistedNumber';
import { usePoppedShells } from './hooks/usePoppedShells';

interface PopoutInfo {
  projectId: number;
  shellIndex: number;
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
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [alivePanelOpen, setAlivePanelOpen] = useState(false);
  const [aliveCount, setAliveCount] = useState(0);
  const [mainTab, setMainTab] = useState<'shell' | 'files'>('shell');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = usePersistedNumber('metaide.sidebarWidth', 288, 200, 560);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [finderOpen, setFinderOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [openInFiles, setOpenInFiles] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const { mode: themeMode, effective: effectiveTheme, cycle: cycleTheme, setMode: setThemeMode } = useTheme();
  const { roots } = useRoots();
  const { isPopped } = usePoppedShells();
  const [activeView, setActiveView] = useState<ActivityView>('projects');

  const commands = useMemo<Command[]>(() => [
    { id: 'nav.projects',    category: 'Go',       title: 'Open project switcher',           hint: '⌘K',   run: () => setSwitcherOpen(true) },
    { id: 'nav.find-file',   category: 'Go',       title: 'Find file in project',            hint: '⌘P',   run: () => setFinderOpen(true) },
    { id: 'nav.alive',       category: 'Go',       title: 'Show alive shells',               hint: '⌘⇧A',  run: () => setAlivePanelOpen(true) },
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
      if (mod && e.shiftKey && e.key.toLowerCase() === 'a') { e.preventDefault(); setAlivePanelOpen((v) => !v); }
      if (mod && e.key === '\\')                         { e.preventDefault(); setSidebarOpen((v) => !v); }
      if (mod && e.key === 'b' && !e.shiftKey && !e.altKey) { e.preventDefault(); setSidebarOpen((v) => !v); }
      if (mod && e.key === ',')                          { e.preventDefault(); setSettingsOpen(true); }
      if (mod && e.key === 'p' && !e.shiftKey)           { e.preventDefault(); setFinderOpen(true); }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); setNewProjectOpen(true); }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); setPaletteOpen(true); }
      if (mod && e.key === '/')                          { e.preventDefault(); setHelpOpen((v) => !v); }
      if (e.key === 'Escape')                            { setSettingsOpen(false); setFinderOpen(false); setNewProjectOpen(false); setPaletteOpen(false); setHelpOpen(false); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
      await api.invoke('windows:popout-shell', { projectId: selected.id, shellIndex: 0 });
      toast(`Popped out ${selected.name}`, { kind: 'info', detail: 'The shell now runs in its own window. Click "Bring back" to return it here.' });
    } catch (e) {
      toast('Failed to pop out shell', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
      console.error(e);
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
            if (v === 'alive') {
              // Toggle when already active — closing the panel returns to Projects.
              if (activeView === 'alive' && alivePanelOpen) { setAlivePanelOpen(false); setActiveView('projects'); return; }
              setActiveView('alive'); setAlivePanelOpen(true); return;
            }
            if (v === 'settings') { setSettingsOpen(true); return; } // don't latch activeView on settings
            if (v === 'projects') { setActiveView('projects'); if (!sidebarOpen) setSidebarOpen(true); return; }
            setActiveView(v);
          }}
          onToggleSidebar={() => setSidebarOpen((s) => !s)}
          sidebarOpen={sidebarOpen}
        />
        {sidebarOpen && (
          <>
            <Sidebar
              selectedProjectId={selected?.id ?? null}
              onSelect={pick}
              onNewProject={() => setNewProjectOpen(true)}
              width={sidebarWidth}
            />
            <ResizeHandle
              value={sidebarWidth}
              onChange={setSidebarWidth}
              onReset={() => setSidebarWidth(288)}
              min={200}
              max={560}
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
                  <button
                    onClick={popoutCurrent}
                    className="text-[--text-muted] hover:text-[--text] w-7 h-7 flex items-center justify-center rounded hover:bg-[--panel-strong]"
                    title="Pop shell into its own window"
                    data-testid="popout-shell"
                  >
                    <PopoutIcon />
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="flex-1 relative min-h-0">
            {selected ? (
              mainTab === 'shell'
                ? (isPopped(selected.id, 0)
                    ? <PoppedPlaceholder projectId={selected.id} shellIndex={0} name={selected.name} />
                    : <ShellTab projectId={selected.id} shellIndex={0} />)
                : <FilesTab
                    projectId={selected.id}
                    openRelPath={openInFiles}
                    onOpenRelPathConsumed={() => setOpenInFiles(null)}
                  />
            ) : <EmptyState />}
          </div>
        </main>
      </div>

      <StatusBar project={selected} aliveCount={aliveCount} />
      <ProjectSwitcher open={switcherOpen} onClose={() => setSwitcherOpen(false)} onPick={pick} />
      <AliveShellsPanel
        open={alivePanelOpen}
        onClose={() => { setAlivePanelOpen(false); if (activeView === 'alive') setActiveView('projects'); }}
      />
      <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <FileFinder
        open={finderOpen && selected != null}
        projectId={selected?.id ?? null}
        onClose={() => setFinderOpen(false)}
        onPick={(relPath) => {
          setMainTab('files');
          setOpenInFiles(relPath);
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
    </div>
  );
}

function PopoutShell({ projectId, shellIndex }: PopoutInfo) {
  return (
    <div className="h-screen w-screen flex flex-col bg-transparent">
      <div className="drag h-10 flex items-center pl-[76px] pr-3 shrink-0 bg-[--panel]/70 backdrop-blur-xl border-b border-[--border]">
        <span className="text-xs opacity-70 font-medium">MetaLogix IDE · shell</span>
      </div>
      <div className="flex-1 min-h-0 bg-[--panel-strong]/40">
        <ShellTab projectId={projectId} shellIndex={shellIndex} />
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
  { title: 'Go',       items: [['⌘K', 'Project switcher'], ['⌘P', 'Find file in project'], ['⌘⇧A', 'Alive shells']] },
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

function XIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
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
