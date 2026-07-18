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

  // Auto-refresh on every alive-shells:changed event while the panel is open.
  useEffect(() => {
    if (!open) return;
    const off = api.on('alive-shells:changed', () => { void refresh(); });
    return () => { off(); };
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      {/* backdrop — click anywhere outside the panel to close */}
      <div className="fixed inset-0 z-30" onClick={onClose} aria-hidden />
      <div
        data-testid="alive-shells-panel"
        className="fixed right-2 top-12 bottom-2 w-72 z-40 flex flex-col bg-[--panel-strong] border border-[--border] rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-2 border-b border-[--border] flex items-center justify-between shrink-0">
          <div className="font-semibold text-sm">Alive shells</div>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded text-[--text-muted] hover:text-[--text] hover:bg-[--panel]"
            title="Close (Esc)"
            data-testid="alive-panel-close"
            aria-label="Close alive shells"
          >
            <XIcon />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {rows.length === 0 && (
            <div className="p-4 text-sm text-[--text-muted]">No shells alive.</div>
          )}
          {rows.map((r) => (
            <div
              key={`${r.projectId}:${r.shellIndex}`}
              data-testid="alive-shell-row"
              className="px-3 py-2 border-b border-[--border] last:border-b-0"
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 live-dot" />
                <span data-testid="alive-shell-project-name" className="text-sm truncate">{r.projectName}</span>
              </div>
              <div className="text-[10px] text-[--text-muted] truncate font-mono" title={r.lastActiveAt}>
                {r.lastActiveAt}
              </div>
              <div className="mt-1.5 flex gap-1.5">
                <button
                  onClick={async () => {
                    await api.invoke('shells:pin', { projectId: r.projectId, shellIndex: r.shellIndex, pinned: !r.pinned });
                    await refresh();
                  }}
                  className="text-[11px] px-2 py-0.5 bg-[--panel] border border-[--border] rounded hover:bg-[--panel-strong]"
                >
                  {r.pinned ? 'Unpin' : 'Pin'}
                </button>
                <button
                  onClick={async () => {
                    await api.invoke('shells:kill', { projectId: r.projectId, shellIndex: r.shellIndex });
                    await refresh();
                  }}
                  className="text-[11px] px-2 py-0.5 bg-[--danger]/80 text-white rounded hover:brightness-110"
                >
                  Kill
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function XIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
