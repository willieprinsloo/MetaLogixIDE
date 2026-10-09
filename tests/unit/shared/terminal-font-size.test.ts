import { describe, expect, it } from 'vitest';
import {
  TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_KEY,
  LEGACY_SHELL_FONT_SIZE_STORAGE_KEY,
  clampTerminalFontSize,
  migratedTerminalFontSize,
  parseTerminalFontSize,
  stepTerminalFontSize,
} from '@shared/terminal-font-size';

describe('terminal font size contract', () => {
  it('exposes the agreed bounds, default and key', () => {
    expect(TERMINAL_FONT_SIZE).toEqual({ min: 9, max: 28, step: 1, default: 14 });
    expect(TERMINAL_FONT_SIZE_KEY).toBe('terminal_font_size');
    expect(LEGACY_SHELL_FONT_SIZE_STORAGE_KEY).toBe('metaide.shellFontSize');
  });
});

describe('parseTerminalFontSize', () => {
  it.each([9, 14, 28])('accepts in-range integer %j', (value) => {
    expect(parseTerminalFontSize(value)).toEqual({ ok: true, value });
  });

  it.each([8, 29, 16.5, NaN, Infinity, '16', null, undefined, {}])('rejects %j', (value) => {
    const result = parseTerminalFontSize(value);
    expect(result.ok).toBe(false);
  });
});

describe('clampTerminalFontSize', () => {
  it.each([
    [40, 28],
    [0, 9],
    [17.6, 18],
    [16.4, 16],
  ])('clampTerminalFontSize(%j) === %j', (input, expected) => {
    expect(clampTerminalFontSize(input)).toBe(expected);
  });
});

describe('stepTerminalFontSize', () => {
  it.each([
    [14, 'in', 15],
    [14, 'out', 13],
    [28, 'in', 28],
    [9, 'out', 9],
    [22, 'reset', 14],
  ] as const)('stepTerminalFontSize(%j, %j) === %j', (current, step, expected) => {
    expect(stepTerminalFontSize(current, step)).toBe(expected);
  });
});

describe('migratedTerminalFontSize', () => {
  it.each([
    ['18', 18],
    ['40', 28],
    ['3', 9],
    ['17.6', 18],
    ['abc', 14],
    ['', 14],
    [null, 14],
  ])('migratedTerminalFontSize(%j) === %j', (legacyRaw, expected) => {
    expect(migratedTerminalFontSize(legacyRaw)).toBe(expected);
  });
});
