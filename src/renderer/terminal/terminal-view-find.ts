import { readLogicalText, type LogicalText, type CellRange, type TextBuffer } from './terminal-cell-text';

interface FindPort {
  readonly buffer: () => TextBuffer;
  readonly show: (hit: CellRange) => void;
  readonly clear: () => void;
}

export interface TerminalFind {
  step(query: string, direction: 1 | -1): void;
  clear(): void;
}

interface Match { readonly logical: LogicalText; readonly start: number; readonly end: number }

/** Scan only retained lines; keep one match as the next/previous anchor. */
export function createTerminalFind(port: FindPort): TerminalFind {
  let anchor: CellRange | undefined;
  let previousQuery = '';
  function clear() { anchor = undefined; previousQuery = ''; port.clear(); }
  function step(query: string, direction: 1 | -1) {
    if (!query) { clear(); return; }
    if (query !== previousQuery) anchor = undefined;
    previousQuery = query;
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    const buffer = port.buffer();
    let wrap: Match | undefined;
    let next: Match | undefined;
    for (let row = 0; row < buffer.length;) {
      const logical = readLogicalText(buffer, row);
      const cut = anchor ? logical.offsetAt(anchor.start) ?? (row > anchor.start.row ? -1 : Infinity) : null;
      for (const match of logical.text.matchAll(pattern)) {
        const hit = { logical, start: match.index, end: match.index + match[0].length };
        if (direction < 0 || !wrap) wrap = hit;
        if (cut === null || (hit.start - cut) * direction > 0) next = hit;
        if (direction > 0 && next) break;
      }
      if (direction > 0 && next) break;
      row = logical.nextRow;
    }
    const hit = next ?? wrap;
    anchor = hit?.logical.range(hit.start, hit.end);
    if (anchor) port.show(anchor);
    else port.clear();
  }
  return { step, clear };
}
