/**
 * Unified command palette (⌘K): docs/specs/command-palette.md, AC1-AC20, AC29-AC31, AC33-AC44.
 * Plan: docs/plan/command-palette.md §8 "Agent 4". The modal material (AC21-AC26) and ⌘K over
 * another modal (AC5a) live in modal-glass.spec.ts.
 *
 * Why this home can observe the behaviour: the suite drives the built Electron app through
 * helpers/focus.ts `launch` — real main process, real IPC, real project directories on disk,
 * real ptys running scripts/mock-claude.mjs, real React. Nothing in the palette's path is
 * stubbed. The only test-side interventions are replacing one `ipcMain` handler in the main
 * process (to make a command fail, or to hold or fail the file listing) and writing files into
 * a project from the test process, which is what a shell or an agent would do.
 *
 * Selectors and copy come from the contracts (PALETTE_COPY, PALETTE_TESTIDS, GROUP_ORDER, the
 * caps, MODAL_CLASSES, SETTINGS_NAV_ITEMS, DIFF_COPY) plus ARIA roles the spec requires
 * (combobox, listbox, group, option, aria-selected, aria-activedescendant). The one exception is
 * `PRE_PALETTE_COMMANDS`: AC9's oracle is "today's commands list", so it is restated from the
 * pre-feature App.tsx (445a479:src/renderer/App.tsx, the `commands` memo) on purpose — importing
 * the new list would make the test agree with whatever the implementation ships.
 *
 * Keys go through `win.keyboard.press`, i.e. Electron's real input pipeline (CDP), so the
 * app's window keydown listener, xterm and the inputs all see them as a user's keys.
 */

import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GROUP_ORDER, PALETTE_COPY, PALETTE_FILE_CAP, PALETTE_FILE_LIMIT, PALETTE_ROW_CAP, PALETTE_TESTIDS,
  type PaletteGroupId,
} from '../../src/renderer/command-palette-contract';
import { MODAL_CLASSES } from '../../src/renderer/modal-glass';
import { DIFF_COPY } from '../../src/renderer/diff-tab-copy';
import { SETTINGS_NAV_ITEMS } from '../../src/renderer/components/settings/nav-icons';
import { AGENT_DOT } from '../../src/shared/agent-state';
import {
  launch, openProject, projectIdByName, aliveProjectNames, terminalActiveIn, waitForProjectShown,
  PRIMARY, SIDEBAR_FILTER_INPUT, type Launched,
} from './helpers/focus';
import { sampleDuring, frameLog, recordKeydowns, keydownTimes, recordIpc, ipcLog, type Frame } from './helpers/frames';

type Api = { invoke: (c: string, r: unknown) => Promise<unknown> };
type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown;

/* ─────────────────────────────── harness ─────────────────────────────── */

async function withApp(names: string[], fn: (l: Launched) => Promise<void>): Promise<void> {
  const l = await launch(names);
  try {
    await fn(l);
  } finally {
    await l.app.close();
    l.cleanup();
  }
}

async function invoke<T>(win: Page, channel: string, req: unknown = undefined): Promise<T> {
  return win.evaluate(
    ({ channel, req }) => (window as unknown as { api: Api }).api.invoke(channel, req),
    { channel, req },
  ) as Promise<T>;
}

/** Names of the visible projects in `projects:list` order (pinned, then last opened, then name). */
async function listedProjects(win: Page): Promise<Array<{ name: string; path: string }>> {
  const { projects } = await invoke<{ projects: Array<{ name: string; path: string }> }>(win, 'projects:list');
  return projects;
}

/** Replaces a main-process invoke handler with one that always rejects with `message`. */
async function failIpc(app: ElectronApplication, channel: string, message: string): Promise<void> {
  await app.evaluate(({ ipcMain }, a: { channel: string; message: string }) => {
    ipcMain.removeHandler(a.channel);
    ipcMain.handle(a.channel, async () => { throw new Error(a.message); });
  }, { channel, message });
}

/** Holds every reply on `channel` until the returned `release` runs; the original handler then answers. */
async function holdIpc(app: ElectronApplication, channel: string): Promise<() => Promise<void>> {
  await app.evaluate(({ ipcMain }, ch: string) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, InvokeHandler> })._invokeHandlers;
    const original = handlers?.get(ch);
    if (!original) throw new Error(`holdIpc: no ${ch} handler in ipcMain._invokeHandlers (Electron internals changed?)`);
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    (globalThis as unknown as { __e2eRelease: () => void }).__e2eRelease = release;
    ipcMain.removeHandler(ch);
    ipcMain.handle(ch, async (event, ...args: unknown[]) => { await gate; return original(event, ...args); });
  }, channel);
  return async () => {
    await app.evaluate(() => { (globalThis as unknown as { __e2eRelease: () => void }).__e2eRelease(); });
  };
}

/* ─────────────────────────────── palette locators ─────────────────────────────── */

const root = (win: Page) => win.getByTestId(PALETTE_TESTIDS.root);
const input = (win: Page) => win.getByTestId(PALETTE_TESTIDS.input);
const scrim = (win: Page) => win.getByTestId(PALETTE_TESTIDS.scrim);
const panel = (win: Page) => win.getByTestId(PALETTE_TESTIDS.panel);
const listbox = (win: Page) => win.getByTestId(PALETTE_TESTIDS.listbox);
const emptyState = (win: Page) => win.getByTestId(PALETTE_TESTIDS.empty);
const options = (win: Page) => root(win).getByRole('option');
const highlighted = (win: Page) => root(win).locator('[role="option"][aria-selected="true"]');
/** The option carrying an element whose own text is exactly `text` (a project name, command title or file name). */
const optionFor = (win: Page, text: string) => options(win).filter({ has: win.getByText(text, { exact: true }) });
const groupTitle = (id: PaletteGroupId) => PALETTE_COPY.groupTitles[id];
const group = (win: Page, id: PaletteGroupId) => root(win).getByRole('group', { name: groupTitle(id), exact: true });

/** Group headings in render order, read from each `role="group"`'s label. */
async function groupNames(win: Page): Promise<string[]> {
  return root(win).evaluate((r) => [...r.querySelectorAll('[role="group"]')].map((g) => {
    const by = g.getAttribute('aria-labelledby');
    const label = by
      ? by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
      : g.getAttribute('aria-label') ?? '';
    return label.trim();
  }));
}

async function optionIds(win: Page): Promise<string[]> {
  return options(win).evaluateAll((els) => els.map((e) => e.id));
}

/** Opens the palette with a real chord and checks the input is focused and seeded. */
async function openPalette(win: Page, chord = 'ControlOrMeta+k', seed = ''): Promise<void> {
  await win.keyboard.press(chord);
  await expect(root(win)).toBeVisible({ timeout: 3000 });
  await expect(input(win), 'the input is focused on open').toBeFocused();
  await expect(input(win), `opens seeded with ${JSON.stringify(seed)}`).toHaveValue(seed);
}

async function closePalette(win: Page): Promise<void> {
  await win.keyboard.press('Escape');
  await expect(root(win)).toHaveCount(0);
}

