import { describe, it, expect } from 'vitest';
import { chordKey, isPrimaryMod } from '@renderer/shortcut-match';
import type { ShortcutKeyLike } from '@renderer/shortcut-contract';

const key = (k: string, mods: Partial<Omit<ShortcutKeyLike, 'key'>> = {}): ShortcutKeyLike => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('isPrimaryMod', () => {
  it('counts Ctrl as the modifier on other platforms', () => {
    expect(isPrimaryMod(key('k', { ctrlKey: true }), 'linux')).toBe(true);
    expect(isPrimaryMod(key('K', { ctrlKey: true, shiftKey: true, altKey: true }), 'linux')).toBe(
      true,
    );
  });

  it('does not count Super (metaKey) on other platforms, alone or with Ctrl', () => {
    expect(isPrimaryMod(key('k', { metaKey: true }), 'linux')).toBe(false);
    expect(isPrimaryMod(key('k', { metaKey: true, ctrlKey: true }), 'linux')).toBe(false);
  });

  it('counts Cmd as the modifier on mac', () => {
    expect(isPrimaryMod(key('k', { metaKey: true }), 'mac')).toBe(true);
    expect(isPrimaryMod(key('K', { metaKey: true, shiftKey: true, altKey: true }), 'mac')).toBe(
      true,
    );
  });

  it('does not count Ctrl on mac, alone or with Cmd', () => {
    expect(isPrimaryMod(key('k', { ctrlKey: true }), 'mac')).toBe(false);
    expect(isPrimaryMod(key('k', { ctrlKey: true, metaKey: true }), 'mac')).toBe(false);
  });

  it.each(['mac', 'linux'] as const)(
    'is false with no modifier or only Shift/Alt (%s)',
    (platform) => {
      expect(isPrimaryMod(key('k'), platform)).toBe(false);
      expect(isPrimaryMod(key('K', { shiftKey: true, altKey: true }), platform)).toBe(false);
    },
  );
});

describe('chordKey', () => {
  it('lower-cases the key and prefixes alt then shift, ignoring Cmd/Ctrl', () => {
    expect(chordKey(key('K', { ctrlKey: true }))).toBe('k');
    expect(chordKey(key('P', { metaKey: true, shiftKey: true }))).toBe('shift+p');
    expect(chordKey(key('p', { altKey: true, shiftKey: true }))).toBe('alt+shift+p');
    expect(chordKey(key('Enter'))).toBe('enter');
    expect(chordKey(key('\\'))).toBe('\\');
  });
});
