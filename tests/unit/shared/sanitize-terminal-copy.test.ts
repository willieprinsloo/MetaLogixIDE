import { describe, expect, it } from 'vitest';
import { sanitizeTerminalCopy } from '@shared/sanitize-terminal-copy';

describe('sanitizeTerminalCopy', () => {
  it('trims trailing spaces and tabs on every line', () => {
    expect(sanitizeTerminalCopy('a  \t\nb \r\n  c\t')).toBe('a\nb\n  c');
  });

  it('keeps interior whitespace', () => {
    expect(sanitizeTerminalCopy('a    b')).toBe('a    b');
  });

  it('strips ANSI, NBSP, zero-width and PUA characters', () => {
    expect(sanitizeTerminalCopy('\x1b[31mred\x1b[0m\u00A0x\u200By\uE0B0')).toBe('red xy');
  });

  it('handles long blank runs in linear time', () => {
    const raw = `${' '.repeat(200_000)}x\n${' '.repeat(200_000)}`;
    const start = performance.now();
    expect(sanitizeTerminalCopy(raw)).toBe(`${' '.repeat(200_000)}x\n`);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