/** Runs a command by title in ">" mode with a click (a click runs the row, AC3). */
async function runCommand(win: Page, title: string): Promise<void> {
  await openPalette(win, 'ControlOrMeta+Shift+P', '>');
  await input(win).fill(`>${title}`);
  const row = optionFor(win, title);
  await expect(row, `"${title}" is listed`).toHaveCount(1);
  await row.click();
}

/** Caret position of the input (both ends of the selection). */
async function caret(win: Page): Promise<{ start: number | null; end: number | null; length: number }> {
  return input(win).evaluate((el) => {
    const i = el as HTMLInputElement;
    return { start: i.selectionStart, end: i.selectionEnd, length: i.value.length };
  });
}

/** Writes `files` (relative path → content) into a project directory. */
function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

async function box(el: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await el.boundingBox();
  if (!b) throw new Error('element has no box');
  return b;
}

/** A point on the scrim well clear of the panel (bottom-left corner of the window, above the status bar). */
async function clickBackdrop(win: Page): Promise<void> {
  const s = await box(scrim(win));
  const p = await box(panel(win));
  const point = { x: s.x + 24, y: s.y + s.height - 80 };
  expect(point.x < p.x || point.y > p.y + p.height, 'precondition: the backdrop point is outside the panel').toBe(true);
  await win.mouse.click(point.x, point.y);
}

/* ─────────────────────────────── AC9 oracle ─────────────────────────────── */

/**
 * The pre-feature command list (445a479:src/renderer/App.tsx, `commands`), minus "Open project
 * switcher" (AC9). `needsProject` is AC12's list. The sidebar row reads "Hide sidebar" while the
 * sidebar is open, which it is in these tests.
 */
const PRE_PALETTE_COMMANDS: ReadonlyArray<{ title: string; category: PaletteGroupId; hint?: string; needsProject?: true }> = [
  { title: 'Find file in project', category: 'Go', hint: '⌘P', needsProject: true },
  { title: 'Find in project…', category: 'Go', hint: '⌘⇧F', needsProject: true },
  { title: 'Search all shells…', category: 'Go', hint: '⌘⇧O' },
  { title: 'Open prompt library', category: 'Shell', hint: '⌘⇧K' },
  { title: 'Show tasks panel', category: 'View' },
  { title: 'Hide sidebar', category: 'View', hint: '⌘B' },
  { title: 'Switch to Shell tab', category: 'View', needsProject: true },
  { title: 'Switch to Files tab', category: 'View', needsProject: true },
  { title: DIFF_COPY.paletteTitle, category: 'View', needsProject: true },
  { title: 'Switch to Env tab', category: 'View', needsProject: true },
  { title: 'Show keyboard shortcut cheat sheet', category: 'View', hint: '⌘/' },
  { title: 'New project…', category: 'Project', hint: '⌘⇧N' },
  { title: 'Unload current session', category: 'Shell', needsProject: true },
  { title: 'Pop current shell into a new window', category: 'Shell', needsProject: true },
  { title: 'Find in terminal', category: 'Shell', hint: '⌘F' },
  { title: 'Zoom in', category: 'Shell', hint: '⌘=' },
  { title: 'Zoom out', category: 'Shell', hint: '⌘-' },
  { title: 'Reset zoom', category: 'Shell', hint: '⌘0' },
  { title: 'Follow system theme', category: 'Theme' },
  { title: 'Use light theme', category: 'Theme' },
  { title: 'Use dark theme', category: 'Theme' },
  { title: 'Use Default palette', category: 'Theme' },
  { title: 'Use Catppuccin palette', category: 'Theme' },
  { title: 'Use Rosé Pine palette', category: 'Theme' },
  { title: 'Open Settings', category: 'App', hint: '⌘,' },
];
const REMOVED_COMMAND = 'Open project switcher';
/** AC10: shortcut hints of the two added commands (their category is not pinned by the spec). */
const NEW_TERMINAL_COMMANDS = [
  { title: PALETTE_COPY.newTerminal, hint: '⌘T' },
  { title: PALETTE_COPY.newTerminalWindow, hint: '⌘⇧T' },
] as const;

/* ─────────────────────────────── opening, closing, keyboard ─────────────────────────────── */

