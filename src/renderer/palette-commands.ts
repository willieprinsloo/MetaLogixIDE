/**
 * The command palette's command list as a pure function of App's actions. `buildPaletteCommands`
 * returns every command in palette order: the Go, View, Shell, Project, Theme and App commands, the
 * two new-terminal commands, and one "Settings: <label>" row per Settings section. Commands marked
 * `needsProject` are left out when no project is selected (AC12), so the palette never filters.
 */
import { PALETTE_COPY, type PaletteCommand, type PaletteSeed } from './command-palette-contract';
import { SETTINGS_NAV_ITEMS, type SettingsSection } from './components/settings/nav-icons';
import { KEEP_AWAKE_COPY, KEEP_AWAKE_PRESETS } from '@shared/keep-awake-contract';
import { DIFF_COPY } from './diff-tab-copy';
import type { ThemeMode, ThemePalette } from './hooks/useTheme';
import { SHORTCUTS, type ShortcutDef, type ShortcutPlatform } from './shortcut-contract';
import { formatShortcut } from './shortcut-format';
import { RUNTIME_SHORTCUT_PLATFORM } from './shortcut-platform';

/** The keep-awake actions the App-category rows run; `active` decides whether Stop and Turn screen off now are listed. */
export interface PaletteKeepAwake {
  readonly active: boolean;
  readonly start: (minutes: number) => void;
  readonly openUntil: () => void;
  readonly stop: () => void;
  readonly darkenNow: () => void;
}

export type PaletteTab = 'shell' | 'files' | 'diff' | 'settings';

/** The App actions the commands run, plus the two facts that shape the list. */
export interface PaletteCommandDeps {
  readonly hasProject: boolean;
  readonly hasPrimary: boolean;
  readonly sidebarOpen: boolean;
  readonly openPalette: (seed: PaletteSeed) => void;
  readonly openProjectSearch: () => void;
  readonly openScrollbackSearch: () => void;
  readonly openPrompts: () => void;
  readonly showTasks: () => void;
  readonly toggleSidebar: () => void;
  readonly statusBarVisible: boolean;
  readonly toggleStatusBar: () => void;
  readonly showTab: (tab: PaletteTab) => void;
  readonly openHelp: () => void;
  readonly openNewProject: () => void;
  readonly unloadSession: () => Promise<void>;
  readonly popOutShell: () => Promise<void>;
  readonly findInTerminal: () => void;
  readonly openNewTerminal: (newWindow: boolean) => void;
  readonly setThemeMode: (mode: ThemeMode) => void;
  readonly setThemePalette: (palette: ThemePalette) => void;
  readonly openSettings: (section?: SettingsSection) => void;
  /** Keep-awake rows; omitted or null off macOS (and in pop-out windows), which lists none. */
  readonly keepAwake?: PaletteKeepAwake | null;
  /** Label notation for the hints; defaults to the runtime platform. */
  readonly platform?: ShortcutPlatform;
}

const noop = (): void => {};

function keepAwakeCommands(k: PaletteKeepAwake | null | undefined): PaletteCommand[] {
  if (!k) return [];
  const rows: PaletteCommand[] = [
    ...KEEP_AWAKE_PRESETS.map((p): PaletteCommand => ({ id: `keep-awake.${p.id}`, category: 'App', title: p.title, run: () => k.start(p.minutes) })),
    { id: 'keep-awake.until', category: 'App', title: KEEP_AWAKE_COPY.palette.until, run: k.openUntil },
  ];
  if (k.active) {
    rows.push(
      { id: 'keep-awake.stop', category: 'App', title: KEEP_AWAKE_COPY.palette.stop, run: k.stop },
      { id: 'keep-awake.darken', category: 'App', title: KEEP_AWAKE_COPY.palette.darkenNow, run: k.darkenNow },
    );
  }
  return rows;
}

