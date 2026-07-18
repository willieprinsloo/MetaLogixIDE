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
import { useRoots } from './hooks/useRoots';
import type { Project } from '@shared/types';
import { api } from './api';
import { useTheme, type ThemeMode } from './hooks/useTheme';
import { usePersistedNumber } from './hooks/usePersistedNumber';

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
  const { mode: themeMode, effective: effectiveTheme, cycle: cycleTheme } = useTheme();
  const { roots } = useRoots();
  const [activeView, setActiveView] = useState<ActivityView>('projects');

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
      if (e.key === 'Escape')                            { setSettingsOpen(false); setFinderOpen(false); setNewProjectOpen(false); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function pick(p: Project) {
    const { project } = await api.invoke('projects:open', { id: p.id });
    setSelected(project);
    try { await api.invoke('shells:launch', { projectId: project.id }); } catch (e) { console.error(e); }
  }

  async function popoutCurrent() {
    if (!selected) return;
    try { await api.invoke('windows:popout-shell', { projectId: selected.id, shellIndex: 0 }); }
    catch (e) { console.error(e); }
  }

  async function unloadCurrent() {
    if (!selected) return;
    try {
      await api.invoke('shells:kill', { projectId: selected.id, shellIndex: 0 });
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
            title={`Theme: ${themeMode}${themeMode === 'system' ? ` (following OS — currently ${effectiveTheme})` : ''}. Click to cycle.`}
            data-testid="theme-toggle"
            data-theme-mode={themeMode}
          >
            <ThemeIcon mode={themeMode} effective={effectiveTheme} />
          </button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        <ActivityBar
          active={activeView}
          onSelect={(v) => {
            setActiveView(v);
            if (v === 'alive') setAlivePanelOpen(true);
            if (v === 'settings') setSettingsOpen(true);
            if (v === 'projects' && !sidebarOpen) setSidebarOpen(true);
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
                ? <ShellTab projectId={selected.id} shellIndex={0} />
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
      <AliveShellsPanel open={alivePanelOpen} onClose={() => setAlivePanelOpen(false)} />
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
        onCreated={(project) => { setNewProjectOpen(false); void pick(project); }}
      />
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
