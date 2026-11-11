import { useEffect, useRef, useState } from 'react';
import { api } from '@renderer/api';
import { useDocumentZoom, ZOOM_DEFAULT } from '@renderer/hooks/useDocumentZoom';

/**
 * Themed image viewer: fit-to-window default, wheel-zoom, drag-pan when
 * zoomed. Checkerboard background makes transparency legible. SVGs render
 * via the browser's native image path, so they animate and stay crisp.
 *
 * Zoom is per-session, not persisted — a one-off 300% to inspect a chart
 * shouldn't carry over to the next image.
 */
export function ImageViewer({ projectId, relPath, onFullscreenToggle, fullscreen }: {
  projectId: number;
  relPath: string;
  onFullscreenToggle: () => void;
  fullscreen: boolean;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const { zoom, zoomIn, zoomOut, resetZoom, setZoom } = useDocumentZoom(`metaide.imageZoom:${relPath}`);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Load file bytes once per (projectId, relPath).
  useEffect(() => {
    let revoked = false;
    let localUrl: string | null = null;
    (async () => {
      setError(null);
      setBlobUrl(null);
      setNatural(null);
      setPan({ x: 0, y: 0 });
      try {
        const { bytes, mime } = await api.invoke('files:read-bytes', { projectId, relPath });
        if (revoked) return;
        // Cast widens Uint8Array<ArrayBufferLike> → BlobPart; the IPC
        // response is already a fresh ArrayBuffer-backed view, so there's
        // nothing shared to worry about at runtime.
        const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
        localUrl = URL.createObjectURL(blob);
        setBlobUrl(localUrl);
      } catch (e) {
        setError(String(e).replace(/^Error:\s*/, ''));
      }
    })();
    return () => {
      revoked = true;
      if (localUrl) URL.revokeObjectURL(localUrl);
    };
  }, [projectId, relPath]);

  // ⌘+/⌘-/⌘0 while the viewer owns the focus (and the shared file-preview root).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomIn(); }
      else if (e.key === '-')              { e.preventDefault(); zoomOut(); }
      else if (e.key === '0')              { e.preventDefault(); resetZoom(); }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [zoomIn, zoomOut, resetZoom]);

  function onWheel(e: React.WheelEvent) {
    // Native pinch-zoom on mac, ctrl+wheel on Windows.
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const dir = e.deltaY > 0 ? -1 : 1;
    const next = Math.max(0.5, Math.min(5, zoom + dir * 0.1));
    setZoom(Math.round(next * 100) / 100);
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
  }
  function onPointerUp(e: React.PointerEvent) {
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="h-full flex flex-col min-h-0 focus:outline-none"
      data-testid="image-viewer"
    >
      <ImageViewerToolbar
        zoom={zoom}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onReset={resetZoom}
        onFitToWindow={() => { setZoom(ZOOM_DEFAULT); setPan({ x: 0, y: 0 }); }}
        natural={natural}
        fullscreen={fullscreen}
        onFullscreenToggle={onFullscreenToggle}
      />
      <div
        className="flex-1 min-h-0 overflow-hidden relative select-none flex items-center justify-center bg-[--panel]/30"
        style={{ backgroundImage: 'linear-gradient(45deg, rgba(128,128,128,0.12) 25%, transparent 25%), linear-gradient(-45deg, rgba(128,128,128,0.12) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(128,128,128,0.12) 75%), linear-gradient(-45deg, transparent 75%, rgba(128,128,128,0.12) 75%)', backgroundSize: '16px 16px', backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0' }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {error && <div className="p-6 text-sm text-[--danger]">{error}</div>}
        {!error && !blobUrl && <div className="p-6 text-sm text-[--text-muted]">Loading…</div>}
        {blobUrl && (
          <img
            src={blobUrl}
            alt={relPath}
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget;
              setNatural({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: 'center center',
              maxWidth: '100%',
              maxHeight: '100%',
              transition: dragRef.current ? 'none' : 'transform 80ms ease-out',
              cursor: zoom > 1 ? (dragRef.current ? 'grabbing' : 'grab') : 'default',
              imageRendering: zoom >= 2 ? 'pixelated' : 'auto',
            }}
          />
        )}
      </div>
    </div>
  );
}

function ImageViewerToolbar({
  zoom, onZoomIn, onZoomOut, onReset, onFitToWindow, natural, fullscreen, onFullscreenToggle,
}: {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  onFitToWindow: () => void;
  natural: { w: number; h: number } | null;
  fullscreen: boolean;
  onFullscreenToggle: () => void;
}) {
  const pct = Math.round(zoom * 100);
  return (
    <div className="px-3 py-1.5 border-b border-[--border] text-[11px] text-[--text-muted] flex items-center gap-2 overflow-hidden">
      <span className="font-mono">
        {natural ? `${natural.w} × ${natural.h}` : '—'}
      </span>
      <div className="flex-1" />
      <ToolbarButton onClick={onZoomOut} title="Zoom out (⌘-)">−</ToolbarButton>
      <button
        onClick={onReset}
        className="text-[11px] px-2 py-0.5 rounded border border-[--border] hover:bg-[--panel-strong] font-mono tabular-nums min-w-[52px]"
        title="Reset zoom (⌘0)"
      >
        {pct}%
      </button>
      <ToolbarButton onClick={onZoomIn} title="Zoom in (⌘=)">+</ToolbarButton>
      <ToolbarButton onClick={onFitToWindow} title="Fit to window">Fit</ToolbarButton>
      <ToolbarButton onClick={onFullscreenToggle} title={fullscreen ? 'Exit fullscreen (⌘⇧Enter)' : 'Fullscreen (⌘⇧Enter)'}>
        {fullscreen ? '⤡' : '⤢'}
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="text-[11px] px-2 py-0.5 rounded border border-[--border] hover:bg-[--panel-strong]"
      title={title}
    >
      {children}
    </button>
  );
}
