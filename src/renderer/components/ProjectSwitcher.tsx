import Fuse from 'fuse.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useProjects } from '@renderer/hooks/useProjects';
import type { Project } from '@shared/types';

export function ProjectSwitcher({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (p: Project) => void }) {
  const { projects, refresh } = useProjects();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const fuse = useMemo(() => new Fuse(projects, { keys: ['name', 'path'], threshold: 0.4 }), [projects]);
  const results = useMemo(() => (query ? fuse.search(query).map(r => r.item) : projects), [query, fuse, projects]);

  useEffect(() => {
    if (open) {
      void refresh();         // reload projects list each time the switcher opens
      inputRef.current?.focus();
    } else {
      setQuery('');
    }
  }, [open, refresh]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center pt-32 z-50" onClick={onClose}>
      <div className="bg-neutral-900 w-[600px] rounded shadow-lg border border-neutral-700" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Switch to project…"
          onKeyDown={e => { if (e.key === 'Enter' && results[0]) { onPick(results[0]); onClose(); } if (e.key === 'Escape') onClose(); }}
          className="w-full bg-transparent p-3 border-b border-neutral-800 outline-none"
        />
        <ul className="max-h-96 overflow-y-auto">
          {results.slice(0, 20).map(p => (
            <li key={p.id}>
              <button onClick={() => { onPick(p); onClose(); }} className="w-full text-left px-3 py-2 hover:bg-neutral-800">
                <div className="text-sm">{p.name}</div>
                <div className="text-xs text-neutral-500">{p.path}</div>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