test.describe('opening, closing and focus', () => {
  test('AC1, AC2: ⌘K opens from a terminal, a text field and the Files editor; ⌘K, Esc and the backdrop close it and focus returns', async () => {
    await withApp(['alpha'], async ({ win, demoRoot }) => {
      writeFiles(join(demoRoot, 'alpha'), { 'editme.txt': 'edit me\n' });
      await openProject(win, 'alpha');

      // From a focused terminal; ⌘K again closes; focus goes back to the terminal.
      await win.locator(`${PRIMARY} .xterm`).click();
      await expect.poll(() => terminalActiveIn(win, PRIMARY), { message: 'precondition: the terminal has focus' }).toBe(true);
      await openPalette(win);
      await expect(input(win)).toHaveAttribute('placeholder', PALETTE_COPY.placeholder);
      await win.keyboard.press('ControlOrMeta+k');
      await expect(root(win), '⌘K toggles the palette closed').toHaveCount(0);
      await expect.poll(() => terminalActiveIn(win, PRIMARY), { message: 'focus returns to the terminal' }).toBe(true);

      // From a text field; Esc closes; focus returns to the field.
      const filter = win.locator(SIDEBAR_FILTER_INPUT).first();
      await filter.click();
      await expect(filter).toBeFocused();
      await openPalette(win);
      await win.keyboard.press('Escape');
      await expect(root(win), 'Esc closes').toHaveCount(0);
      await expect(filter, 'focus returns to the text field').toBeFocused();

      // Backdrop: a click inside the panel does not close (positive control), a click outside does.
      await filter.click();
      await openPalette(win);
      await input(win).click();
      await expect(root(win), 'a click inside the panel keeps the palette open').toBeVisible();
      await clickBackdrop(win);
      await expect(root(win), 'a backdrop click closes').toHaveCount(0);
      await expect(filter, 'focus returns to the text field after a backdrop click').toBeFocused();

      // From the Files editor (a file opened through "@", then put in edit mode).
      await openPalette(win, 'ControlOrMeta+p', '@');
      await input(win).fill('@editme');
      await optionFor(win, 'editme.txt').click();
      await expect(win.getByTestId('file-preview')).toContainText('edit me');
      await win.getByTestId('file-edit-toggle').click();
      const editor = win.getByTestId('file-editor').locator('textarea');
      await editor.click();
      await expect(editor).toBeFocused();
      await openPalette(win);
      await closePalette(win);
      await expect(editor, 'focus returns to the editor').toBeFocused();
    });
  });

  test('AC4: the palette is fully visible in the first frame after ⌘K and gone in the first frame after Esc', async () => {
    await withApp(['alpha'], async ({ win }) => {
      await win.getByTestId('activity-bar').click({ position: { x: 20, y: 400 } }); // focus out of any terminal
      await recordKeydowns(win);
      const targets = {
        layer: `[data-testid="${PALETTE_TESTIDS.root}"]`,
        sheet: `[data-testid="${PALETTE_TESTIDS.root}"] .${MODAL_CLASSES.sheet}`,
        scrim: `[data-testid="${PALETTE_TESTIDS.scrim}"]`,
      };
      const fields: Array<[string, 'present' | 'opacity' | 'transform']> = [
        ['sheet', 'present'], ['sheet', 'opacity'], ['sheet', 'transform'], ['layer', 'opacity'], ['scrim', 'opacity'],
      ];
      const from = (frames: Frame[], t: number) => frames.filter((f) => f.t >= t);

      const open = await sampleDuring(win, targets, 500, () => win.keyboard.press('ControlOrMeta+k'));
      await expect(root(win)).toBeVisible();
      const tOpen = (await keydownTimes(win)).filter((k) => k.key === 'k').at(-1)!.t;
      const openLog = `\nopen frames:\n${frameLog(open, fields)}`;
      const afterOpen = from(open, tOpen);
      const appear = afterOpen.findIndex((f) => f.s.sheet!.present);
      expect(appear, `the sheet appears within 2 frames of the keydown${openLog}`).toBeGreaterThanOrEqual(0);
      expect(appear, `the sheet appears within 2 frames of the keydown${openLog}`).toBeLessThanOrEqual(1);
      for (const f of open.filter((x) => x.s.sheet!.present)) {
        expect(f.s.sheet!.opacity, `no fade on the sheet${openLog}`).toBe(1);
        expect(f.s.layer!.opacity, `no fade on the layer${openLog}`).toBe(1);
        expect(f.s.scrim!.opacity, `no fade on the scrim${openLog}`).toBe(1);
        expect(f.s.sheet!.transform, `no scale on the sheet${openLog}`).toBe('none');
      }

      const close = await sampleDuring(win, targets, 500, () => win.keyboard.press('Escape'));
      await expect(root(win)).toHaveCount(0);
      const tClose = (await keydownTimes(win)).filter((k) => k.key === 'Escape').at(-1)!.t;
      const closeLog = `\nclose frames:\n${frameLog(close, fields)}`;
      const afterClose = from(close, tClose);
      const gone = afterClose.findIndex((f) => !f.s.sheet!.present && !f.s.scrim!.present);
      expect(gone, `the palette is gone within 2 frames of Esc${closeLog}`).toBeGreaterThanOrEqual(0);
      expect(gone, `the palette is gone within 2 frames of Esc${closeLog}`).toBeLessThanOrEqual(1);
      expect(close.every((f) => !f.s.sheet!.present || f.s.sheet!.opacity === 1), `no fade-out${closeLog}`).toBe(true);
    });
  });

  test('AC5: while the palette is open, ⌘, ⌘⇧N and ⌘/ open no second overlay', async () => {
    await withApp(['alpha'], async ({ win }) => {
      await openPalette(win);
      for (const [chord, testId] of [
        ['ControlOrMeta+,', 'settings-modal'],
        ['ControlOrMeta+Shift+N', 'new-project-dialog'],
        ['ControlOrMeta+/', 'shortcuts-help'],
      ] as const) {
        await win.keyboard.press(chord);
        await expect(root(win), `positive control: the palette is still open after ${chord}`).toBeVisible();
        await expect(win.getByTestId(testId), `${chord} opens nothing over the palette`).toHaveCount(0);
      }
      await closePalette(win);
      // Positive control: the same chord does open its overlay once the palette is closed.
      await win.keyboard.press('ControlOrMeta+,');
      await expect(win.getByTestId('settings-modal')).toBeVisible();
    });
  });
});

/* ─────────────────────────────── rows ─────────────────────────────── */

