import { useEffect, useState, useCallback } from 'react';
import type { AliveShellSummary } from '@shared/types';
import { api } from '@renderer/api';

export function AliveShellsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<AliveShellSummary[]>([]);
  const refresh = useCallback(async () => {
    const { shells } = await api.invoke('shells:alive-list', undefined as never);
    setRows(shells);
  }, []);
  useEffect(() => { if (open) void refresh(); }, [open, refresh]);
  if (!open) return null;
  return (
    <div data-testid="alive-shells-panel" className="fixed right-0 top-0 h-full w-96 bg-[--panel-strong] border-l border-[--border] z-40 flex flex-col">
      <div className="p-3 border-b border-[--border] flex items-center justify-between">
        <div className="font-semibold text-sm">Alive shells</div>
        <button onClick={onClose} className="text-xs text-[--text-muted] hover:text-[--text]">close</button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 && <div className="p-4 text-sm text-[--text-muted]">No shells alive.</div>}
        {rows.map(r => (
          <div key={`${r.projectId}:${r.shellIndex}`} data-testid="alive-shell-row" className="p-3 border-b border-[--border]">
            <div data-testid="alive-shell-project-name" className="text-sm">{r.projectName}</div>
            <div className="text-xs text-[--text-muted]">last active: {r.lastActiveAt}</div>
            <div className="mt-2 flex gap-2">
              <button onClick={async () => { await api.invoke('shells:pin', { projectId: r.projectId, shellIndex: r.shellIndex, pinned: !r.pinned }); await refresh(); }} className="text-xs px-2 py-0.5 bg-[--panel] rounded-md">
                {r.pinned ? 'Unpin' : 'Pin'}
              </button>
              <button onClick={async () => { await api.invoke('shells:kill', { projectId: r.projectId, shellIndex: r.shellIndex }); await refresh(); }} className="text-xs px-2 py-0.5 bg-[--danger]/80 text-white rounded-md hover:brightness-110">
                Close
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
