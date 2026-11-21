interface TextRow {
  readonly isWrapped: boolean;
  readonly length: number;
  translateToString(trimRight?: boolean, start?: number, end?: number): string;
  getCell(col: number): { getChars(): string; getWidth(): number } | undefined;
}

export interface TextBuffer {
  readonly length: number;
  getLine(row: number): TextRow | undefined;
}

export interface CellPosition { readonly row: number; readonly col: number }
export interface CellRange { readonly start: CellPosition; readonly end: CellPosition }
interface Segment { readonly row: number; readonly start: number; readonly cells: TextRow }

export interface LogicalText {
  readonly text: string;
  readonly nextRow: number;
  offsetAt(position: CellPosition): number | undefined;
  range(start: number, end: number): CellRange | undefined;
}

function cellText(row: TextRow, col: number): { readonly width: number; readonly length: number } {
  const cell = row.getCell(col);
  return {
    width: Math.max(cell?.getWidth() ?? 1, 1),
    length: (cell?.getChars() || row.translateToString(false, col, col + 1)).length,
  };
}

/** Include intermediate row padding, but trim trailing whitespace on the final row. */
export function readLogicalText(buffer: TextBuffer, startRow: number, limit = buffer.length): LogicalText {
  const segments: Segment[] = [];
  const parts: string[] = [];
  let size = 0;
  let row = startRow;
  while (row < limit) {
    const cells = buffer.getLine(row);
    if (!cells) { row++; break; }
    const more = row + 1 < limit && buffer.getLine(row + 1)?.isWrapped;
    const text = cells.translateToString(!more);
    segments.push({ row, start: size, cells });
    parts.push(text);
    size += text.length;
    row++;
    if (!more) break;
  }
  function locate(offset: number, includeWideCell: boolean): CellPosition | undefined {
    const segment = segments.findLast(part => part.start <= offset);
    if (!segment) return undefined;
    let index = segment.start;
    for (let col = 0; col < segment.cells.length;) {
      const { width, length } = cellText(segment.cells, col);
      index += length;
      if (index > offset) return { row: segment.row, col: includeWideCell ? col + width - 1 : col };
      col += width;
    }
  }
  return {
    text: parts.join(''), nextRow: row,
    offsetAt(position) {
      const segment = segments[position.row - startRow];
      if (!segment) return;
      let offset = segment.start;
      for (let col = 0; col < Math.min(position.col, segment.cells.length);) {
        const { width, length } = cellText(segment.cells, col);
        offset += length;
        col += width;
      }
      return offset;
    },
    range(start, end) {
      const first = locate(start, false);
      const last = locate(end - 1, true);
      if (first && last && end > start) return { start: first, end: last };
    },
  };
}