test.describe('rows', () => {
  test('AC3, AC20: arrows cross groups, aria-activedescendant follows, hover highlights without running, Enter and click run', async () => {
    await withApp(['alpha', 'beta'], async ({ win }) => {
      await openProject(win, 'alpha');
      await openPalette(win);

      // AC20 semantics.
      await expect(input(win)).toHaveRole('combobox');
      await expect(input(win)).toHaveAccessibleName(PALETTE_COPY.inputLabel);
      await expect(listbox(win)).toHaveRole('listbox');
      const ids = await optionIds(win);
      expect(ids.length, 'positive control: rows are listed').toBeGreaterThan(4);
      expect(new Set(ids).size, 'every option has a unique id').toBe(ids.length);
      expect(ids.every((id) => id !== ''), 'every option has an id').toBe(true);

      // The first row is highlighted on open.
      await expect(highlighted(win)).toHaveCount(1);
      await expect(input(win)).toHaveAttribute('aria-activedescendant', ids[0]!);

      // Two projects, then the first row of the Go group: the arrows skip the group heading.
      const firstGo = await group(win, 'Go').getByRole('option').first().getAttribute('id');
      expect(firstGo, 'precondition: Go is the group after Projects').toBe(ids[2]);
      for (const i of [1, 2]) {
        await win.keyboard.press('ArrowDown');
        await expect(input(win), `ArrowDown ${i}`).toHaveAttribute('aria-activedescendant', ids[i]!);
        await expect(highlighted(win)).toHaveAttribute('id', ids[i]!);
      }
      await win.keyboard.press('ArrowUp');
      await expect(input(win), 'ArrowUp goes back').toHaveAttribute('aria-activedescendant', ids[1]!);

      // Hover moves the highlight and runs nothing.
      const light = optionFor(win, 'Use light theme');
      await light.hover();
      await expect(light).toHaveAttribute('aria-selected', 'true');
      await expect(input(win), 'hover moves aria-activedescendant').toHaveAttribute('aria-activedescendant', (await light.getAttribute('id'))!);
      await expect(root(win), 'hover runs nothing').toBeVisible();
      await expect(win.locator('html')).toHaveAttribute('data-theme', 'dark');

      // Enter runs the highlighted row and closes.
      await input(win).focus();
      await win.keyboard.press('Enter');
      await expect(root(win)).toHaveCount(0);
      await expect(win.locator('html'), 'Enter ran "Use light theme"').toHaveAttribute('data-theme', 'light');

      // A click runs a row.
      await openPalette(win);
      await optionFor(win, 'Use dark theme').click();
      await expect(root(win)).toHaveCount(0);
      await expect(win.locator('html'), 'the click ran "Use dark theme"').toHaveAttribute('data-theme', 'dark');
    });
  });

  test('AC6: empty-query groups put live projects under Running before Go, Project, View, Shell, Theme, App, Settings', async () => {
    await withApp(['alpha'], async ({ win }) => {
      await openProject(win, 'alpha');
      await openPalette(win);
      expect(await groupNames(win)).toEqual(GROUP_ORDER.filter((id) => id !== 'projects').map(groupTitle));
      // A live project belongs to Running, not Projects; commands retain their categories.
      await expect(group(win, 'running').getByRole('option').filter({ has: win.getByText('alpha', { exact: true }) })).toHaveCount(1);
      await expect(group(win, 'projects')).toHaveCount(0);
      await expect(group(win, 'App').getByRole('option').filter({ has: win.getByText('Open Settings', { exact: true }) })).toHaveCount(1);
    });
  });

  test('AC6, AC41: with no projects the Projects group is absent and "#" says there are none', async () => {
    await withApp([], async ({ win }) => {
      await openPalette(win);
      const names = await groupNames(win);
      expect(names, 'empty groups are not shown').toEqual(GROUP_ORDER.filter((id) => id !== 'running' && id !== 'projects').map(groupTitle));
      await expect(optionFor(win, 'New project…'), 'positive control: "New project…" is offered').toHaveCount(1);
      await expect(optionFor(win, `${PALETTE_COPY.settingsPrefix}${SETTINGS_NAV_ITEMS.find((i) => i.section === 'roots')!.label}`))
        .toHaveCount(1);

      await input(win).fill('#');
      await expect(emptyState(win)).toHaveText(PALETTE_COPY.empty.noProjects);
      await expect(options(win)).toHaveCount(0);
      await win.keyboard.press('Enter');
      await expect(root(win), 'Enter does nothing with no rows').toBeVisible();
    });
  });

  test('AC7: projects follow projects:list order, show name, root folder (path on hover) and the live dot, and mark the current one', async () => {
    await withApp(['alpha', 'beta', 'gamma'], async ({ win }) => {
      await openProject(win, 'gamma');
      await openProject(win, 'alpha');
      await invoke(win, 'projects:pin', { id: await projectIdByName(win, 'beta'), pinned: true });
      const listed = await listedProjects(win);
      expect(listed[0]?.name, 'precondition: the pinned project leads projects:list').toBe('beta');

      await openPalette(win);
      // Running and dormant projects each retain relative projects:list order.
      const running = listed.filter((p) => p.name === 'alpha' || p.name === 'gamma');
      const dormant = listed.filter((p) => p.name === 'beta');
      await expect(group(win, 'running').getByRole('option')).toHaveCount(running.length);
      await expect(group(win, 'projects').getByRole('option')).toHaveCount(dormant.length);
      for (const [groupId, projects] of [['running', running], ['projects', dormant]] as const) {
        const rows = group(win, groupId).getByRole('option');
        for (const [i, p] of projects.entries()) {
          const row = rows.nth(i);
          await expect(row.getByText(p.name, { exact: true }), `row ${i} in ${groupId} is ${p.name}`).toHaveCount(1);
          await expect(row.getByTestId(PALETTE_TESTIDS.projectRoot), `row ${i} in ${groupId} has its path as the root label's tooltip`).toHaveAttribute('title', p.path);
        }
      }

      // Live dot: alpha and gamma have live shells, beta has none.
      await expect(optionFor(win, 'alpha').getByTestId(AGENT_DOT.testId), 'live project shows the status dot').toHaveCount(1);
      await expect(optionFor(win, 'gamma').getByTestId(AGENT_DOT.testId)).toHaveCount(1);
      await expect(optionFor(win, 'beta').getByTestId(AGENT_DOT.testId), 'a project with no live shell has no dot').toHaveCount(0);

      // Running appears first even though beta is pinned; alpha is initially highlighted.
      const alpha = optionFor(win, 'alpha');
      await expect(alpha).toHaveAttribute('aria-selected', 'true');
      await expect(alpha).toHaveAccessibleName(/current/i);
      await expect(optionFor(win, 'beta').getByText(PALETTE_COPY.current, { exact: true }), 'beta is not current').toHaveCount(0);
      await expect(optionFor(win, 'beta')).not.toHaveAccessibleName(/current/i);
      await optionFor(win, 'beta').hover();
      await expect(alpha).toHaveAttribute('aria-selected', 'false');
      await expect(alpha.getByText(PALETTE_COPY.current, { exact: true }), 'the inactive current row shows "Current"').toBeVisible();
      // Highlighted, the current row keeps "current" in its accessible name.
      await alpha.hover();
      await expect(alpha).toHaveAttribute('aria-selected', 'true');
      await expect(alpha).toHaveAccessibleName(/current/i);
    });
  });

  test('AC8: picking a project opens it with its shell; picking the current one only closes', async () => {
    await withApp(['alpha', 'beta'], async ({ app, win }) => {
      await openProject(win, 'alpha');
      await openPalette(win);
      await input(win).fill('beta');
      await optionFor(win, 'beta').click();
      await expect(root(win)).toHaveCount(0);
      await waitForProjectShown(win, 'beta');
      await expect(win.locator(`${PRIMARY} .xterm-screen`), 'beta\'s terminal is shown').toBeVisible({ timeout: 10000 });
      await expect.poll(() => aliveProjectNames(win), { message: 'beta\'s shell was launched' }).toContain('beta');

      // The current project: no projects:open, no remount, palette closes.
      await win.locator(`${PRIMARY} .xterm`).evaluate((el) => el.setAttribute('data-e2e-mark', 'same'));
      await recordIpc(app);
      await openPalette(win);
      await input(win).fill('beta');
      await optionFor(win, 'beta').click();
      await expect(root(win)).toHaveCount(0);
      expect(await win.title()).toBe('beta — MetaLogix IDE');
      await expect(win.locator(`${PRIMARY} .xterm[data-e2e-mark="same"]`), 'the terminal did not remount').toHaveCount(1);
      const opens = (await ipcLog(app)).filter((c) => c.ch === 'projects:open');
      expect(opens, 'picking the current project opens nothing').toEqual([]);
      // Positive control for the IPC log: picking alpha does call projects:open.
      await openPalette(win);
      await input(win).fill('alpha');
      await optionFor(win, 'alpha').click();
      await waitForProjectShown(win, 'alpha');
      expect((await ipcLog(app)).some((c) => c.ch === 'projects:open'), 'the log sees projects:open').toBe(true);
    });
  });
});

/* ─────────────────────────────── commands ─────────────────────────────── */

