import { describe, it, expect, vi } from 'vitest';
import { buildPaletteCommands, type PaletteCommandDeps } from '@renderer/palette-commands';
import { PALETTE_COPY, type PaletteCommand } from '@renderer/command-palette-contract';
import { SETTINGS_NAV_ITEMS } from '@renderer/components/settings/nav-icons';
import { KEEP_AWAKE_COPY, KEEP_AWAKE_PRESETS } from '@shared/keep-awake-contract';

type DepFn = Exclude<keyof PaletteCommandDeps, 'hasProject' | 'hasPrimary' | 'sidebarOpen' | 'platform' | 'keepAwake'>;

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
  return { fns, deps: { hasProject: true, hasPrimary: true, sidebarOpen: true, ...fns, ...over } };
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

  it('opens the P2P settings section from its command-palette entry', async () => {
    const { fns, deps: commandDeps } = deps({ hasProject: false });
    const command = buildPaletteCommands(commandDeps).find(
      (item) => item.category === 'Settings' && item.title === 'Settings: P2P',
    );
    expect(command).toBeDefined();
    await command?.run();
    expect(fns.openSettings).toHaveBeenCalledWith('p2p');
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

  it('hides unload when only nonzero shells are alive, without hiding other project commands', () => {
    const list = buildPaletteCommands(deps({ hasPrimary: false }).deps).map((command) => command.id);
    expect(list).not.toContain('shell.unload');
    expect(list).toContain('shell.popout');
    expect(list).toContain('term.new');
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

describe('keep-awake rows', () => {
  const keepAwake = (active: boolean) => ({
    active,
    start: vi.fn(),
    openUntil: vi.fn(),
    stop: vi.fn(),
    darkenNow: vi.fn(),
  });
  const rows = (list: readonly PaletteCommand[]) => list.filter((c) => c.id.startsWith('keep-awake.'));

  it('adds nothing when the dep is omitted or null (AC16)', () => {
    expect(rows(buildPaletteCommands(deps().deps))).toEqual([]);
    expect(rows(buildPaletteCommands(deps({ keepAwake: null }).deps))).toEqual([]);
  });

  it('adds the five presets and the until row when inactive, in the App category without needing a project (AC1)', () => {
    const list = buildPaletteCommands(deps({ keepAwake: keepAwake(false) }).deps);
    const r = rows(list);
    expect(r.map((c) => c.title)).toEqual([...KEEP_AWAKE_PRESETS.map((p) => p.title), KEEP_AWAKE_COPY.palette.until]);
    expect(r.every((c) => c.category === 'App' && !c.needsProject)).toBe(true);
  });

  it('keeps the rows when no project is selected', () => {
    const list = buildPaletteCommands(deps({ hasProject: false, keepAwake: keepAwake(false) }).deps);
    expect(rows(list)).toHaveLength(KEEP_AWAKE_PRESETS.length + 1);
  });

  it('adds Stop and Turn screen off now while active (AC9, AC11)', () => {
    const r = rows(buildPaletteCommands(deps({ keepAwake: keepAwake(true) }).deps));
    expect(r.map((c) => c.title).slice(-2)).toEqual([KEEP_AWAKE_COPY.palette.stop, KEEP_AWAKE_COPY.palette.darkenNow]);
    expect(r).toHaveLength(KEEP_AWAKE_PRESETS.length + 3);
  });

  it('omits Stop and Turn screen off now while inactive', () => {
    const titles = rows(buildPaletteCommands(deps({ keepAwake: keepAwake(false) }).deps)).map((c) => c.title);
    expect(titles).not.toContain(KEEP_AWAKE_COPY.palette.stop);
    expect(titles).not.toContain(KEEP_AWAKE_COPY.palette.darkenNow);
  });

  it('runs each preset with its own minutes', async () => {
    const ka = keepAwake(false);
    const list = buildPaletteCommands(deps({ keepAwake: ka }).deps);
    for (const p of KEEP_AWAKE_PRESETS) await byId(list, `keep-awake.${p.id}`).run();
    expect(ka.start.mock.calls.map((c) => c[0])).toEqual(KEEP_AWAKE_PRESETS.map((p) => p.minutes));
  });

  it('runs until, stop and darken through the matching dep', async () => {
    const ka = keepAwake(true);
    const list = buildPaletteCommands(deps({ keepAwake: ka }).deps);
    await byId(list, 'keep-awake.until').run();
    expect([ka.openUntil, ka.stop, ka.darkenNow].map((f) => f.mock.calls.length)).toEqual([1, 0, 0]);
    await byId(list, 'keep-awake.stop').run();
    await byId(list, 'keep-awake.darken').run();
    expect([ka.openUntil, ka.stop, ka.darkenNow].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
    expect(ka.start).not.toHaveBeenCalled();
  });
});
