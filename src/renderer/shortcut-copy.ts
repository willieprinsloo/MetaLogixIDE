/**
 * Sentence-level shortcut copy as functions of the platform, for every label site that cannot be
 * rendered in node tests (App, ShellTab, FilesTab, GitPanel, ChatTab) plus the strings the legacy
 * copy constants keep. Each function returns today's literal on mac and the `Ctrl+…` text form
 * elsewhere, built from the `SHORTCUTS` registry through `formatShortcut`. Two deliberate
 * exceptions: the commit placeholder keeps its shipped `⌘Enter` wording on mac, and the ChatTab
 * hints have no platform branch because plain Enter sends on every platform.
 */
import { SHORTCUTS, type ShortcutDef, type ShortcutPlatform } from './shortcut-contract';
import { formatShortcut } from './shortcut-format';

type PlatformCopy = (platform: ShortcutPlatform) => string;

const key =
  (def: ShortcutDef): PlatformCopy =>
  (platform) =>
    formatShortcut(def, platform);

export const SHORTCUT_COPY = {
  commitPlaceholder: (platform: ShortcutPlatform): string =>
    `Commit message — ${platform === 'mac' ? '⌘Enter' : formatShortcut(SHORTCUTS.commit, platform)} to commit`,
  findInTerminalToast: (platform: ShortcutPlatform): string =>
    `Focus the shell first, then ${formatShortcut(SHORTCUTS.findInTerminal, platform)}`,
  settingsTitle: (platform: ShortcutPlatform): string =>
    `Settings (${formatShortcut(SHORTCUTS.settings, platform)})`,
  emptyPaletteKey: key(SHORTCUTS.palette),
  emptySettingsKey: key(SHORTCUTS.settings),
  toggleSidebarKey: key(SHORTCUTS.sidebar),
  filesFindTip: (platform: ShortcutPlatform): string =>
    `${formatShortcut(SHORTCUTS.findFile, platform)} finds a file by name across the project.`,
  filesEditTitle: (platform: ShortcutPlatform): string =>
    `Edit (${formatShortcut(SHORTCUTS.save, platform)} to save)`,
  filesSaveTitle: (platform: ShortcutPlatform): string =>
    `Save (${formatShortcut(SHORTCUTS.save, platform)})`,
  searchPrevTitle: (platform: ShortcutPlatform): string =>
    `Previous (${formatShortcut(SHORTCUTS.findPrev, platform)})`,
  searchNextTitle: (platform: ShortcutPlatform): string =>
    `Next (${formatShortcut(SHORTCUTS.findNext, platform)})`,
  terminalSizeHint: (platform: ShortcutPlatform): string => {
    const zoom = [SHORTCUTS.zoomIn, SHORTCUTS.zoomOut, SHORTCUTS.zoomReset].map((d) =>
      formatShortcut(d, platform),
    );
    return `Every terminal uses this size. ${zoom.join(' / ')} also change it.`;
  },
  statusHintKey: key(SHORTCUTS.palette),
  statusHintLabel: (platform: ShortcutPlatform): string =>
    `Open command palette (${formatShortcut(SHORTCUTS.palette, platform)})`,
  newProjectHint: key(SHORTCUTS.newProject),
  toggleSidebarLabel: (platform: ShortcutPlatform): string =>
    `Toggle sidebar (${formatShortcut(SHORTCUTS.sidebar, platform)})`,
  agentsDockLabel: (platform: ShortcutPlatform): string =>
    `Agents dock (${formatShortcut(SHORTCUTS.agentsDock, platform)})`,
  newTerminalHint: key(SHORTCUTS.newTerminal),
  promptsShortcut: key(SHORTCUTS.prompts),
  scrollbackShortcut: key(SHORTCUTS.scrollbackSearch),
  chatPlaceholder: (channel: string): string => `Message #${channel} — Enter to send`,
  chatEditHint: 'Enter to save · Esc to cancel',
  clipboardErrorTitle: (op: 'copy' | 'paste'): string =>
    op === 'copy' ? 'Copy failed' : 'Paste failed',
} as const;