test.describe('commands', () => {
  test('AC9, AC10: every pre-existing command is listed with its category and hint; the switcher command is gone; New terminal rows are added', async () => {
    await withApp(['alpha'], async ({ win }) => {
      await openProject(win, 'alpha');
      await openPalette(win, 'ControlOrMeta+Shift+P', '>');
      for (const c of PRE_PALETTE_COMMANDS) {
        const row = group(win, c.category).getByRole('option').filter({ has: win.getByText(c.title, { exact: true }) });
        await expect(row, `"${c.title}" is listed under ${c.category}`).toHaveCount(1);
        if (c.hint) {
          const kbds = await row.locator('kbd').allTextContents();
          expect(kbds.map((k) => k.trim()), `"${c.title}" shows ${c.hint}`).toContain(c.hint);
        }
      }
      for (const c of NEW_TERMINAL_COMMANDS) {
        const row = optionFor(win, c.title);
        await expect(row, `"${c.title}" is listed`).toHaveCount(1);
        expect((await row.locator('kbd').allTextContents()).map((k) => k.trim())).toContain(c.hint);
      }
      await expect(optionFor(win, REMOVED_COMMAND), '"Open project switcher" is removed').toHaveCount(0);
    });
  });

  test('AC9: commands keep their effect (overlays, tabs, theme, palette)', async () => {
    await withApp(['alpha'], async ({ win }) => {
      await openProject(win, 'alpha');
      // Each overlay opened from the palette must hold focus like its own shortcut does, so Esc
      // closes it. Misses are collected (and the overlay closed by its scrim) so one run checks
      // every overlay and the remaining effects below.
      const escMisses: string[] = [];
      for (const [title, testId] of [
        ['Open Settings', 'settings-modal'],
        ['New project…', 'new-project-dialog'],
        ['Show keyboard shortcut cheat sheet', 'shortcuts-help'],
        ['Open prompt library', 'prompt-library'],
        ['Find in project…', 'project-search'],
        ['Search all shells…', 'scrollback-search'],
      ] as const) {
        await runCommand(win, title);
        const overlay = win.getByTestId(testId);
        await expect(overlay, `"${title}" opens ${testId}`).toBeVisible();
        await win.keyboard.press('Escape');
        try {
          await expect(overlay).toHaveCount(0, { timeout: 2000 });
        } catch {
          const active = await win.evaluate(() => {
            const a = document.activeElement;
            return `${a?.tagName.toLowerCase()}.${a?.className.toString().split(' ')[0]} in ${a?.closest('[data-testid]')?.getAttribute('data-testid')}`;
          });
          escMisses.push(`${testId} stays open on Esc (focus: ${active})`);
          const b = await win.getByTestId(`${testId}-scrim`).boundingBox();
          await win.mouse.click(b!.x + 24, b!.y + b!.height - 80);
          await expect(overlay).toHaveCount(0);
        }
      }
      await runCommand(win, 'Use Catppuccin palette');
      await expect(win.locator('html')).toHaveAttribute('data-palette', 'catppuccin');
      await runCommand(win, 'Use Default palette');
      await expect(win.locator('html')).not.toHaveAttribute('data-palette', 'catppuccin');
      await runCommand(win, DIFF_COPY.paletteTitle);
      await expect(win.locator('[data-testid="shell-tab"]'), 'the Diff tab replaced the Shell body').toHaveCount(0);
      await runCommand(win, 'Switch to Shell tab');
      await expect(win.locator('[data-testid="shell-tab"]').first(), 'back on the Shell tab').toBeVisible();

      expect(escMisses, 'overlays opened from the palette close on Esc, as when opened by their shortcut').toEqual([]);
    });
  });

  test('AC10: "New terminal" adds a shell; "New terminal in a new window" opens a window', async () => {
    await withApp(['alpha'], async ({ app, win }) => {
      await openProject(win, 'alpha');
      const aliveFor = async () => {
        const { shells } = await invoke<{ shells: Array<{ projectName: string }> }>(win, 'shells:alive-list');
        return shells.filter((s) => s.projectName === 'alpha').length;
      };
      await expect.poll(aliveFor).toBeGreaterThan(0);
      const before = await aliveFor();
      await runCommand(win, PALETTE_COPY.newTerminal);
      await expect.poll(aliveFor, { message: 'a new shell was launched' }).toBe(before + 1);
      expect(app.windows().length, 'no new window for "New terminal"').toBe(1);

      const popout = app.waitForEvent('window');
      await runCommand(win, PALETTE_COPY.newTerminalWindow);
      await popout;
      await expect.poll(aliveFor, { message: 'the new window has its own shell' }).toBe(before + 2);
      expect(app.windows().length).toBe(2);
    });
  });

  test('AC11: each "Settings: <section>" row opens Settings on that section', async () => {
    await withApp(['alpha'], async ({ win }) => {
      for (const item of SETTINGS_NAV_ITEMS) {
        const title = `${PALETTE_COPY.settingsPrefix}${item.label}`;
        await runCommand(win, title);
        await expect(root(win)).toHaveCount(0);
        const settings = win.getByTestId('settings-modal');
        await expect(settings, `${title} opens Settings`).toBeVisible();
        const nav = settings.getByRole('navigation', { name: 'Settings sections' });
        await expect(nav.locator('[aria-current="page"]'), `${title} opens ${item.section}`).toHaveCount(1);
        await expect(nav.locator('[aria-current="page"]')).toContainText(item.label);
        await win.getByTestId('settings-done').click();
        await expect(settings).toHaveCount(0);
      }
    });
  });

  test('AC11, AC12: with no project, project commands are hidden and the Settings group lists every section', async () => {
    await withApp(['alpha'], async ({ win }) => {
      await openPalette(win, 'ControlOrMeta+Shift+P', '>');
      for (const c of PRE_PALETTE_COMMANDS.filter((x) => x.needsProject)) {
        await expect(optionFor(win, c.title), `"${c.title}" needs a project`).toHaveCount(0);
      }
      for (const c of NEW_TERMINAL_COMMANDS) {
        await expect(optionFor(win, c.title), `"${c.title}" needs a project`).toHaveCount(0);
      }
      for (const c of PRE_PALETTE_COMMANDS.filter((x) => !x.needsProject)) {
        await expect(optionFor(win, c.title), `positive control: "${c.title}" is listed`).toHaveCount(1);
      }
      const settingsRows = group(win, 'Settings').getByRole('option');
      await expect(settingsRows).toHaveCount(SETTINGS_NAV_ITEMS.length);
      for (const [i, item] of SETTINGS_NAV_ITEMS.entries()) {
        await expect(settingsRows.nth(i).getByText(`${PALETTE_COPY.settingsPrefix}${item.label}`, { exact: true })).toHaveCount(1);
      }
    });
  });
});

/* ─────────────────────────────── typing and errors ─────────────────────────────── */

