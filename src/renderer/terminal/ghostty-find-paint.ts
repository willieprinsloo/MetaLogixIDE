import type { CellRange } from './terminal-cell-text';

interface Viewport {
  readonly cols: number;
  readonly rows: number;
  readonly viewportY: number;
  readonly cellWidthPx: number;
  readonly cellHeightPx: number;
  readonly devicePixelRatio: number;
}

/** Paint a find result without using mouse selection or dispatching PTY mouse input. */
export function createGhosttyFindPaint(host: HTMLElement, viewport: () => Viewport, scrollTo: (row: number) => void): {
  show(hit: CellRange): void; refresh(): void; clear(): void;
} {
  let hit: CellRange | undefined;
  let layer: HTMLDivElement | undefined;
  let lastGrid = '';
  function refresh() {
    if (!hit || !layer) return;
    const grid = viewport();
    const { rows, cols, viewportY, devicePixelRatio } = grid;
    const width = grid.cellWidthPx / devicePixelRatio;
    const height = grid.cellHeightPx / devicePixelRatio;
    const gridKey = `${rows}:${cols}:${viewportY}:${width}:${height}`;
    if (lastGrid === gridKey) return;
    lastGrid = gridKey;
    const marks: HTMLElement[] = [];
    for (let row = Math.max(viewportY, hit.start.row); row <= Math.min(viewportY + rows - 1, hit.end.row); row++) {
      const start = row === hit.start.row ? hit.start.col : 0;
      const end = row === hit.end.row ? hit.end.col : cols - 1;
      const mark = host.ownerDocument.createElement('span');
      mark.className = 'absolute border border-[--accent]';
      mark.style.left = `${start * width}px`;
      mark.style.top = `${(row - viewportY) * height}px`;
      mark.style.width = `${(end - start + 1) * width}px`;
      mark.style.height = `${height}px`;
      marks.push(mark);
    }
    layer.replaceChildren(...marks);
  }
  return {
    show(range) {
      hit = range;
      lastGrid = '';
      if (!layer) {
        layer = host.ownerDocument.createElement('div');
        layer.className = 'pointer-events-none absolute inset-0 z-10 overflow-hidden';
        layer.dataset.terminalFind = '';
        layer.setAttribute('aria-hidden', 'true');
        host.append(layer);
      }
      const { viewportY, rows } = viewport();
      if (range.start.row < viewportY || range.end.row >= viewportY + rows) scrollTo(range.start.row);
      refresh();
    },
    refresh,
    clear() { hit = undefined; layer?.remove(); layer = undefined; },
  };
}
