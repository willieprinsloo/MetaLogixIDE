import { describe, it, expect, vi } from 'vitest';
import { buildPaletteCommands, type PaletteCommandDeps } from '@renderer/palette-commands';
import { PALETTE_COPY, type PaletteCommand } from '@renderer/command-palette-contract';
import { SETTINGS_NAV_ITEMS } from '@renderer/components/settings/nav-icons';

type DepFn = Exclude<keyof PaletteCommandDeps, 'hasProject' | 'sidebarOpen' | 'platform'>;

function deps(over: Partial<PaletteCommandDeps> = {}) {
  const fns = {
    openPalette: vi.fn(),
    openProjectSearch: vi.fn(),
    openScrollbackSearch: vi.fn(),
    openPrompts: vi.fn(),
    showTasks: vi.fn(),
    toggleSidebar: vi.fn(),
    showTab: vi.fn(),
    openHelp: vi.fn(),
    openNewProject: vi.fn(),
    unloadSession: vi.fn(async () => {}),
    popOutShell: vi.fn(async () => {}),
    findInTerminal: vi.fn(),
    openNewTerminal: vi.fn(),
    setThemeMode: vi.fn(),
    setThemePalette: vi.fn(),
    openSettings: vi.fn(),
  } satisfies Record<DepFn, unknown>;
  return { fns, deps: { hasProject: true, sidebarOpen: true, ...fns, ...over } };
}

function byId(list: readonly PaletteCommand[], id: string): PaletteCommand {
  const cmd = list.find((c) => c.id === id);
  if (!cmd) throw new Error(`no command ${id}`);
  return cmd;
}

/** The 445a479 list minus `nav.projects`: id, category, title, hint. */
const LEGACY: ReadonlyArray<readonly [string, string, string, string | undefined]> = [
  ['nav.find-file', 'Go', 'Find file in project', '⌘P'],
  ['nav.find-in-project', 'Go', 'Find in project…', '⌘⇧F'],
  ['nav.scrollback-search', 'Go', 'Search all shells…', '⌘⇧O'],
  ['shell.prompts', 'Shell', 'Open prompt library', '⌘⇧K'],
  ['view.tasks', 'View', 'Show tasks panel', undefined],
  ['view.sidebar', 'View', 'Hide sidebar', '⌘B'],
  ['view.shell', 'View', 'Switch to Shell tab', undefined],
  ['view.files', 'View', 'Switch to Files tab', undefined],
  ['view.diff', 'View', 'Switch to Diff tab', undefined],
  ['view.env', 'View', 'Switch to Env tab', undefined],
  ['view.help', 'View', 'Show keyboard shortcut cheat sheet', '⌘/'],
  ['proj.new', 'Project', 'New project…', '⌘⇧N'],
  ['shell.unload', 'Shell', 'Unload current session', undefined],
  ['shell.popout', 'Shell', 'Pop current shell into a new window', undefined],
  ['shell.find', 'Shell', 'Find in terminal', '⌘F'],
  ['shell.zoom.in', 'Shell', 'Zoom in', '⌘='],
  ['shell.zoom.out', 'Shell', 'Zoom out', '⌘-'],
  ['shell.zoom.reset', 'Shell', 'Reset zoom', '⌘0'],
  ['theme.system', 'Theme', 'Follow system theme', undefined],
  ['theme.light', 'Theme', 'Use light theme', undefined],
  ['theme.dark', 'Theme', 'Use dark theme', undefined],
  ['theme.default', 'Theme', 'Use Default palette', undefined],
  ['theme.catppuccin', 'Theme', 'Use Catppuccin palette', undefined],
  ['theme.rose-pine', 'Theme', 'Use Rosé Pine palette', undefined],
  ['app.settings', 'App', 'Open Settings', '⌘,'],
];

const NEEDS_PROJECT = [
  'nav.find-file',
  'nav.find-in-project',
  'shell.unload',
  'shell.popout',
  'view.shell',
  'view.files',
  'view.diff',
  'view.env',
  'term.new',
  'term.new-window',
];

/** Each command id and the dependency call its run must make. */
const EFFECTS: ReadonlyArray<readonly [string, DepFn, readonly unknown[]]> = [
  ['nav.find-file', 'openPalette', ['@']],
  ['nav.find-in-project', 'openProjectSearch', []],
  ['nav.scrollback-search', 'openScrollbackSearch', []],
  ['shell.prompts', 'openPrompts', []],
  ['view.tasks', 'showTasks', []],
  ['view.sidebar', 'toggleSidebar', []],
  ['view.shell', 'showTab', ['shell']],
  ['view.files', 'showTab', ['files']],
  ['view.diff', 'showTab', ['diff']],
  ['view.env', 'showTab', ['env']],
  ['view.help', 'openHelp', []],
  ['proj.new', 'openNewProject', []],
  ['shell.unload', 'unloadSession', []],
  ['shell.popout', 'popOutShell', []],
  ['shell.find', 'findInTerminal', []],
  ['theme.system', 'setThemeMode', ['system']],
  ['theme.light', 'setThemeMode', ['light']],
  ['theme.dark', 'setThemeMode', ['dark']],
  ['theme.default', 'setThemePalette', ['default']],
  ['theme.catppuccin', 'setThemePalette', ['catppuccin']],
  ['theme.rose-pine', 'setThemePalette', ['rose-pine']],
  ['app.settings', 'openSettings', []],
  ['term.new', 'openNewTerminal', [false]],
  ['term.new-window', 'openNewTerminal', [true]],
];

