import { useCallback, useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { ProjectSwitcher } from './components/ProjectSwitcher';
import { StatusBar } from './components/StatusBar';
import { ShellTab } from './components/ShellTab';
import { AliveShellsPanel } from './components/AliveShellsPanel';
import type { Project } from '@shared/types';
import { api } from './api';

export function App() {
  const [selected, setSelected] = useState<Project | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [alivePanelOpen, setAlivePanelOpen] = useState(false);
  const [aliveCount, setAliveCount] = useState(0);

  const refreshAlive = useCallback(async () => {
    const { shells } = await api.invoke('shells:alive-list', undefined as never);
    setAliveCount(shells.length);
  }, []);

  useEffect(() => { void refreshAlive(); }, [refreshAlive]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setSwitcherOpen(true); }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') { e.preventDefault(); setAlivePanelOpen(v => !v); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function pick(p: Project) {
    const { project } = await api.invoke('projects:open', { id: p.id });
    setSelected(project);
    // Launch shell — Phase 1 UI is placeholder; ShellTab component in Task 15.
    try { await api.invoke('shells:launch', { projectId: project.id }); } catch (e) { console.error(e); }
    await refreshAlive();
  }

  return (
    <div className="h-screen flex flex-col">
      <div className="flex-1 flex">
        <Sidebar selectedProjectId={selected?.id ?? null} onSelect={pick} />
        <main className="flex-1 relative">
          {selected ? <ShellTab projectId={selected.id} shellIndex={0} /> : <div className="p-4 text-neutral-500">Select a project</div>}
        </main>
      </div>
      <StatusBar project={selected} aliveCount={aliveCount} />
      <ProjectSwitcher open={switcherOpen} onClose={() => setSwitcherOpen(false)} onPick={pick} />
      <AliveShellsPanel open={alivePanelOpen} onClose={() => setAlivePanelOpen(false)} />
    </div>
  );
}
