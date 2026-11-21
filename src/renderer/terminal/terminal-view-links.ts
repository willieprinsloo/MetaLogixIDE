import type { ILink } from '@xterm/xterm';
import { readLogicalText, type CellRange, type TextBuffer } from './terminal-cell-text';

const MAX_WRAPPED_ROWS = 32;
const WEB_LINK = /https?:\/\/[^\s<>"'`\\]+/giu;

export type TerminalFileLink = Omit<ILink, 'range'> & { readonly start: number; readonly end: number };

export function fileLinksInRow(buffer: TextBuffer, line: number, candidates: (text: string) => readonly TerminalFileLink[]): ILink[] {
  const logical = readLogicalText(buffer, line - 1, line);
  const links: ILink[] = [];
  for (const { start, end, ...link } of candidates(logical.text)) {
    const extent = logical.range(start, end);
    if (extent) links.push({ ...link, range: xtermLinkRange(extent) });
  }
  return links;
}

export function xtermLinkRange(range: CellRange): ILink['range'] {
  return { start: { x: range.start.col + 1, y: range.start.row + 1 }, end: { x: range.end.col + 1, y: range.end.row + 1 } };
}

/** Resolve only ordinary HTTP(S) text. Report candidates; the renderer's click guard activates them. */
export function terminalWebLinks(buffer: TextBuffer, line: number, activate: (url: string) => void): ILink[] {
  const hovered = line - 1;
  let start = hovered;
  while (start > 0 && buffer.getLine(start)?.isWrapped) {
    if (hovered - start >= MAX_WRAPPED_ROWS) return [];
    start--;
  }
  const logical = readLogicalText(buffer, start, Math.min(start + MAX_WRAPPED_ROWS, buffer.length));
  // Do not offer a truncated destination if an unreasonably large paragraph continues.
  if (buffer.getLine(logical.nextRow)?.isWrapped) return [];
  const links: ILink[] = [];
  for (const match of logical.text.matchAll(WEB_LINK)) {
    const text = match[0].replace(/[.,;:!?)}\]]+$/u, '');
    if (text.length > 4096 || [...text].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) continue;
    const url = URL.parse(text);
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) continue;
    const extent = logical.range(match.index, match.index + text.length);
    if (!extent || extent.start.row > hovered || extent.end.row < hovered) continue;
    links.push({ text, range: xtermLinkRange(extent), activate: () => activate(url.href) });
  }
  return links;
}
