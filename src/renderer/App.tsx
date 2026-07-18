import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { ProjectSwitcher } from './components/ProjectSwitcher';
import { StatusBar } from './components/StatusBar';
import { ShellTab } from './components/ShellTab';
import { FilesTab } from './components/FilesTab';
import { AliveShellsPanel } from './components/AliveShellsPanel';
import type { Project } from '@shared/types';
import { api } from './api';

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

  return (
    <div className="h-screen w-screen flex flex-col bg-transparent">
      {/* Native-feeling drag region for hidden-inset title bar */}
      <div className="drag h-10 flex items-center pl-[76px] pr-3 shrink-0 bg-[--panel]/70 backdrop-blur-xl border-b border-[--border]">
        <button
          onClick={() => setSidebarOpen((v) => !v)}
          className="no-drag text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel-strong]"
          title={sidebarOpen ? 'Hide sidebar (Cmd+B)' : 'Show sidebar (Cmd+B)'}
          data-testid="toggle-sidebar"
        >
          <SidebarIcon />
        </button>
        <span className="text-xs opacity-70 ml-2 font-medium">metaIDE</span>
        <div className="ml-auto flex items-center gap-1 no-drag">
          {selected && (
            <>
              <button
                onClick={popoutCurrent}
                className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel-strong]"
                title="Pop shell into its own window"
                data-testid="popout-shell"
              >
                <PopoutIcon />
              </button>
              <span className="text-xs text-[--text-muted] px-2 truncate max-w-[240px]">
                {selected.name}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {sidebarOpen && (
          <Sidebar selectedProjectId={selected?.id ?? null} onSelect={pick} />
        )}
        <main className="flex-1 flex flex-col min-h-0 bg-[--panel-strong]/40">
          <div className="flex border-b border-[--border] text-xs shrink-0 bg-[--panel]/60">
            <TabButton active={mainTab === 'shell'} onClick={() => setMainTab('shell')}>Shell</TabButton>
            <TabButton active={mainTab === 'files'} onClick={() => setMainTab('files')}>Files</TabButton>
          </div>
          <div className="flex-1 relative min-h-0">
            {selected ? (
              mainTab === 'shell'
                ? <ShellTab projectId={selected.id} shellIndex={0} />
                : <FilesTab projectId={selected.id} />
            ) : <EmptyState />}
          </div>
        </main>
      </div>

      <StatusBar project={selected} aliveCount={aliveCount} />
      <ProjectSwitcher open={switcherOpen} onClose={() => setSwitcherOpen(false)} onPick={pick} />
      <AliveShellsPanel open={alivePanelOpen} onClose={() => setAlivePanelOpen(false)} />
    </div>
  );
}

function PopoutShell({ projectId, shellIndex }: PopoutInfo) {
  return (
    <div className="h-screen w-screen flex flex-col bg-transparent">
      <div className="drag h-10 flex items-center pl-[76px] pr-3 shrink-0 bg-[--panel]/70 backdrop-blur-xl border-b border-[--border]">
        <span className="text-xs opacity-70 font-medium">metaIDE · shell</span>
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

function SidebarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
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
