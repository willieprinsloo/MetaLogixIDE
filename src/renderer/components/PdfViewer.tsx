import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@renderer/api';
import { useDocumentZoom } from '@renderer/hooks/useDocumentZoom';
import * as pdfjsLib from 'pdfjs-dist';

// One-time worker wiring. `new URL(..., import.meta.url)` is Vite's native
// asset-URL pattern and avoids the `?url` suffix that pdfjs-dist's missing
// package.json exports map makes awkward to type. The URL resolves at dev
// (HMR) and in the packaged renderer alike.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).href;

interface PageMeta { width: number; height: number; }

/**
 * Themed PDF viewer backed by pdfjs. Continuous vertical scroll of every
 * page, text selection on, lazy canvas rendering via IntersectionObserver so
 * a 400-page PDF doesn't eat all the GPU memory up front.
 *
 * Zoom is per-document — a 300% page-20 inspection shouldn't follow you to
 * the next file.
 */
export function PdfViewer({ projectId, relPath, onFullscreenToggle, fullscreen }: {
  projectId: number;
  relPath: string;
  onFullscreenToggle: () => void;
  fullscreen: boolean;
}) {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [pages, setPages] = useState<PageMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activePage, setActivePage] = useState<number>(1);
  const { zoom, zoomIn, zoomOut, resetZoom } = useDocumentZoom(`metaide.pdfZoom:${relPath}`);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageNodes = useRef<Map<number, HTMLDivElement>>(new Map());

  // Load the file bytes, then the pdf.
  useEffect(() => {
    let cancelled = false;
    let loaded: PdfDoc | null = null;
    (async () => {
      setError(null);
      setDoc(null);
      setPages([]);
      setActivePage(1);
      try {
        const { bytes } = await api.invoke('files:read-bytes', { projectId, relPath });
        if (cancelled) return;
        // pdfjs needs its own copy — it may transfer or hold on past our Blob lifetime.
        const copy = new Uint8Array(bytes);
        const task = pdfjsLib.getDocument({ data: copy, disableAutoFetch: true, disableStream: true });
        loaded = (await task.promise) as unknown as PdfDoc;
        if (cancelled) { loaded.destroy(); return; }
        const n = loaded.numPages;
        const metas: PageMeta[] = [];
        for (let i = 1; i <= n; i++) {
          const page = await loaded.getPage(i);
          const v = page.getViewport({ scale: 1 });
          metas.push({ width: v.width, height: v.height });
        }
        if (cancelled) { loaded.destroy(); return; }
        setDoc(loaded);
        setPages(metas);
      } catch (e) {
        if (!cancelled) setError(String(e).replace(/^Error:\s*/, ''));
      }
    })();
    return () => {
      cancelled = true;
      if (loaded) loaded.destroy();
    };
  }, [projectId, relPath]);

  // ⌘+/⌘-/⌘0, PageUp/PageDown, Home/End — all scoped to the viewer.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomIn(); return; }
      if (mod && e.key === '-')                    { e.preventDefault(); zoomOut(); return; }
      if (mod && e.key === '0')                    { e.preventDefault(); resetZoom(); return; }
      if (e.key === 'PageDown' || (e.key === 'ArrowDown' && mod)) { e.preventDefault(); goToPage(activePage + 1); return; }
      if (e.key === 'PageUp'   || (e.key === 'ArrowUp'   && mod)) { e.preventDefault(); goToPage(activePage - 1); return; }
      if (mod && e.key === 'Home') { e.preventDefault(); goToPage(1); return; }
      if (mod && e.key === 'End')  { e.preventDefault(); goToPage(pages.length); return; }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [zoomIn, zoomOut, resetZoom, activePage, pages.length]);

  function goToPage(n: number) {
    const safe = Math.max(1, Math.min(pages.length, n));
    const node = pageNodes.current.get(safe);
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function onScroll() {
    // Which page's top is closest to the viewport top? That's the "active" page.
    const scroller = scrollRef.current;
    if (!scroller) return;
    const scrollTop = scroller.scrollTop;
    let closest = 1;
    let best = Infinity;
    for (const [n, node] of pageNodes.current) {
      const dist = Math.abs(node.offsetTop - scrollTop);
      if (dist < best) { best = dist; closest = n; }
    }
    if (closest !== activePage) setActivePage(closest);
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="h-full flex flex-col min-h-0 focus:outline-none"
      data-testid="pdf-viewer"
    >
      <PdfViewerToolbar
        page={activePage}
        total={pages.length}
        onPage={goToPage}
        zoom={zoom}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onReset={resetZoom}
        fullscreen={fullscreen}
        onFullscreenToggle={onFullscreenToggle}
      />
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-auto bg-[--panel]/30 px-6 py-6"
      >
        {error && <div className="p-6 text-sm text-[--danger]">{error}</div>}
        {!error && !doc && <div className="p-6 text-sm text-[--text-muted]">Loading…</div>}
        {doc && pages.length > 0 && (
          <div className="flex flex-col items-center gap-4 min-w-fit">
            {pages.map((meta, idx) => (
              <PdfPage
                key={idx + 1}
                doc={doc}
                pageNumber={idx + 1}
                meta={meta}
                zoom={zoom}
                registerNode={(el) => {
                  if (el) pageNodes.current.set(idx + 1, el);
                  else pageNodes.current.delete(idx + 1);
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A single PDF page slot. Reserves the layout box at the right aspect ratio
 * immediately so scroll position is stable, then renders onto its canvas
 * once the IntersectionObserver sees it come into view. Re-renders when
 * zoom changes.
 */
function PdfPage({ doc, pageNumber, meta, zoom, registerNode }: {
  doc: PdfDoc;
  pageNumber: number;
  meta: PageMeta;
  zoom: number;
  registerNode: (el: HTMLDivElement | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(pageNumber === 1); // eager-render the first page
  const scale = zoom * devicePixelRatio;
  const displayW = meta.width * zoom;
  const displayH = meta.height * zoom;

  useEffect(() => {
    registerNode(wrapRef.current);
    return () => registerNode(null);
  }, [registerNode]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (visible) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { setVisible(true); io.disconnect(); return; }
      }
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderTask: PdfRenderTask | null = null;
    (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        const viewport = page.getViewport({ scale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        renderTask = page.render({ canvasContext: ctx, viewport });
        await renderTask.promise;
      } catch (e: unknown) {
        const msg = (e as { name?: string } | null)?.name;
        if (msg !== 'RenderingCancelledException') console.error('pdf render', e);
      }
    })();
    return () => { renderTask?.cancel(); };
  }, [visible, doc, pageNumber, scale]);

  return (
    <div
      ref={wrapRef}
      data-page={pageNumber}
      className="bg-white shadow-md relative"
      style={{ width: displayW, height: displayH }}
    >
      {visible && (
        <canvas
          ref={canvasRef}
          style={{ width: displayW, height: displayH, display: 'block' }}
        />
      )}
      <div className="absolute bottom-1 right-1 text-[10px] font-mono text-[--text-muted] bg-black/40 text-white px-1 rounded pointer-events-none">
        {pageNumber}
      </div>
    </div>
  );
}

function PdfViewerToolbar({
  page, total, onPage, zoom, onZoomIn, onZoomOut, onReset, fullscreen, onFullscreenToggle,
}: {
  page: number;
  total: number;
  onPage: (n: number) => void;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  fullscreen: boolean;
  onFullscreenToggle: () => void;
}) {
  const pct = Math.round(zoom * 100);
  const pageInput = useMemo(() => String(page), [page]);
  return (
    <div className="px-3 py-1.5 border-b border-[--border] text-[11px] text-[--text-muted] flex items-center gap-2 overflow-hidden">
      <button
        onClick={() => onPage(page - 1)}
        disabled={page <= 1}
        className="px-2 py-0.5 rounded border border-[--border] hover:bg-[--panel-strong] disabled:opacity-40"
        title="Previous page (PageUp)"
      >
        ‹
      </button>
      <span className="font-mono tabular-nums">
        <input
          key={pageInput}
          defaultValue={pageInput}
          onBlur={(e) => { const n = parseInt(e.target.value, 10); if (!Number.isNaN(n)) onPage(n); }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          className="w-10 bg-transparent border border-[--border] rounded px-1 text-right outline-none focus:ring-1 focus:ring-[--accent]/60"
        />
        <span className="px-1">/ {total || '—'}</span>
      </span>
      <button
        onClick={() => onPage(page + 1)}
        disabled={total > 0 && page >= total}
        className="px-2 py-0.5 rounded border border-[--border] hover:bg-[--panel-strong] disabled:opacity-40"
        title="Next page (PageDown)"
      >
        ›
      </button>
      <div className="flex-1" />
      <button onClick={onZoomOut} className="px-2 py-0.5 rounded border border-[--border] hover:bg-[--panel-strong]" title="Zoom out (⌘-)">−</button>
      <button
        onClick={onReset}
        className="px-2 py-0.5 rounded border border-[--border] hover:bg-[--panel-strong] font-mono tabular-nums min-w-[52px]"
        title="Reset zoom (⌘0)"
      >
        {pct}%
      </button>
      <button onClick={onZoomIn} className="px-2 py-0.5 rounded border border-[--border] hover:bg-[--panel-strong]" title="Zoom in (⌘=)">+</button>
      <button
        onClick={onFullscreenToggle}
        className="px-2 py-0.5 rounded border border-[--border] hover:bg-[--panel-strong]"
        title={fullscreen ? 'Exit fullscreen (⌘⇧Enter)' : 'Fullscreen (⌘⇧Enter)'}
      >
        {fullscreen ? '⤡' : '⤢'}
      </button>
    </div>
  );
}

// Minimal types for pdfjs — the full d.ts is heavy and the surface we use is small.
interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): void;
}
interface PdfPage {
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): PdfRenderTask;
}
interface PdfRenderTask {
  promise: Promise<void>;
  cancel(): void;
}