/** Builds the palette's commands for the current project and sidebar state, hinted in the platform's shortcut notation. */
export function buildPaletteCommands(d: PaletteCommandDeps): PaletteCommand[] {
  const platform = d.platform ?? RUNTIME_SHORTCUT_PLATFORM;
  const hint = (def: ShortcutDef): string => formatShortcut(def, platform);
  const all: PaletteCommand[] = [
    { id: 'nav.find-file', category: 'Go', title: 'Find file in project', hint: hint(SHORTCUTS.findFile), needsProject: true, run: () => d.openPalette('@') },
    { id: 'nav.find-in-project', category: 'Go', title: 'Find in project…', hint: hint(SHORTCUTS.findInProject), needsProject: true, run: d.openProjectSearch },
    { id: 'nav.scrollback-search', category: 'Go', title: 'Search all shells…', hint: hint(SHORTCUTS.scrollbackSearch), run: d.openScrollbackSearch },
    { id: 'shell.prompts', category: 'Shell', title: 'Open prompt library', hint: hint(SHORTCUTS.prompts), run: d.openPrompts },
    { id: 'view.tasks', category: 'View', title: 'Show tasks panel', run: d.showTasks },
    { id: 'view.sidebar', category: 'View', title: d.sidebarOpen ? 'Hide sidebar' : 'Show sidebar', hint: hint(SHORTCUTS.sidebar), run: d.toggleSidebar },
    { id: 'view.status-bar', category: 'View', title: d.statusBarVisible ? 'Hide status bar' : 'Show status bar', run: d.toggleStatusBar },
    { id: 'view.shell', category: 'View', title: 'Switch to Shell tab', needsProject: true, run: () => d.showTab('shell') },
    { id: 'view.files', category: 'View', title: 'Switch to Files tab', needsProject: true, run: () => d.showTab('files') },
    { id: 'view.diff', category: 'View', title: DIFF_COPY.paletteTitle, needsProject: true, run: () => d.showTab('diff') },
    { id: 'view.env', category: 'View', title: 'Edit environment variables', needsProject: true, run: () => d.showTab('settings') },
    { id: 'view.help', category: 'View', title: 'Show keyboard shortcut cheat sheet', hint: hint(SHORTCUTS.help), run: d.openHelp },
    { id: 'proj.new', category: 'Project', title: 'New project…', hint: hint(SHORTCUTS.newProject), run: d.openNewProject },
    { id: 'shell.unload', category: 'Shell', title: 'Unload current session', needsProject: true, run: d.unloadSession },
    { id: 'shell.popout', category: 'Shell', title: 'Pop current shell into a new window', needsProject: true, run: d.popOutShell },
    { id: 'term.new', category: 'Shell', title: PALETTE_COPY.newTerminal, hint: hint(SHORTCUTS.newTerminal), needsProject: true, run: () => d.openNewTerminal(false) },
    { id: 'term.new-window', category: 'Shell', title: PALETTE_COPY.newTerminalWindow, hint: hint(SHORTCUTS.newTerminalWindow), needsProject: true, run: () => d.openNewTerminal(true) },
    { id: 'shell.find', category: 'Shell', title: 'Find in terminal', hint: hint(SHORTCUTS.findInTerminal), run: d.findInTerminal },
    { id: 'shell.zoom.in', category: 'Shell', title: 'Zoom in', hint: hint(SHORTCUTS.zoomIn), run: noop },
    { id: 'shell.zoom.out', category: 'Shell', title: 'Zoom out', hint: hint(SHORTCUTS.zoomOut), run: noop },
    { id: 'shell.zoom.reset', category: 'Shell', title: 'Reset zoom', hint: hint(SHORTCUTS.zoomReset), run: noop },
    { id: 'theme.system', category: 'Theme', title: 'Follow system theme', run: () => d.setThemeMode('system') },
    { id: 'theme.light', category: 'Theme', title: 'Use light theme', run: () => d.setThemeMode('light') },
    { id: 'theme.dark', category: 'Theme', title: 'Use dark theme', run: () => d.setThemeMode('dark') },
    { id: 'theme.default', category: 'Theme', title: 'Use Default palette', run: () => d.setThemePalette('default') },
    { id: 'theme.catppuccin', category: 'Theme', title: 'Use Catppuccin palette', run: () => d.setThemePalette('catppuccin') },
    { id: 'theme.rose-pine', category: 'Theme', title: 'Use Rosé Pine palette', run: () => d.setThemePalette('rose-pine') },
    { id: 'app.settings', category: 'App', title: 'Open Settings', hint: hint(SHORTCUTS.settings), run: () => d.openSettings() },
    ...keepAwakeCommands(d.keepAwake),
    ...SETTINGS_NAV_ITEMS.map(({ section, label }): PaletteCommand => ({
      id: `settings.${section}`,
      category: 'Settings',
      title: `${PALETTE_COPY.settingsPrefix}${label}`,
      run: () => d.openSettings(section),
    })),
  ];
  return all.filter((command) => (d.hasProject || !command.needsProject) && (d.hasPrimary || command.id !== 'shell.unload'));
}
