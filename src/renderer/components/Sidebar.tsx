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
    const picked = await api.invoke('dialogs:pick-directory', undefined as never);
    const path = picked.path ?? window.prompt('Root directory path (absolute):');
    if (!path) return;
    await api.invoke('roots:add', { path });
    await refreshRoots();
    await refreshProjects();
  }

  return (
    <aside className="w-72 h-full border-r border-[--border] flex flex-col">
      <div className="p-2 border-b border-[--border]">
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter…"
          className="w-full bg-[--panel] text-sm px-2 py-1 rounded-md"
        />
        <button onClick={addRoot} className="mt-2 w-full text-xs bg-[--accent] hover:opacity-90 rounded-md py-1">
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
      <button onClick={() => setOpen(!open)} className="w-full text-left px-2 py-1 text-xs text-[--text-muted] hover:bg-[--panel]">
        {open ? '▾' : '▸'} {root.path} ({projects.length})
      </button>
      {open && projects.map(p => (
        <button
          key={p.id}
          onClick={() => onSelect(p)}
          className={`w-full text-left px-4 py-1 text-sm ${selectedProjectId === p.id ? 'bg-[--accent]' : 'hover:bg-[--panel]'}`}
        >
          {p.name}
        </button>
      ))}
    </div>
  );
}