test.describe('typing and errors', () => {
  test('AC13: typing filters every group by fuzzy match, keeps the group order and ranks within a group', async () => {
    await withApp(['alpha', 'alphabet-soup', 'darkroom'], async ({ win }) => {
      await openPalette(win);
      // "dark" matches a project and a Theme command: Projects still comes first.
      await input(win).fill('dark');
      await expect(optionFor(win, 'darkroom')).toHaveCount(1);
      await expect(optionFor(win, 'Use dark theme')).toHaveCount(1);
      await expect(optionFor(win, 'alpha'), 'non-matching rows are filtered out').toHaveCount(0);
      const names = await groupNames(win);
      expect(names[0], 'Projects keeps its place').toBe(groupTitle('projects'));
      const order = GROUP_ORDER.map(groupTitle);
      expect([...names].sort((a, b) => order.indexOf(a) - order.indexOf(b)), 'groups stay in AC6 order').toEqual(names);

      // Ranking inside a group: the exact name beats the longer one.
      await input(win).fill('alpha');
      const projectRows = group(win, 'projects').getByRole('option');
      await expect(projectRows.first().getByText('alpha', { exact: true })).toHaveCount(1);
      await expect(projectRows.nth(1).getByText('alphabet-soup', { exact: true })).toHaveCount(1);

      // Fuzzy: a typo still finds the project; the path is a search key too.
      await input(win).fill('drakroom');
      await expect(optionFor(win, 'darkroom'), 'a transposition still matches').toHaveCount(1);
      // Hints are searchable: "⌘," finds Open Settings.
      await input(win).fill('⌘,');
      await expect(optionFor(win, 'Open Settings')).toHaveCount(1);
    });
  });

  test('AC13, AC3, AC42: more than 50 projects fill the cap; every project is reachable by typing; ">" still lists commands; the highlight scrolls into view', async () => {
    const names = Array.from({ length: PALETTE_ROW_CAP + 5 }, (_, i) => `proj-${String(i + 1).padStart(2, '0')}`);
    await withApp(names, async ({ win }) => {
      await expect.poll(async () => (await listedProjects(win)).length, { timeout: 15000 }).toBe(names.length);
      await openPalette(win);
      await expect(options(win)).toHaveCount(PALETTE_ROW_CAP);
      expect(await groupNames(win), 'the cap is filled by projects (accepted limitation)').toEqual([groupTitle('projects')]);

      // Scroll into view: walk the highlight far down the list.
      for (let i = 0; i < 40; i++) await win.keyboard.press('ArrowDown');
      const lb = await box(listbox(win));
      const hl = await box(highlighted(win));
      expect(hl.y >= lb.y - 1 && hl.y + hl.height <= lb.y + lb.height + 1, 'the highlighted row is scrolled into view').toBe(true);

      const last = names.at(-1)!;
      await expect(optionFor(win, last), `${last} is beyond the cap with an empty query`).toHaveCount(0);
      await input(win).fill(last);
      await expect(optionFor(win, last), 'typing reaches it').toHaveCount(1);

      await input(win).fill('>');
      await expect(optionFor(win, 'Open Settings'), '">" is the escape to the commands').toHaveCount(1);
    });
  });

  test('AC14: no match shows "No results" and Enter does nothing', async () => {
    await withApp(['alpha'], async ({ win }) => {
      await openProject(win, 'alpha');
      await openPalette(win);
      const q = 'zzqqxxjj';
      await input(win).fill(q);
      await expect(emptyState(win)).toHaveText(PALETTE_COPY.empty.noResults(q));
      await expect(options(win)).toHaveCount(0);
      const theme = await win.locator('html').getAttribute('data-theme');
      await win.keyboard.press('Enter');
      await expect(root(win), 'Enter with no rows keeps the palette open').toBeVisible();
      await expect(input(win)).toHaveValue(q);
      expect(await win.locator('html').getAttribute('data-theme')).toBe(theme);
      expect(await win.title()).toBe('alpha — MetaLogix IDE');
    });
  });

  test('AC15: the project list refreshes on projects:changed while open, and status dots update live', async () => {
    await withApp(['alpha', 'beta'], async ({ win }) => {
      await openPalette(win);
      await expect(optionFor(win, 'alpha'), 'positive control').toHaveCount(1);
      await expect(optionFor(win, 'beta')).toHaveCount(1);
      await expect(optionFor(win, 'beta').getByTestId(AGENT_DOT.testId), 'beta has no live shell yet').toHaveCount(0);

      const betaId = await projectIdByName(win, 'beta');
      await invoke(win, 'projects:hide', { id: betaId, hidden: true });
      await expect(optionFor(win, 'beta'), 'hiding beta removes its row while open').toHaveCount(0);
      await expect(optionFor(win, 'alpha'), 'alpha is still listed').toHaveCount(1);
      await invoke(win, 'projects:hide', { id: betaId, hidden: false });
      await expect(optionFor(win, 'beta'), 'unhiding brings it back').toHaveCount(1);

      await invoke(win, 'shells:launch-plain', { projectId: betaId });
      await expect(optionFor(win, 'beta').getByTestId(AGENT_DOT.testId), 'beta\'s dot appears live').toHaveCount(1);
      await expect(root(win)).toBeVisible();
    });
  });

  test('AC16: a command that rejects shows an error toast and closes the palette', async () => {
    await withApp(['alpha'], async ({ app, win }) => {
      await openProject(win, 'alpha');
      await failIpc(app, 'shells:kill', 'e2e: kill refused');
      await runCommand(win, 'Unload current session');
      await expect(root(win), 'the palette does not stay open').toHaveCount(0);
      const toast = win.getByTestId('toast').filter({ hasText: PALETTE_COPY.commandFailed });
      await expect(toast, 'an error toast names the failure').toHaveCount(1);
    });
  });
});

/* ─────────────────────────────── replaced overlays ─────────────────────────────── */

test.describe('replaced overlays', () => {
  test('AC18, AC43: ⌘⇧P opens the same palette with ">" and the caret after it; ⌘⇧P and ⌘P re-seed an open palette', async () => {
    await withApp(['alpha'], async ({ win }) => {
      await openProject(win, 'alpha');
      await openPalette(win, 'ControlOrMeta+Shift+P', '>');
      expect(await caret(win)).toEqual({ start: 1, end: 1, length: 1 });
      await expect(win.getByTestId(PALETTE_TESTIDS.root), 'one palette').toHaveCount(1);

      await input(win).fill('theme');
      await win.keyboard.press('ControlOrMeta+p');
      await expect(input(win), '⌘P switches an open palette to "@"').toHaveValue('@');
      expect(await caret(win)).toEqual({ start: 1, end: 1, length: 1 });
      await win.keyboard.press('ControlOrMeta+Shift+P');
      await expect(input(win), '⌘⇧P switches an open palette to ">"').toHaveValue('>');
      await expect(win.getByTestId(PALETTE_TESTIDS.root)).toHaveCount(1);
      await closePalette(win);

      await openPalette(win);
      await expect(input(win), '⌘K opens with an empty query').toHaveValue('');
    });
  });

  test('AC19: the cheat sheet lists ⌘K "Command palette" with ⌘⇧P on the same row and no switcher row; the empty state still says ⌘K', async () => {
    await withApp(['alpha'], async ({ win }) => {
      await expect(win.locator('main'), 'the no-project empty state names ⌘K').toContainText('⌘K to search');
      await win.keyboard.press('ControlOrMeta+/');
      const help = win.getByTestId('shortcuts-help');
      await expect(help).toBeVisible();
      const label = help.getByText('Command palette', { exact: true });
      await expect(label).toHaveCount(1);
      const row = label.locator('xpath=..');
      await expect(row).toContainText('⌘K');
      await expect(row).toContainText('⌘⇧P');
      await expect(help.getByText('Project switcher', { exact: true })).toHaveCount(0);
      const kbds = (await help.locator('kbd').allTextContents()).map((k) => k.trim());
      expect(kbds.filter((k) => k === '⌘⇧P'), '⌘⇧P only appears as the alternative on the palette row').toHaveLength(1);
      await expect(help.getByText('Prompt library', { exact: true }), 'positive control: other rows are still there').toHaveCount(1);
    });
  });
});

/* ─────────────────────────────── files mode ─────────────────────────────── */

