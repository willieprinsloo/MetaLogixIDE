import { describe, expect, it } from 'vitest';
import { formatShortcut } from '@renderer/shortcut-format';
import { SHORTCUTS, type ShortcutDef } from '@renderer/shortcut-contract';

describe('formatShortcut (AC5)', () => {
  it('orders every modifier ⌃⌥⌘⇧ on mac, keeping today’s ⌘-before-⇧ labels', () => {
    expect(formatShortcut({ key: 'K', ctrl: true, alt: true, shift: true, mod: true }, 'mac')).toBe(
      '⌃⌥⌘⇧K',
    );
  });

  it('orders every modifier Ctrl+Alt+Shift on Linux, joined by +', () => {
    expect(formatShortcut({ key: 'K', alt: true, shift: true, mod: true }, 'linux')).toBe(
      'Ctrl+Alt+Shift+K',
    );
  });

  it('collapses ctrl and mod into a single Ctrl on Linux', () => {
    expect(formatShortcut({ key: 'K', ctrl: true, mod: true }, 'linux')).toBe('Ctrl+K');
    expect(formatShortcut({ key: 'C', ctrl: true, shift: true }, 'linux')).toBe('Ctrl+Shift+C');
  });

  it('keeps ctrl and mod apart on mac', () => {
    expect(formatShortcut({ key: 'C', ctrl: true, shift: true }, 'mac')).toBe('⌃⇧C');
  });

  it.each([
    ['mac', '↩', '⇧↩', '⌘↩'],
    ['linux', 'Enter', 'Shift+Enter', 'Ctrl+Enter'],
  ] as const)('shows Enter on %s as %s', (platform, bare, shifted, modded) => {
    expect(formatShortcut(SHORTCUTS.findNext, platform)).toBe(bare);
    expect(formatShortcut(SHORTCUTS.findPrev, platform)).toBe(shifted);
    expect(formatShortcut(SHORTCUTS.commit, platform)).toBe(modded);
  });

  it.each([',', '/', '=', '-', '\\', '0'])('shows the punctuation key %s as typed', (key) => {
    const def: ShortcutDef = { key, mod: true };
    expect(formatShortcut(def, 'mac')).toBe(`⌘${key}`);
    expect(formatShortcut(def, 'linux')).toBe(`Ctrl+${key}`);
  });

  it('upper-cases a lower-case letter key', () => {
    expect(formatShortcut({ key: 'k', mod: true }, 'mac')).toBe('⌘K');
    expect(formatShortcut({ key: 'k', mod: true, shift: true }, 'linux')).toBe('Ctrl+Shift+K');
  });

  it('formats today’s registry chords exactly as the mac glyphs in use', () => {
    expect(formatShortcut(SHORTCUTS.palette, 'mac')).toBe('⌘K');
    expect(formatShortcut(SHORTCUTS.scrollbackSearch, 'mac')).toBe('⌘⇧O');
    expect(formatShortcut(SHORTCUTS.scrollbackSearch, 'linux')).toBe('Ctrl+Shift+O');
  });
});