describe('buildPaletteCommands', () => {
  it('keeps every legacy command with the same id, category, title and hint, without the project switcher (AC9)', () => {
    const list = buildPaletteCommands(deps().deps);
    for (const [id, category, title, hint] of LEGACY) {
      const cmd = byId(list, id);
      expect({ id: cmd.id, category: cmd.category, title: cmd.title, hint: cmd.hint }).toEqual({ id, category, title, hint });
    }
    expect(list.some((c) => c.id === 'nav.projects')).toBe(false);
    expect(list.some((c) => /project switcher/i.test(c.title))).toBe(false);
  });

  it('lists exactly the legacy commands, two new-terminal commands and one row per Settings section', () => {
    const ids = buildPaletteCommands(deps().deps).map((c) => c.id);
    expect(ids).toHaveLength(LEGACY.length + 2 + SETTINGS_NAV_ITEMS.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('titles the sidebar command after the current sidebar state', () => {
    expect(byId(buildPaletteCommands(deps({ sidebarOpen: false }).deps), 'view.sidebar').title).toBe('Show sidebar');
  });

  it.each(EFFECTS)('runs %s through %s', async (id, fn, args) => {
    const { fns, deps: d } = deps();
    await byId(buildPaletteCommands(d), id).run();
    expect(fns[fn]).toHaveBeenCalledTimes(1);
    expect(fns[fn]).toHaveBeenCalledWith(...args);
    for (const [name, other] of Object.entries(fns)) {
      if (name !== fn) expect(other, name).not.toHaveBeenCalled();
    }
  });

  it('adds the two new-terminal commands with their shortcuts (AC10)', () => {
    const list = buildPaletteCommands(deps().deps);
    expect(byId(list, 'term.new')).toMatchObject({ title: PALETTE_COPY.newTerminal, hint: '⌘T', category: 'Shell' });
    expect(byId(list, 'term.new-window')).toMatchObject({ title: PALETTE_COPY.newTerminalWindow, hint: '⌘⇧T', category: 'Shell' });
  });

  it('adds one "Settings: <label>" row per section that opens that section (AC11)', async () => {
    const { fns, deps: d } = deps();
    const rows = buildPaletteCommands(d).filter((c) => c.category === 'Settings');
    expect(rows.map((c) => c.title)).toEqual([
      'Settings: General',
      'Settings: Root directories',
      'Settings: Launch commands',
      'Settings: Environment',
      'Settings: Metaproject',
      'Settings: P2P',
    ]);
    for (const [i, row] of rows.entries()) {
      await row.run();
      expect(fns.openSettings).toHaveBeenNthCalledWith(i + 1, SETTINGS_NAV_ITEMS[i]?.section);
    }
  });

  it('marks and hides the project-dependent commands when no project is selected (AC12)', () => {
    const withProject = buildPaletteCommands(deps().deps);
    for (const id of NEEDS_PROJECT) expect(byId(withProject, id).needsProject, id).toBe(true);
    const flagged = withProject.filter((c) => c.needsProject).map((c) => c.id);
    expect(flagged.sort()).toEqual([...NEEDS_PROJECT].sort());

    const without = buildPaletteCommands(deps({ hasProject: false }).deps).map((c) => c.id);
    for (const id of NEEDS_PROJECT) expect(without, id).not.toContain(id);
    expect(without).toHaveLength(withProject.length - NEEDS_PROJECT.length);
  });
});

const GLYPHS = /[⌘⇧⌥⌃↩⏎]/;

/** Every hinted command and its Linux label (AC6). */
const LINUX_HINTS: ReadonlyArray<readonly [string, string]> = [
  ['nav.find-file', 'Ctrl+P'],
  ['nav.find-in-project', 'Ctrl+Shift+F'],
  ['nav.scrollback-search', 'Ctrl+Shift+O'],
  ['shell.prompts', 'Ctrl+Shift+K'],
  ['view.sidebar', 'Ctrl+B'],
  ['view.help', 'Ctrl+/'],
  ['proj.new', 'Ctrl+Shift+N'],
  ['term.new', 'Ctrl+T'],
  ['term.new-window', 'Ctrl+Shift+T'],
  ['shell.find', 'Ctrl+F'],
  ['shell.zoom.in', 'Ctrl+='],
  ['shell.zoom.out', 'Ctrl+-'],
  ['shell.zoom.reset', 'Ctrl+0'],
  ['app.settings', 'Ctrl+,'],
];

describe('buildPaletteCommands on Linux (AC6)', () => {
  it.each(LINUX_HINTS)('hints %s as %s', (id, hint) => {
    expect(byId(buildPaletteCommands({ ...deps().deps, platform: 'other' }), id).hint).toBe(hint);
  });

  it('carries no Mac glyph in any hint and hints exactly the same commands as on mac', () => {
    const linux = buildPaletteCommands({ ...deps().deps, platform: 'other' });
    expect(linux.filter((c) => c.hint && GLYPHS.test(c.hint)).map((c) => c.id)).toEqual([]);
    const hinted = (list: readonly PaletteCommand[]) => list.filter((c) => c.hint).map((c) => c.id);
    expect(hinted(linux)).toEqual(hinted(buildPaletteCommands({ ...deps().deps, platform: 'mac' })));
    expect(hinted(linux).sort()).toEqual(LINUX_HINTS.map(([id]) => id).sort());
  });

  it('keeps today’s glyph hints when told mac explicitly (AC7)', () => {
    const list = buildPaletteCommands({ ...deps().deps, platform: 'mac' });
    for (const [id, , , hint] of LEGACY) expect(byId(list, id).hint, id).toBe(hint);
  });
});
