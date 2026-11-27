import { describe, expect, it } from 'vitest';
import { SHORTCUT_COPY } from '@renderer/shortcut-copy';
import { FONT_COPY } from '@renderer/fonts/font-contract';
import { PALETTE_COPY } from '@renderer/command-palette-contract';
import { SIDEBAR_COPY } from '@renderer/sidebar-copy';

type PlatformCopy = Exclude<
  keyof typeof SHORTCUT_COPY,
  'chatPlaceholder' | 'chatEditHint' | 'clipboardErrorTitle'
>;

/** Every platform-aware sentence: today's mac literal, then the Linux text. */
const CASES: ReadonlyArray<readonly [PlatformCopy, string, string]> = [
  [
    'commitPlaceholder',
    'Commit message — ⌘Enter to commit',
    'Commit message — Ctrl+Enter to commit',
  ],
  ['findInTerminalToast', 'Focus the shell first, then ⌘F', 'Focus the shell first, then Ctrl+F'],
  ['settingsTitle', 'Settings (⌘,)', 'Settings (Ctrl+,)'],
  ['emptyPaletteKey', '⌘K', 'Ctrl+K'],
  ['emptySettingsKey', '⌘,', 'Ctrl+,'],
  [
    'filesFindTip',
    '⌘P finds a file by name across the project.',
    'Ctrl+P finds a file by name across the project.',
  ],
  ['filesEditTitle', 'Edit (⌘S to save)', 'Edit (Ctrl+S to save)'],
  ['filesSaveTitle', 'Save (⌘S)', 'Save (Ctrl+S)'],
  ['searchPrevTitle', 'Previous (⇧↩)', 'Previous (Shift+Enter)'],
  ['searchNextTitle', 'Next (↩)', 'Next (Enter)'],
  [
    'terminalSizeHint',
    'Every terminal uses this size. ⌘= / ⌘- / ⌘0 also change it.',
    'Every terminal uses this size. Ctrl+= / Ctrl+- / Ctrl+0 also change it.',
  ],
  ['statusHintKey', '⌘K', 'Ctrl+K'],
  ['statusHintLabel', 'Open command palette (⌘K)', 'Open command palette (Ctrl+K)'],
  ['newProjectHint', '⌘⇧N', 'Ctrl+Shift+N'],
  ['toggleSidebarLabel', 'Toggle sidebar (⌘B)', 'Toggle sidebar (Ctrl+B)'],
  ['newTerminalHint', '⌘T', 'Ctrl+T'],
  ['promptsShortcut', '⌘⇧K', 'Ctrl+Shift+K'],
  ['scrollbackShortcut', '⌘⇧O', 'Ctrl+Shift+O'],
];

describe('SHORTCUT_COPY', () => {
  it.each(CASES)('%s reads exactly today’s string on mac (AC7)', (name, mac) => {
    expect(SHORTCUT_COPY[name]('mac')).toBe(mac);
  });

  it.each(CASES)('%s reads the Ctrl+ form on Linux (AC6)', (name, _mac, linux) => {
    expect(SHORTCUT_COPY[name]('linux')).toBe(linux);
  });

  it('describes ChatTab’s real Enter-to-send behaviour, with no platform branch (AC9)', () => {
    expect(SHORTCUT_COPY.chatPlaceholder('general')).toBe('Message #general — Enter to send');
    expect(SHORTCUT_COPY.chatEditHint).toBe('Enter to save · Esc to cancel');
  });

  it('titles keyboard clipboard failures with the context menu’s error toasts', () => {
    expect(SHORTCUT_COPY.clipboardErrorTitle('copy')).toBe('Copy failed');
    expect(SHORTCUT_COPY.clipboardErrorTitle('paste')).toBe('Paste failed');
  });
});

describe('legacy copy constants keep their names and mac values (AC7)', () => {
  it('FONT_COPY.terminalSizeHint', () => {
    expect(FONT_COPY.terminalSizeHint).toBe(
      'Every terminal uses this size. ⌘= / ⌘- / ⌘0 also change it.',
    );
  });

  it('PALETTE_COPY.statusHintKey and statusHintLabel', () => {
    expect(PALETTE_COPY.statusHintKey).toBe('⌘K');
    expect(PALETTE_COPY.statusHintLabel).toBe('Open command palette (⌘K)');
  });

  it('SIDEBAR_COPY.menuNewProjectHint', () => {
    expect(SIDEBAR_COPY.menuNewProjectHint).toBe('⌘⇧N');
  });
});
