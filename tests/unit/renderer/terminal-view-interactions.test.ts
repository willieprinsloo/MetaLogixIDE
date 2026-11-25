import { describe, expect, it, vi } from 'vitest';
import { createTerminalFind } from '@renderer/terminal/terminal-view-find';
import { terminalWebLinks } from '@renderer/terminal/terminal-view-links';

function buffer(rows: readonly (readonly string[])[], wrapped: readonly number[] = []) {
  return {
    length: rows.length,
    getLine(row: number) {
      const cells = rows[row];
      if (!cells) return undefined;
      return {
        isWrapped: wrapped.includes(row), length: cells.length,
        translateToString: () => cells.join(''),
        getCell(col: number) {
          const chars = cells[col];
          return chars === undefined ? undefined : { getChars: () => chars, getWidth: () => !chars ? 0 : cells[col + 1] === '' ? 2 : 1 };
        },
      };
    },
  };
}

describe('Ghostty text interactions', () => {
  it('finds literal Unicode text across soft wraps and cycles in both directions', () => {
    const data = buffer([['界', '', 'e\u0301', '+', 'A'], ['B', '-'], ['e\u0301', '+', 'a', 'b']], [1]);
    const show = vi.fn();
    const clear = vi.fn();
    const find = createTerminalFind({ buffer: () => data, show, clear });
    find.step('e\u0301+ab', 1);
    expect(show).toHaveBeenLastCalledWith({ start: { row: 0, col: 2 }, end: { row: 1, col: 0 } });
    find.step('e\u0301+ab', 1);
    expect(show).toHaveBeenLastCalledWith({ start: { row: 2, col: 0 }, end: { row: 2, col: 3 } });
    find.step('e\u0301+ab', -1);
    expect(show).toHaveBeenLastCalledWith({ start: { row: 0, col: 2 }, end: { row: 1, col: 0 } });
    find.step('e\u0301+ab', -1);
    expect(show).toHaveBeenLastCalledWith({ start: { row: 2, col: 0 }, end: { row: 2, col: 3 } });
    find.step('b-e', 1);
    expect(clear).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledTimes(4);
  });

  it('maps a wrapped HTTPS URL to cells and declines local paths and non-web schemes', () => {
    const data = buffer([['界', '', ' ', ...'https://exam'], [...'ple.test/a). '], [...'file:///private/demo javascript:abc']], [1]);
    const activate = vi.fn();
    const links = terminalWebLinks(data, 2, activate);
    expect(links).toHaveLength(1);
    const [link] = links;
    expect(link?.range).toEqual({ start: { x: 4, y: 1 }, end: { x: 10, y: 2 } });
    expect(link?.text).toBe('https://example.test/a');
    expect(activate).not.toHaveBeenCalled();
    expect(terminalWebLinks(data, 3, activate)).toEqual([]);
  });
});
