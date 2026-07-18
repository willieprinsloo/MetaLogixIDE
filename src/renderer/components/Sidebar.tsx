import { useMemo, useState } from 'react';
import { useRoots } from '@renderer/hooks/useRoots';
import { useProjects } from '@renderer/hooks/useProjects';
import type { Project, Root } from '@shared/types';
import { api } from '@renderer/api';

interface Props {
  selectedProjectId: number | null;
  onSelect: (p: Project) => void;
}

export function Sidebar({ selectedProjectId, onSelect }: Props) {
  const { roots, refresh: refreshRoots } = useRoots();
  const { projects, refresh: refreshProjects } = useProjects();
  const [filter, setFilter] = useState('');

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
    // Use OS-native folder picker via IPC event (not in Phase 1's minimal contract — prompt via window.prompt for MVP).
    const path = window.prompt('Root directory path (absolute):');
    if (!path) return;
    await api.invoke('roots:add', { path });
    await refreshRoots();
    await refreshProjects();
  }

  return (
    <aside className="w-72 h-full border-r border-neutral-800 flex flex-col">
      <div className="p-2 border-b border-neutral-800">
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter…"
          className="w-full bg-neutral-900 text-sm px-2 py-1 rounded"
        />
        <button onClick={addRoot} className="mt-2 w-full text-xs bg-blue-600 hover:bg-blue-500 rounded py-1">
          + Add root
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {roots.map(r => (
          <RootBlock key={r.id} root={r} projects={grouped.get(r.id) ?? []} selectedProjectId={selectedProjectId} onSelect={onSelect} />
        ))}
      </div>
    </aside>
  );
}

function RootBlock({ root, projects, selectedProjectId, onSelect }: { root: Root; projects: Project[]; selectedProjectId: number | null; onSelect: (p: Project) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="w-full text-left px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-900">
        {open ? '▾' : '▸'} {root.path} ({projects.length})
      </button>
      {open && projects.map(p => (
        <button
          key={p.id}
          onClick={() => onSelect(p)}
          className={`w-full text-left px-4 py-1 text-sm ${selectedProjectId === p.id ? 'bg-blue-700' : 'hover:bg-neutral-900'}`}
        >
          {p.name}
        </button>
      ))}
    </div>
  );
}