/** `zqxwvk` shares no letters with any project or command, so only a file can match it. */
const UNIQUE_FILE = 'zqxwvk.txt';
const FILES = {
  'src/renderer/App.tsx': 'export const app = "needle-app";\n',
  [`notes/${UNIQUE_FILE}`]: '',
  'src/main/index.ts': 'export {};\n',
  'docs/guide.md': '# guide\n',
} as const;

test.describe('files mode ("@")', () => {
  test('AC33, AC34, AC35, AC44: "@" lists only the project\'s files, matches name and path, and opens the pick in the Files tab', async () => {
    await withApp(['alpha'], async ({ app, win, demoRoot }) => {
      writeFiles(join(demoRoot, 'alpha'), FILES);
      await openProject(win, 'alpha');
      await recordIpc(app);

      // AC44: files never appear outside "@" mode.
      await openPalette(win);
      await input(win).fill('zqxwvk');
      await expect(emptyState(win), 'normal mode has nothing for a file-only query').toHaveText(PALETTE_COPY.empty.noResults('zqxwvk'));
      await expect(optionFor(win, UNIQUE_FILE), 'normal mode lists no files').toHaveCount(0);
      await input(win).fill('@zqxwvk');
      await expect(optionFor(win, UNIQUE_FILE), 'positive control: "@" mode finds the file').toHaveCount(1);

      await input(win).fill('@');
      expect(await groupNames(win), 'a single Files heading').toEqual([groupTitle('files')]);
      const relPaths = ['notes.txt', ...Object.keys(FILES)];
      await expect(options(win)).toHaveCount(relPaths.length);
      for (const rel of relPaths) {
        const name = rel.split('/').at(-1)!;
        const row = optionFor(win, name);
        await expect(row, `${rel} is listed`).toHaveCount(1);
        await expect(row, `${rel} shows its relative path`).toContainText(rel);
      }
      await expect(optionFor(win, 'Open Settings'), 'no commands in "@" mode').toHaveCount(0);

      // Fuzzy on name and path: "apptsx" finds App.tsx (story), "renderer" matches via the path.
      await input(win).fill('@apptsx');
      await expect(options(win).first().getByText('App.tsx', { exact: true }), 'App.tsx is near the top').toHaveCount(1);
      await input(win).fill('@ renderer');
      await expect(optionFor(win, 'App.tsx'), 'leading spaces after "@" are ignored; the path matches').toHaveCount(1);

      // Leaving and re-entering "@" reuses the list (one files:list-all per open).
      await input(win).fill('x');
      await input(win).fill('@');
      await expect(options(win)).toHaveCount(relPaths.length);
      expect((await ipcLog(app)).filter((c) => c.ch === 'files:list-all'), 'the list is loaded once per open').toHaveLength(1);

      // AC35: Enter opens the highlighted file in the Files tab.
      await input(win).fill('@apptsx');
      await expect(highlighted(win).getByText('App.tsx', { exact: true })).toHaveCount(1);
      await win.keyboard.press('Enter');
      await expect(root(win)).toHaveCount(0);
      await expect(win.getByTestId('file-preview'), 'App.tsx is open in the Files tab').toContainText('needle-app');
      await expect(win.getByTestId('file-preview')).toContainText('App.tsx');
    });
  });

  test('AC34, AC36: "Indexing…" while the list loads; "Could not list files." and a console error when it fails', async () => {
    await withApp(['alpha'], async ({ app, win }) => {
      await openProject(win, 'alpha');
      const release = await holdIpc(app, 'files:list-all');
      await openPalette(win, 'ControlOrMeta+p', '@');
      await expect(emptyState(win)).toHaveText(PALETTE_COPY.empty.filesLoading);
      await release();
      await expect(optionFor(win, 'notes.txt'), 'the list arrives after loading').toHaveCount(1);
      await closePalette(win);

      const errors: string[] = [];
      win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await failIpc(app, 'files:list-all', 'e2e: listing refused');
      await openPalette(win, 'ControlOrMeta+p', '@');
      await expect(emptyState(win)).toHaveText(PALETTE_COPY.empty.filesError);
      await expect(options(win)).toHaveCount(0);
      await expect.poll(() => errors.length, { message: 'the failure is logged to the console' }).toBeGreaterThan(0);
    });
  });

  test('AC34: an index over the file limit shows the capped marker and renders at most 40 rows', async () => {
    await withApp(['alpha'], async ({ win, demoRoot }) => {
      // Empty files are cheap: one more than the limit, so files:list-all reports `truncated`.
      const dir = join(demoRoot, 'alpha', 'many');
      mkdirSync(dir);
      for (let i = 0; i <= PALETTE_FILE_LIMIT; i++) writeFileSync(join(dir, `f${i}.txt`), '');
      await openProject(win, 'alpha');
      await openPalette(win, 'ControlOrMeta+p', '@');
      await expect(win.getByTestId(PALETTE_TESTIDS.capped), 'the capped marker is visible').toBeVisible({ timeout: 15000 });
      await expect(options(win)).toHaveCount(PALETTE_FILE_CAP);
    });
  });

  test('AC36, AC37: with no project, ⌘P opens "@" mode and explains; Enter does nothing', async () => {
    await withApp(['alpha'], async ({ win }) => {
      await openPalette(win, 'ControlOrMeta+p', '@');
      expect(await caret(win)).toEqual({ start: 1, end: 1, length: 1 });
      await expect(emptyState(win)).toHaveText(PALETTE_COPY.empty.filesNoProject);
      await expect(options(win)).toHaveCount(0);
      await win.keyboard.press('Enter');
      await expect(root(win), 'Enter does nothing').toBeVisible();
      // Positive control: deleting "@" returns to normal mode, which lists the project.
      await win.keyboard.press('Backspace');
      await expect(optionFor(win, 'alpha')).toHaveCount(1);
    });
  });

  test('AC37, AC38: "Find file in project" opens "@" mode; a file query with no matches says so', async () => {
    await withApp(['alpha'], async ({ win }) => {
      await openProject(win, 'alpha');
      await runCommand(win, 'Find file in project');
      await expect(root(win)).toBeVisible();
      await expect(input(win), 'the command seeds "@"').toHaveValue('@');
      await expect(optionFor(win, 'notes.txt'), 'positive control: files are listed').toHaveCount(1);
      await input(win).fill('@zzqqxx');
      await expect(emptyState(win)).toHaveText(PALETTE_COPY.empty.noFilesMatch('zzqqxx'));
      await expect(options(win)).toHaveCount(0);
      await win.keyboard.press('Enter');
      await expect(root(win), 'Enter does nothing').toBeVisible();
    });
  });
});

/* ─────────────────────────────── prefixes ─────────────────────────────── */

