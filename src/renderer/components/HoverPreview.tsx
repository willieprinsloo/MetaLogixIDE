import { useEffect, useState } from 'react';
import { api } from '@renderer/api';

export interface HoverPreviewState {
  x: number;
  y: number;
  projectId: number;
  path: string;
  line: number | null;
}

interface PeekData {
  relPath: string;
  found: boolean;
  kind: 'text' | 'binary';
  head: string;
  sizeBytes: number;
  totalLines: number | null;
}

/**
 * Floating card that shows the first ~40 lines of a file. Positioned
 * relative to the cursor; clamps to viewport. Not dismissible from
 * inside — the parent controls open/close via its own hover / leave
 * logic on the terminal link.
 */
export function HoverPreview({ state, onOpen }: { state: HoverPreviewState | null; onOpen: (relPath: string, line: number | null) => void }) {
  const [data, setData] = useState<PeekData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!state) { setData(null); return; }
    let cancelled = false;
    setLoading(true);
    setData(null);
    (async () => {
      try {
        const res = await api.invoke('files:peek', { projectId: state.projectId, relPath: state.path });
        if (!cancelled) setData(res);
      } catch {
        if (!cancelled) setData({ relPath: state.path, found: false, kind: 'text', head: '', sizeBytes: 0, totalLines: null });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [state]);

  if (!state) return null;
  const maxX = window.innerWidth  - 480 - 8;
  const maxY = window.innerHeight - 280 - 8;
  const left = Math.min(state.x + 14, Math.max(8, maxX));
  const top  = Math.min(state.y + 14, Math.max(8, maxY));

  const canClick = data?.found;
  return (
    <div
      className="fixed z-50 w-[480px] max-h-[300px] rounded-md border border-[--border] bg-[--panel-strong] shadow-2xl backdrop-blur-md overflow-hidden text-[12px] pointer-events-auto"
      style={{ left, top }}
      onClick={() => { if (canClick) onOpen(data.relPath, state.line); }}
      onMouseDown={(e) => e.preventDefault()}
      role="tooltip"
      data-testid="hover-preview"
    >
      <div className="px-3 py-1.5 border-b border-[--border] flex items-center justify-between bg-[--panel]/60">
        <span className="font-mono truncate" title={data?.relPath ?? state.path}>{data?.relPath ?? state.path}</span>
        {state.line != null && <span className="text-[--text-muted]">line {state.line}</span>}
      </div>
      <div className="max-h-[240px] overflow-hidden">
        {loading && <div className="p-4 text-[--text-muted]">Loading…</div>}
        {!loading && data && !data.found && (
          <div className="p-3 text-[--text-muted]">File not found in this project.</div>
        )}
        {!loading && data?.found && data.kind === 'binary' && (
          <div className="p-3 text-[--text-muted]">Binary file — no preview.</div>
        )}
        {!loading && data?.found && data.kind === 'text' && (
          <pre className="px-3 py-2 font-mono text-[11px] leading-5 whitespace-pre overflow-hidden">{data.head}</pre>
        )}
      </div>
      {canClick && (
        <div className="px-3 py-1.5 border-t border-[--border] text-[10px] text-[--text-muted] bg-[--panel]/60 flex justify-between">
          <span>Click to open</span>
          {data?.totalLines != null && <span>{data.totalLines} lines · {formatBytes(data.sizeBytes)}</span>}
        </div>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
