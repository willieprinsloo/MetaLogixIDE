import { describe, it, expect } from 'vitest';
import { appShortcutAction, isCommitShortcut, isSaveShortcut } from '@renderer/app-keys';
import type {
  AppShortcutAction,
  ShortcutKeyLike,
  ShortcutPlatform,
} from '@renderer/shortcut-contract';

type Mods = Partial<Omit<ShortcutKeyLike, 'key'>>;

const key = (k: string, mods: Mods = {}): ShortcutKeyLike => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

const PLATFORMS: ReadonlyArray<{ platform: ShortcutPlatform; mod: Mods; wrong: Mods }> = [
  { platform: 'other', mod: { ctrlKey: true }, wrong: { metaKey: true } },
  { platform: 'mac', mod: { metaKey: true }, wrong: { ctrlKey: true } },
];

const ACTIONS: ReadonlyArray<[string, boolean, AppShortcutAction]> = [
  ['b', false, 'toggle-sidebar'],
  ['\\', false, 'toggle-sidebar'],
  [',', false, 'open-settings'],
  ['N', true, 'new-project'],
  ['F', true, 'project-search'],
  ['K', true, 'prompts'],
  ['O', true, 'scrollback-search'],
  ['/', false, 'toggle-help'],
  ['t', false, 'new-terminal'],
  ['T', true, 'new-terminal-window'],
  ['j', false, 'toggle-agents-dock'],
  ['A', true, 'focus-agents-composer'],
];

describe.each(PLATFORMS)('appShortcutAction on $platform', ({ platform, mod, wrong }) => {
  it.each(ACTIONS)('maps mod+%s (shift=%s) to %s', (k, shiftKey, action) => {
    expect(appShortcutAction(key(k, { ...mod, shiftKey }), platform)).toBe(action);
  });

  it.each(ACTIONS)('ignores the other platform modifier alone for %s (shift=%s)', (k, shiftKey) => {
    expect(appShortcutAction(key(k, { ...wrong, shiftKey }), platform)).toBeNull();
  });

  it.each(ACTIONS)('ignores %s (shift=%s) when Cmd and Ctrl are both held', (k, shiftKey) => {
    expect(
      appShortcutAction(key(k, { metaKey: true, ctrlKey: true, shiftKey }), platform),
    ).toBeNull();
  });

  it('matches shifted letters whatever case the key reports', () => {
    expect(appShortcutAction(key('n', { ...mod, shiftKey: true }), platform)).toBe('new-project');
    expect(appShortcutAction(key('t', { ...mod, shiftKey: true }), platform)).toBe(
      'new-terminal-window',
    );
  });

  it('leaves unshifted F to terminal find and shifted B to nothing', () => {
    expect(appShortcutAction(key('f', mod), platform)).toBeNull();
    expect(appShortcutAction(key('B', { ...mod, shiftKey: true }), platform)).toBeNull();
  });

  it('leaves the palette chords and plain keys alone', () => {
    expect(appShortcutAction(key('k', mod), platform)).toBeNull();
    expect(appShortcutAction(key('p', mod), platform)).toBeNull();
    expect(appShortcutAction(key('b'), platform)).toBeNull();
    expect(appShortcutAction(key('T', { shiftKey: true }), platform)).toBeNull();
  });

  it('ignores Alt chords', () => {
    expect(appShortcutAction(key('b', { ...mod, altKey: true }), platform)).toBeNull();
  });
});

describe('Find in project vs terminal find on Linux (AC12)', () => {
  it('Ctrl+Shift+F opens project search, Ctrl+F does not', () => {
    expect(appShortcutAction(key('F', { ctrlKey: true, shiftKey: true }), 'other')).toBe(
      'project-search',
    );
    expect(appShortcutAction(key('f', { ctrlKey: true }), 'other')).toBeNull();
  });
});

describe.each(PLATFORMS)('isSaveShortcut on $platform', ({ platform, mod, wrong }) => {
  it('fires for mod+S', () => {
    expect(isSaveShortcut(key('s', mod), platform)).toBe(true);
  });

  it('does not fire for the other modifier, plain S, or mod+Shift+S', () => {
    expect(isSaveShortcut(key('s', wrong), platform)).toBe(false);
    expect(isSaveShortcut(key('s'), platform)).toBe(false);
    expect(isSaveShortcut(key('S', { ...mod, shiftKey: true }), platform)).toBe(false);
  });
});

describe.each(PLATFORMS)('isCommitShortcut on $platform', ({ platform, mod, wrong }) => {
  it('fires for mod+Enter', () => {
    expect(isCommitShortcut(key('Enter', mod), platform)).toBe(true);
  });

  it('does not fire for the other modifier or plain Enter', () => {
    expect(isCommitShortcut(key('Enter', wrong), platform)).toBe(false);
    expect(isCommitShortcut(key('Enter'), platform)).toBe(false);
  });
});