test.describe('prefixes', () => {
  test('AC39: a prefix counts only as the first character, removing it returns to normal mode, and a mode change resets the highlight', async () => {
    await withApp(['alpha', 'beta'], async ({ win }) => {
      await openProject(win, 'alpha');
      await openPalette(win);
      // Same copy per mode proves which mode the palette is in.
      await input(win).fill('zz#zz');
      await expect(emptyState(win), 'a mid-query "#" is plain text').toHaveText(PALETTE_COPY.empty.noResults('zz#zz'));
      await input(win).fill('#zzzz');
      await expect(emptyState(win)).toHaveText(PALETTE_COPY.empty.noProjectsMatch('zzzz'));
      await input(win).fill('>zzzz');
      await expect(emptyState(win)).toHaveText(PALETTE_COPY.empty.noCommandsMatch('zzzz'));
      await input(win).fill('@zzzz');
      await expect(emptyState(win)).toHaveText(PALETTE_COPY.empty.noFilesMatch('zzzz'));
      await input(win).fill('!zzzz');
      await expect(emptyState(win), 'any other first character is normal mode').toHaveText(PALETTE_COPY.empty.noResults('!zzzz'));

      // Removing the prefix: "#a" → "a" on the next keystroke restores command groups.
      await input(win).fill('#a');
      expect(await groupNames(win)).toEqual([groupTitle('running'), groupTitle('projects')]);
      await input(win).press('Home');
      await input(win).press('Delete');
      await expect(input(win)).toHaveValue('a');
      await expect.poll(() => groupNames(win), { message: 'normal mode lists commands beyond the matched projects' }).not.toEqual([groupTitle('running'), groupTitle('projects')]);

      // Mode change resets the highlight to the first row.
      await input(win).fill('');
      await win.keyboard.press('ArrowDown');
      await win.keyboard.press('ArrowDown');
      const ids = await optionIds(win);
      await expect(input(win)).toHaveAttribute('aria-activedescendant', ids[2]!);
      await input(win).press('Home');
      await win.keyboard.type('>');
      await expect(input(win)).toHaveValue('>');
      const after = await optionIds(win);
      await expect(input(win), 'the highlight is back on the first row').toHaveAttribute('aria-activedescendant', after[0]!);
    });
  });

  test('AC40: the footer legend shows "@ files", "# projects", "> commands" in every mode', async () => {
    await withApp(['alpha'], async ({ win }) => {
      await openProject(win, 'alpha');
      await openPalette(win);
      const legend = win.getByTestId(PALETTE_TESTIDS.legend);
      for (const q of ['', '@', '#', '>', 'alpha']) {
        await input(win).fill(q);
        await expect(legend, `legend in ${JSON.stringify(q)}`).toBeVisible();
        await expect(legend.locator('kbd')).toHaveText(PALETTE_COPY.legend.map((l) => l.prefix));
        for (const l of PALETTE_COPY.legend) await expect(legend).toContainText(l.label);
      }
    });
  });

  test('AC41: "#" lists only Running and Projects in group order, matches the text after it, and picks like AC8', async () => {
    await withApp(['alpha', 'beta', 'lawreader'], async ({ win }) => {
      await openProject(win, 'alpha');
      await openPalette(win);
      await input(win).fill('#');
      expect(await groupNames(win)).toEqual([groupTitle('running'), groupTitle('projects')]);
      const listed = (await listedProjects(win)).map((p) => p.name);
      const grouped = ['alpha', ...listed.filter((name) => name !== 'alpha')];
      await expect(options(win)).toHaveCount(listed.length);
      for (const [i, name] of grouped.entries()) {
        await expect(options(win).nth(i).getByText(name, { exact: true })).toHaveCount(1);
      }
      await expect(optionFor(win, 'alpha'), 'the current project is marked in "#" mode').toHaveAccessibleName(/current/i);
      await expect(optionFor(win, 'beta')).not.toHaveAccessibleName(/current/i);

      await input(win).fill('#  law');
      await expect(options(win).first().getByText('lawreader', { exact: true }), 'lawreader is first').toHaveCount(1);
      await expect(optionFor(win, 'Open Settings'), 'no commands in "#" mode').toHaveCount(0);
      await win.keyboard.press('Enter');
      await expect(root(win)).toHaveCount(0);
      await waitForProjectShown(win, 'lawreader');
    });
  });

  test('AC42: ">" lists only commands and Settings in group order, with project filtering', async () => {
    await withApp(['alpha'], async ({ win }) => {
      await openProject(win, 'alpha');
      await openPalette(win, 'ControlOrMeta+Shift+P', '>');
      expect(await groupNames(win)).toEqual(GROUP_ORDER.filter((id) => id !== 'running' && id !== 'projects').map(groupTitle));
      await expect(optionFor(win, 'alpha'), 'no projects in ">" mode').toHaveCount(0);
      await expect(optionFor(win, 'notes.txt'), 'no files in ">" mode').toHaveCount(0);
      await expect(optionFor(win, 'Switch to Files tab'), 'project commands are listed with a project').toHaveCount(1);
      await input(win).fill('> zoom');
      await expect(optionFor(win, 'Zoom in')).toHaveCount(1);
      await expect(optionFor(win, 'Use dark theme'), 'the text after ">" filters').toHaveCount(0);
    });
  });
});

/* ─────────────────────────────── status bar ─────────────────────────────── */

test.describe('status bar hint', () => {
  test('AC29, AC30, AC31: one "⌘K command palette" button before the version opens the palette by click, Enter and Space', async () => {
    await withApp(['alpha'], async ({ win }) => {
      const status = win.getByTestId('status-bar');
      const hint = status.getByRole('button', { name: PALETTE_COPY.statusHintLabel, exact: true });
      await expect(hint).toHaveCount(1);
      await expect(hint).toHaveText(`${PALETTE_COPY.statusHintKey} ${PALETTE_COPY.statusHintText}`);
      await expect(status.locator('kbd')).toHaveText([PALETTE_COPY.statusHintKey]);
      const version = status.getByText(/^v\d+\.\d+\.\d+/);
      await expect(version, 'positive control: the version label is there').toBeVisible();
      expect(await hint.evaluate((h, v) => !!(h.compareDocumentPosition(v as Node) & Node.DOCUMENT_POSITION_FOLLOWING), await version.elementHandle()),
        'the hint comes before the version label').toBe(true);

      await hint.click();
      await expect(root(win)).toBeVisible();
      await expect(input(win)).toBeFocused();
      await expect(input(win)).toHaveValue('');
      await expect(optionFor(win, 'alpha'), 'same contents as ⌘K').toHaveCount(1);

      // A click on the hint while open lands on the backdrop first: never two palettes.
      const h = await box(hint);
      await win.mouse.click(h.x + h.width / 2, h.y + h.height / 2);
      await expect.poll(() => root(win).count(), { message: 'at most one palette' }).toBeLessThanOrEqual(1);
      if (await root(win).count()) await closePalette(win);

      for (const key of ['Enter', 'Space'] as const) {
        await win.keyboard.press('Shift'); // a keyboard interaction first, so focus() shows the focus-visible ring
        await hint.focus();
        await expect(hint).toBeFocused();
        expect(await hint.evaluate((el) => el.matches(':focus-visible')), 'the hint takes the global focus-visible ring').toBe(true);
        await win.keyboard.press(key);
        await expect(root(win), `${key} on the hint opens the palette`).toBeVisible();
        await expect(input(win)).toBeFocused();
        await closePalette(win);
      }
    });
  });
});
