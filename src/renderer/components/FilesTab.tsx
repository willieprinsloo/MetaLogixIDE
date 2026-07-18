import { useCallback, useEffect, useState } from 'react';
import { api } from '@renderer/api';

interface Entry { name: string; isDir: boolean; relPath: string; }

export function FilesTab({ projectId }: { projectId: number }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [path, setPath] = useState<string | undefined>(undefined);

  const load = useCallback(async (relPath?: string) => {
    const { entries } = await api.invoke('files:tree', { projectId, relPath });
    setEntries(entries);
    setPath(relPath);
  }, [projectId]);

  useEffect(() => { void load(undefined); }, [load]);

  return (
    <div className="p-3 h-full overflow-y-auto font-mono">
      <div className="text-xs text-[--text-muted] mb-2">{path ?? '/'}</div>
      {path && <button onClick={() => load(undefined)} className="text-xs mb-2 text-[--accent]">← root</button>}
      <ul className="text-sm">
        {entries.map(e => (
          <li key={e.relPath}>
            <button onClick={() => e.isDir && load(e.relPath)} className="hover:underline">
              {e.isDir ? '📁' : '📄'} {e.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
