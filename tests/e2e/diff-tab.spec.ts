import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIFF_COPY, DIFF_TESTIDS } from '../../src/renderer/diff-tab-copy';
import { PALETTE_COPY, PALETTE_TESTIDS } from '../../src/renderer/command-palette-contract';
import { ENV_TESTIDS } from '../../src/renderer/project-env-copy';
import { PROJECT_SETTINGS_COPY, PROJECT_SETTINGS_TESTIDS } from '../../src/renderer/project-settings-contract';
import {
  baseEnv, hookCredentials, installNotificationSpy, launch, notifications, openProject, postRawHook, projectId,
  waitForShell, type Api, type Harness,
} from './helpers/claude-harness';
import {
  HALF_EDIT, LINK_SECRET, LONG_EDITED_123, LONG_INSERTED, LONG_MERGED, LONG_PATH, MID_EDIT, RENAME_NEW, RENAME_OLD,
  TEXTCONV_OUTPUT, XSS_IMG, XSS_SCRIPT, commitAll, git, porcelain, programRuns, seedConflictRepo, seedRepo,
  seedRepoProgramsRepo, stagedEntries, uniquePathCount, type ScenarioName,
} from './helpers/git-repo';
import { isMacPlatform } from './helpers/chrome-colour';

/**
 * Diff tab (docs/specs/2026-10-02-1809-diff-tab.md, AC1–AC43; plan §9).
 *
 * Why this home can observe the behaviour: the suite drives the built
 * Electron app — real main process, real `git` against real repositories
 * seeded by helpers/git-repo.ts (the harness's default empty `.git` is
 * replaced), real IPC, real React. Nothing is stubbed. The only test-side
 * interventions are (a) holding or counting an IPC channel in the main
 * process (`gateIpc`), used to make a loading state or a stale list
 * deterministic and to count polls, and (b) writing files and running git
 * from the test process, which is what a shell or an agent would do.
 *
 * Selectors and strings come only from DIFF_COPY / DIFF_TESTIDS plus the
 * `data-type`, `data-path`, `data-group` and `aria-current` attributes they
 * document. Line-cell geometry (`readSide`) pairs each `diff-line` cell with
 * its `diff-gutter` by containment or, failing that, by equal row top, so
 * the suite does not depend on how the gutter is nested.
 */

const PROJ = 'diffproj';
const OTHER = 'diffother';
/** One poll interval (3 s) plus margin; AC21 allows up to 4 s. */
const POLL_WINDOW = 5500;

let h: Harness | undefined;

test.afterEach(async () => {
  await h?.app.close();
  h?.cleanup();
  h = undefined;
});

/* ═══════════════════════════════ setup helpers ═══════════════════════════════ */

function projDir(name = PROJ): string {
  return join(h!.demoRoot, name);
}

/** Launches with PROJ (and OTHER), seeds PROJ with `scenarios`, opens PROJ on the Shell tab. */
async function setup(scenarios: ScenarioName[], opts: { other?: boolean } = {}): Promise<Page> {
  h = await launch(opts.other ? [PROJ, OTHER] : [PROJ]);
  seedRepo({ dir: projDir(), outside: join(h.isolatedHome, 'outside') }, scenarios);
  await openProject(h.win, PROJ);
  return h.win;
}

/** Selects a project from the sidebar without waiting for a terminal (none mounts on the Diff tab). */
async function selectProject(win: Page, name: string): Promise<void> {
  const row = win.locator('[data-testid="project-row"]').filter({ has: win.getByText(name, { exact: true }) }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect.poll(() => win.title(), { timeout: 10000 }).toBe(`${name} — MetaLogix IDE`);
}

const panelOf = (win: Page): Locator => win.getByTestId(DIFF_TESTIDS.panel);
const paneOf = (win: Page): Locator => win.getByTestId(DIFF_TESTIDS.pane);
const sideOf = (win: Page, side: 'old' | 'new'): Locator =>
  win.getByTestId(side === 'old' ? DIFF_TESTIDS.sideOld : DIFF_TESTIDS.sideNew);
const rowsOf = (win: Page): Locator => panelOf(win).getByTestId(DIFF_TESTIDS.row);

function rowOf(win: Page, path: string, group?: 'staged' | 'unstaged' | 'untracked'): Locator {
  const g = group ? `[data-group="${group}"]` : '';
  return panelOf(win).locator(`[data-testid="${DIFF_TESTIDS.row}"][data-path=${JSON.stringify(path)}]${g}`);
}

/** Rows whose aria-current marks them selected. */
function selectedRows(win: Page): Locator {
  return panelOf(win).locator(`[data-testid="${DIFF_TESTIDS.row}"][aria-current]:not([aria-current="false"])`);
}

/** A line cell on one side whose text contains `text`. */
function cell(win: Page, side: 'old' | 'new', text: string): Locator {
  return sideOf(win, side).getByTestId(DIFF_TESTIDS.line).filter({ hasText: text });
}

async function openDiffTab(win: Page): Promise<Locator> {
  await win.getByTestId(DIFF_TESTIDS.tab).click();
  const panel = panelOf(win);
  await expect(panel).toBeVisible();
  await expect(panel.getByText(DIFF_COPY.loadingList, { exact: true })).toHaveCount(0, { timeout: 10000 });
  return panel;
}

/** Clicks a row and waits until it is the selected one and its diff has finished loading. */
async function selectRow(win: Page, path: string, group?: 'staged' | 'unstaged' | 'untracked'): Promise<void> {
  const row = rowOf(win, path, group);
  await row.click();
  await expect(row).toHaveAttribute('aria-current', /^(?!false$).+/);
  await expect(panelOf(win).getByText(DIFF_COPY.loadingDiff, { exact: true })).toHaveCount(0, { timeout: 10000 });
}

interface CellInfo { type: string | null; text: string; num: string; top: number; height: number; bg: string; userSelect: string }

/** Every line cell of one side, in DOM order, with its gutter number, row top and tint. */
async function readSide(win: Page, side: 'old' | 'new'): Promise<CellInfo[]> {
  return win.evaluate(({ ids, sideId }) => {
    const sideEl = document.querySelector(`[data-testid="${sideId}"]`);
    if (!sideEl) return [];
    const gutters = [...sideEl.querySelectorAll(`[data-testid="${ids.gutter}"]`)];
    return [...sideEl.querySelectorAll(`[data-testid="${ids.line}"]`)].map((el) => {
      const r = el.getBoundingClientRect();
      const g = gutters.find((x) => el.contains(x))
        ?? gutters.find((x) => Math.abs(x.getBoundingClientRect().top - r.top) < 1);
      // The code text sits in the cell's <code>; the gutter and the +/- marker are siblings of it.
      const code = el.querySelector("code");
      const gs = g ? getComputedStyle(g) : null;
      return {
        type: el.getAttribute('data-type'),
        text: code?.textContent ?? '',
        num: (g?.textContent ?? '').trim(),
        top: Math.round(r.top),
        height: Math.round(r.height),
        bg: getComputedStyle(el).backgroundColor,
        userSelect: gs ? (gs.userSelect || gs.getPropertyValue('-webkit-user-select')) : '',
      };
    });
  }, { ids: DIFF_TESTIDS, sideId: side === 'old' ? DIFF_TESTIDS.sideOld : DIFF_TESTIDS.sideNew });
}

/** Distinct row tops of the separators in the pane (one separator may span both sides or sit on each). */
async function separatorTops(win: Page): Promise<number[]> {
  const tops = await paneOf(win).getByTestId(DIFF_TESTIDS.separator)
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  return [...new Set(tops)].sort((a, b) => a - b);
}

const TRANSPARENT = /^(transparent|rgba\(0, 0, 0, 0\))$/;

/** `hljs-*` spans inside a locator (any highlight.js scope class). */
async function hljsSpanCount(loc: Locator): Promise<number> {
  return loc.evaluate((el) => el.querySelectorAll('[class*="hljs-"]').length);
}

/** True if a descendant `.hljs-<scope>` of the cell contains `text`. */
async function scopeHolds(cellLoc: Locator, scope: string, text: string): Promise<boolean> {
  return cellLoc.evaluate((el, a) => [...el.querySelectorAll(`.hljs-${a.scope}`)]
    .some((s) => (s.textContent ?? '').includes(a.text)), { scope, text });
}

/* ═══════════════════════════════ main-process IPC gate ═══════════════════════════════ */

/**
 * Wraps one IPC channel's handler in the main process so a test can count its
 * calls and hold them pending. It swaps the entry in Electron's private
 * `ipcMain._invokeHandlers` map (the stored wrapper replies via the event, so
 * the original stays in charge of the reply). Throws, naming the cause, if
 * that internal map is absent.
 */
async function gateIpc(app: ElectronApplication, channel: string): Promise<void> {
  await app.evaluate(({ ipcMain }, ch) => {
    type Fn = (e: unknown, ...args: unknown[]) => unknown;
    const map = (ipcMain as unknown as { _invokeHandlers?: Map<string, Fn> })._invokeHandlers;
    if (!map || !map.has(ch)) {
      throw new Error(`gateIpc: ipcMain._invokeHandlers has no "${ch}" (Electron internals changed?); the gate cannot be installed`);
    }
    const orig = map.get(ch)!;
    const gate = { calls: 0, held: false, waiters: [] as Array<() => void> };
    const g = globalThis as unknown as { __e2eGates?: Record<string, typeof gate> };
    g.__e2eGates = { ...(g.__e2eGates ?? {}), [ch]: gate };
    map.set(ch, async (e: unknown, ...args: unknown[]) => {
      gate.calls++;
      if (gate.held) await new Promise<void>((r) => gate.waiters.push(r));
      return orig(e, ...args);
    });
  }, channel);
}

async function gateCalls(app: ElectronApplication, channel: string): Promise<number> {
  return app.evaluate((_e, ch) => (globalThis as unknown as { __e2eGates: Record<string, { calls: number }> }).__e2eGates[ch]!.calls, channel);
}

async function setHeld(app: ElectronApplication, channel: string, held: boolean): Promise<void> {
  await app.evaluate((_e, a) => {
    const gate = (globalThis as unknown as { __e2eGates: Record<string, { held: boolean; waiters: Array<() => void> }> }).__e2eGates[a.ch]!;
    gate.held = a.held;
    if (!a.held) gate.waiters.splice(0).forEach((r) => r());
  }, { ch: channel, held });
}

/* ═══════════════════════════════ observers ═══════════════════════════════ */

/**
 * Starts recording, in the page: DOM mutations inside the pane, whether
 * "Loading diff…" ever appeared in the panel, and tags the pane element so a
 * later check can tell whether it was replaced.
 */
async function watchPane(win: Page): Promise<void> {
  await win.evaluate((a) => {
    const w = window as unknown as { __paneWatch?: { mutations: number; sawLoading: boolean; stop: () => void } };
    w.__paneWatch?.stop();
    const panel = document.querySelector(`[data-testid="${a.panel}"]`)!;
    const pane = document.querySelector(`[data-testid="${a.pane}"]`)!;
    pane.setAttribute('data-e2e-tag', 'watched');
    const state = { mutations: 0, sawLoading: false, stop: () => { mo.disconnect(); po.disconnect(); } };
    const mo = new MutationObserver((recs) => { state.mutations += recs.filter((r) => r.attributeName !== 'data-e2e-tag').length; });
    mo.observe(pane, { subtree: true, childList: true, characterData: true, attributes: true });
    const po = new MutationObserver(() => { if ((panel.textContent ?? '').includes(a.loading)) state.sawLoading = true; });
    po.observe(panel, { subtree: true, childList: true, characterData: true });
    w.__paneWatch = state;
  }, { panel: DIFF_TESTIDS.panel, pane: DIFF_TESTIDS.pane, loading: DIFF_COPY.loadingDiff });
}

async function paneWatch(win: Page): Promise<{ mutations: number; sawLoading: boolean; sameElement: boolean }> {
  return win.evaluate((paneId) => {
    const w = window as unknown as { __paneWatch: { mutations: number; sawLoading: boolean } };
    const pane = document.querySelector(`[data-testid="${paneId}"]`);
    return { mutations: w.__paneWatch.mutations, sawLoading: w.__paneWatch.sawLoading, sameElement: pane?.getAttribute('data-e2e-tag') === 'watched' };
  }, DIFF_TESTIDS.pane);
}

/* ═══════════════════════════════ misc ═══════════════════════════════ */

async function terminalActiveIn(win: Page, containerSelector: string): Promise<boolean> {
  return win.evaluate((sel: string) => {
    const el = document.activeElement;
    if (!el || !(el instanceof HTMLElement)) return false;
    if (!el.classList.contains('xterm-helper-textarea')) return false;
    return !!el.closest(sel);
  }, containerSelector);
}

/** Closes the app and launches it again on the same HOME and user-data dir (AC3). */
async function relaunch(): Promise<Page> {
  const cur = h!;
  await cur.app.close();
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${join(cur.isolatedHome, 'userData')}`],
    env: {
      ...baseEnv(),
      HOME: cur.isolatedHome,
      SHELL: '/bin/sh',
      METAIDE_TEST_MODE: '1',
      METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
      METAIDE_DEFAULT_LAUNCH_FIRST: JSON.stringify({ argv: [cur.shimPath], env: {} }),
      METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: [cur.shimPath, '--continue'], env: {} }),
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1400, 900); });
  cur.app = app;
  cur.win = win;
  return win;
}

/**
 * Shrinks the window so the long.ts diff (~35 rows, ~700 px) overflows the pane; at the harness's
 * 900 px height the pane is ~804 px tall and the diff fits, so there would be nothing to scroll.
 */
async function shortenWindow(): Promise<void> {
  await h!.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1400, 560); });
  await expect.poll(() => h!.win.evaluate(() => window.innerHeight)).toBeLessThan(600);
}

/**
 * Gives the main window OS focus and waits until Electron reports it focused. On macOS a plain
 * focus() is refused while another app is frontmost, so the app first takes activation with
 * app.focus({ steal: true }).
 */
async function focusMain(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    electronApp.focus({ steal: true });
    const w = BrowserWindow.getAllWindows()[0]!;
    w.show();
    w.focus();
  });
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFocused()), {
    timeout: 3000, message: 'main window holds focus',
  }).toBe(true);
}

/** Computed fill of a tab button (the active tab wears the accent tint). */
async function tabFill(loc: Locator): Promise<string> {
  return loc.evaluate((el) => getComputedStyle(el).backgroundColor);
}

/* ═══════════════════════════════ 1. placement ═══════════════════════════════ */

test('tab bar keeps existing tabs in order with Project settings immediately after Env; Diff activates with the shared active fill (AC1, AC2)', async () => {
  const win = await setup(['aTs'], { other: true });
  const tabBar = win.getByTestId(DIFF_TESTIDS.tabBar);
  const checkOrder = async () => {
    const buttons = tabBar.locator('button');
    await expect(buttons.nth(0)).toHaveText('Shell');
    await expect(buttons.nth(1)).toHaveText('Files');
    await expect(buttons.nth(2)).toHaveAttribute('data-testid', DIFF_TESTIDS.tab);
    await expect(buttons.nth(2)).toContainText(DIFF_COPY.tabLabel);
    await expect(buttons.nth(3)).toHaveAttribute('data-testid', ENV_TESTIDS.tab);
    await expect(buttons.nth(4)).toHaveAttribute('data-testid', PROJECT_SETTINGS_TESTIDS.tab);
    await expect(buttons.nth(4)).toHaveText(PROJECT_SETTINGS_COPY.tab);
  };
  await checkOrder();

  const shell = tabBar.getByRole('button', { name: 'Shell', exact: true });
  const files = tabBar.getByRole('button', { name: 'Files', exact: true });
  const diff = win.getByTestId(DIFF_TESTIDS.tab);
  const activeColour = await tabFill(shell);
  const inactiveColour = await tabFill(files);
  expect(activeColour, 'control: active and inactive tab fills differ').not.toBe(inactiveColour);

  await diff.click();
  await expect(panelOf(win)).toBeVisible();
  await expect(win.locator('[data-testid="shell-tab"]'), 'the Shell body is gone').toHaveCount(0);
  // The tab buttons animate their colours (transition-colors), so wait for the transition to settle.
  await expect.poll(() => tabFill(diff), { message: 'Diff wears the active fill' }).toBe(activeColour);
  await expect.poll(() => tabFill(shell), { message: 'Shell is now inactive' }).toBe(inactiveColour);

  // The other project (harness-default, not seeded) shows the same tab bar.
  await selectProject(win, OTHER);
  await checkOrder();
  await expect(panelOf(win)).toBeVisible();
});

test('command palette "Switch to Diff tab" activates the Diff tab (AC4)', async () => {
  const win = await setup(['aTs']);
  await expect(panelOf(win)).toHaveCount(0);
  await win.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  });
  const palette = win.getByTestId(PALETTE_TESTIDS.root);
  await palette.getByPlaceholder(PALETTE_COPY.placeholder).fill(`>${DIFF_COPY.paletteTitle}`);
  await palette.getByText(DIFF_COPY.paletteTitle, { exact: true }).click();
  await expect(panelOf(win)).toBeVisible();
  await expect(win.locator('[data-testid="shell-tab"]')).toHaveCount(0);
});

test('a Claude notification is not suppressed while the Diff tab is showing (AC5)', async () => {
  h = await launch([PROJ]);
  const { app, win, isolatedHome } = h;
  await installNotificationSpy(app);
  await openProject(win, PROJ);
  const id = await projectId(win, PROJ);
  await waitForShell(win, id, 0, 'mock-claude ready');
  const creds = await hookCredentials(win, isolatedHome, id, 0);

  // Suppression needs the main window to hold OS focus, which another app can take between
  // specs; focus it explicitly (same show()/focus() + isFocused() poll as claude-notifications).
  await focusMain(app);
  // Control: on the Shell tab, viewing shell 0, the event is suppressed.
  await postRawHook(creds, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'viewed on Shell' });
  await win.waitForTimeout(2000);
  expect(await notifications(app), 'suppressed while the shell is viewed').toHaveLength(0);

  await win.getByTestId(DIFF_TESTIDS.tab).click();
  await expect(panelOf(win)).toBeVisible();
  // The viewed-shell report is sent asynchronously over IPC (see openProject).
  await win.waitForTimeout(500);
  // Still focused, so a notification now comes from the Diff tab rule, not from losing focus.
  await focusMain(app);
  await postRawHook(creds, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'while on Diff' });
  await expect.poll(() => notifications(app), { timeout: 5000 }).toHaveLength(1);
});

/* ═══════════════════════════════ 2. file list ═══════════════════════════════ */

test('list: groups in order with counts, status letters in Git panel colours, b.ts twice, untracked one by one, full path on hover (AC7–AC11, AC19)', async () => {
  const win = await setup(['aTs', 'bTs', 'rename', 'untracked', 'gone', 'added', 'long', 'longPath']);
  const panel = await openDiffTab(win);
  const expected = {
    staged: [['a.ts', 'M'], ['added.ts', 'A'], ['b.ts', 'M'], ['gone.ts', 'D'], [RENAME_NEW, 'R']],
    unstaged: [['b.ts', 'M'], ['long.ts', 'M']],
    untracked: [['dir/sub/u1.txt', '?'], ['dir/u2.txt', '?'], [LONG_PATH, '?']],
  } as const;

  // AC7: three groups, in order, each header with its label and count.
  const groups = panel.getByTestId(DIFF_TESTIDS.group);
  await expect(groups).toHaveCount(3);
  const order = ['staged', 'unstaged', 'untracked'] as const;
  for (const [i, g] of order.entries()) {
    await expect(groups.nth(i)).toHaveAttribute('data-group', g);
    await expect(groups.nth(i)).toContainText(new RegExp(`${DIFF_COPY.group[g]}\\D*${expected[g].length}(?!\\d)`));
    await expect(rowsOf(win).and(panel.locator(`[data-group="${g}"]`))).toHaveCount(expected[g].length);
  }

  // AC8, AC9, AC10: each row's path and letter; b.ts once per group; no collapsed folder row.
  for (const g of order) {
    for (const [path, letter] of expected[g]) {
      const row = rowOf(win, path, g);
      await expect(row, `${g} ${path}`).toHaveCount(1);
      await expect(row.getByTestId(DIFF_TESTIDS.rowStatus)).toHaveText(letter);
    }
  }
  await expect(rowOf(win, 'b.ts')).toHaveCount(2);
  await expect(rowOf(win, 'dir')).toHaveCount(0);
  await expect(rowOf(win, 'dir/')).toHaveCount(0);
  await expect(rowsOf(win)).toHaveCount(10);

  // AC11: the long path is cut off in the row; the full path is on hover.
  const longRow = rowOf(win, LONG_PATH);
  await expect(longRow).toHaveAttribute('title', new RegExp(LONG_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const truncated = await longRow.evaluate((el) => [el, ...el.querySelectorAll('*')]
    .some((n) => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflow !== 'visible'));
  expect(truncated, 'some element in the long row clips its text').toBe(true);

  // AC19: the rename row shows the new path; the old path is on hover.
  const renameRow = rowOf(win, RENAME_NEW, 'staged');
  await expect(renameRow).toContainText(RENAME_NEW);
  await expect(renameRow).toHaveAttribute('title', new RegExp(DIFF_COPY.renamedFrom(RENAME_OLD).replace(/[.]/g, '\\.')));

  // AC8: each letter has the Git panel's colour for the same file. M/A/D/?
  // paint `var(--git-*, <Tailwind -400>)` (git-status-style.ts
  // STATUS_TEXT_CLASS) and R falls back to `text-[--text-muted]`. Off macOS
  // nothing sets those tokens, so both surfaces match. On macOS the Git panel
  // is chrome (D10): D2 lifts `--text-muted` and D16 lifts the `--git-*`
  // letters there (docs/specs/macos-frosted-chrome.md), while the Diff tab is
  // working area and keeps the -400 hues, so on mac every Git panel letter
  // is expected to be the panel's live-resolved lifted token instead.
  const tabColours: Record<string, string> = {};
  for (const [path, g] of [['a.ts', 'staged'], ['added.ts', 'staged'], ['gone.ts', 'staged'], ['dir/u2.txt', 'untracked'], [RENAME_NEW, 'staged']] as const) {
    tabColours[path] = await rowOf(win, path, g).getByTestId(DIFF_TESTIDS.rowStatus).evaluate((el) => getComputedStyle(el).color);
  }
  await win.getByTestId('ab-git').click();
  const gitView = win.locator('[data-view="git"]');
  const mac = await isMacPlatform(win);
  // On mac, each row's colour token as the Git panel resolves it (a probe
  // inside the panel inherits the chrome root's lifts through the cascade, so
  // this is the real painted value, not a literal), and the -400 hue the
  // Diff tab must keep.
  const rowTokens: Record<string, { token: string; tab: string | null }> = {
    'a.ts': { token: '--git-modified', tab: 'rgb(251, 191, 36)' },
    'added.ts': { token: '--git-added', tab: 'rgb(52, 211, 153)' },
    'gone.ts': { token: '--git-deleted', tab: 'rgb(251, 113, 133)' },
    'dir/u2.txt': { token: '--git-untracked', tab: 'rgb(56, 189, 248)' },
    [RENAME_NEW]: { token: '--text-muted', tab: null },
  };
  const gitLifted: Record<string, string> = {};
  if (mac) {
    for (const [path, { token }] of Object.entries(rowTokens)) {
      gitLifted[path] = await gitView.evaluate((el, t) => {
        const probe = document.createElement('span');
        probe.style.color = `var(${t})`;
        el.appendChild(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      }, token);
    }
  }
  for (const [path, colour] of Object.entries(tabColours)) {
    const letter = gitView.locator(`button[title=${JSON.stringify(`Toggle diff for ${path}`)}]`).first().locator('xpath=preceding-sibling::span[1]');
    await expect(letter, `Git panel row for ${path}`).toBeVisible();
    const expected = mac ? gitLifted[path]! : colour;
    expect(await letter.evaluate((el) => getComputedStyle(el).color), `${path} letter colour`).toBe(expected);
  }
  if (mac) {
    for (const [path, { tab }] of Object.entries(rowTokens))
      if (tab !== null) expect(tabColours[path], `${path} Diff tab letter keeps its Tailwind -400 hue`).toBe(tab);
    // Positive control: the mac branch above is only meaningful if the lifted
    // colour actually differs from the Diff tab's unlifted one, or it would
    // pass vacuously even if D2/D16 broke. D and R are lifted in every
    // palette and theme; M/A/? keep -400 where it already clears 4.5:1.
    for (const path of ['gone.ts', RENAME_NEW])
      expect(gitLifted[path], `control: the Git panel (chrome) ${path} colour is lifted away from the Diff tab (working area) one`)
        .not.toBe(tabColours[path]);
  }
});

test('a merge-conflicted file is listed under Staged and Changes as U, counted once, and its diff loads (AC9, AC25, AC34)', async () => {
  h = await launch([PROJ]);
  seedConflictRepo(projDir());
  const win = h.win;
  await openProject(win, PROJ);
  await openDiffTab(win);
  await expect(rowOf(win, 'conflict.txt', 'staged').getByTestId(DIFF_TESTIDS.rowStatus)).toHaveText('U');
  await expect(rowOf(win, 'conflict.txt', 'unstaged').getByTestId(DIFF_TESTIDS.rowStatus)).toHaveText('U');
  await expect(rowsOf(win)).toHaveCount(2);
  await expect(win.getByTestId(DIFF_TESTIDS.tabCount)).toHaveText(/(^|\D)1(\D|$)/, { timeout: 9000 });

  for (const g of ['staged', 'unstaged'] as const) {
    await selectRow(win, 'conflict.txt', g);
    await expect(panelOf(win).getByText(DIFF_COPY.loadingDiff, { exact: true })).toHaveCount(0);
    await expect(paneOf(win), `${g} conflict entry shows a pane`).toBeVisible();
  }
});

/* ═══════════════════════════════ 3. selection ═══════════════════════════════ */

test('the first row is selected on open; a click or Enter selects one row and shows its diff (AC12, AC13)', async () => {
  const win = await setup(['aTs', 'long', 'untracked']);
  const panel = await openDiffTab(win);

  // AC12: the first row of the first group is selected and shown.
  const firstRow = panel.getByTestId(DIFF_TESTIDS.group).first().getByTestId(DIFF_TESTIDS.row).first();
  await expect(firstRow).toHaveAttribute('data-path', 'a.ts');
  await expect(firstRow).toHaveAttribute('aria-current', /^(?!false$).+/);
  await expect(selectedRows(win)).toHaveCount(1);
  await expect(cell(win, 'new', 'const base = 2;')).toBeVisible();

  // AC13: clicking another row moves the single selection and its diff.
  await selectRow(win, 'long.ts');
  await expect(selectedRows(win)).toHaveCount(1);
  await expect(firstRow).not.toHaveAttribute('aria-current', /^(?!false$).+/);
  await expect(cell(win, 'new', LONG_EDITED_123)).toBeVisible();
  await expect(cell(win, 'new', 'const base = 2;')).toHaveCount(0);

  // Rows are reachable and selectable from the keyboard.
  const u2 = rowOf(win, 'dir/u2.txt');
  await u2.focus();
  await win.keyboard.press('Enter');
  await expect(u2).toHaveAttribute('aria-current', /^(?!false$).+/);
  await expect(cell(win, 'new', 'second untracked')).toBeVisible();
  await expect(selectedRows(win)).toHaveCount(1);
});

/* ═══════════════════════════════ 4. split view ═══════════════════════════════ */

test('split view: sides per entry kind, no git headers, separators around hunks, tints (AC14, AC15, AC19, AC34)', async () => {
  const win = await setup(['aTs', 'bTs', 'long', 'untracked', 'gone', 'added', 'rename']);
  await openDiffTab(win);

  // Staged edit: HEAD on the left, index on the right; header lines are not code rows.
  await selectRow(win, 'a.ts', 'staged');
  await expect(sideOf(win, 'old')).toBeVisible();
  await expect(sideOf(win, 'new')).toBeVisible();
  await expect(cell(win, 'old', 'const base = 1;')).toHaveAttribute('data-type', 'removed');
  await expect(cell(win, 'new', 'const base = 2;')).toHaveAttribute('data-type', 'added');
  const paneText = await paneOf(win).innerText();
  for (const header of ['diff --git', '@@', 'index ', '+++ b/', '--- a/']) {
    expect(paneText, `no "${header}" text in the pane`).not.toContain(header);
  }

  // AC15 tints: removed and added are tinted and differ; context has no tint.
  const left = await readSide(win, 'old');
  const right = await readSide(win, 'new');
  const removed = left.find((c) => c.type === 'removed')!;
  const added = right.find((c) => c.type === 'added')!;
  const context = left.find((c) => c.type === 'context')!;
  expect(context, 'control: a.ts has context rows').toBeTruthy();
  expect(removed.bg).not.toMatch(TRANSPARENT);
  expect(added.bg).not.toMatch(TRANSPARENT);
  expect(removed.bg).not.toBe(added.bg);
  expect(context.bg).toMatch(TRANSPARENT);

  // b.ts staged = HEAD vs index; unstaged = index vs worktree (AC34).
  await selectRow(win, 'b.ts', 'staged');
  await expect(cell(win, 'old', "'one'")).toHaveAttribute('data-type', 'removed');
  await expect(cell(win, 'new', "'two'")).toHaveAttribute('data-type', 'added');
  await selectRow(win, 'b.ts', 'unstaged');
  await expect(cell(win, 'old', "'two'")).toHaveAttribute('data-type', 'removed');
  await expect(cell(win, 'new', "'three'")).toHaveAttribute('data-type', 'added');
  await expect(cell(win, 'old', "'one'")).toHaveCount(0);

  // AC14 separators: before the first hunk (it starts at line 8), between hunks, none after the last.
  await selectRow(win, 'long.ts');
  const seps = await separatorTops(win);
  expect(seps).toHaveLength(3);
  const longLeft = await readSide(win, 'old');
  const lineTops = longLeft.map((c) => c.top);
  expect(Math.min(...seps), 'a separator precedes the first hunk').toBeLessThan(Math.min(...lineTops));
  expect(Math.max(...seps), 'no separator after the last hunk').toBeLessThan(Math.max(...lineTops));
  await expect(paneOf(win).getByTestId(DIFF_TESTIDS.separator).first()).toContainText(DIFF_COPY.hiddenLines);

  // Untracked and staged-added: empty left, the whole file on the right, every line added.
  for (const [path, lines] of [['dir/u2.txt', ['second untracked']], ['added.ts', ['export const fresh1 = 1;', 'export const fresh2 = 2;']]] as const) {
    await selectRow(win, path);
    const l = await readSide(win, 'old');
    const r = await readSide(win, 'new');
    expect(l.filter((c) => c.type !== 'filler'), `${path}: left side is empty`).toEqual([]);
    expect(l.filter((c) => c.num !== ''), `${path}: no left line numbers`).toEqual([]);
    expect(r.map((c) => c.type), `${path}: every right line is added`).toEqual(lines.map(() => 'added'));
    expect(r.map((c) => c.text.trim())).toEqual([...lines]);
  }

  // Deleted: the whole old file on the left, every line removed; right empty.
  await selectRow(win, 'gone.ts');
  const gl = await readSide(win, 'old');
  const gr = await readSide(win, 'new');
  expect(gl.map((c) => c.type)).toEqual(['removed', 'removed', 'removed']);
  expect(gl.map((c) => c.text.trim())).toEqual(['export const g1 = 1;', 'export const g2 = 2;', 'export const g3 = 3;']);
  expect(gr.filter((c) => c.type !== 'filler'), 'gone.ts: right side is empty').toEqual([]);

  // AC19: a staged rename shows a diff, old path on the left, new on the right.
  await selectRow(win, RENAME_NEW, 'staged');
  await expect(cell(win, 'old', 'export const six = 6;')).toHaveAttribute('data-type', 'removed');
  await expect(cell(win, 'new', 'export const six = 66;')).toHaveAttribute('data-type', 'added');
  await expect(win.getByTestId(DIFF_TESTIDS.error)).toHaveCount(0);
});

test('alignment: rows share tops, real line numbers 120/124, 3-for-1 pairs once then fillers, gutter not selectable (AC35, AC36)', async () => {
  const win = await setup(['long']);
  await openDiffTab(win);
  await selectRow(win, 'long.ts');
  const left = await readSide(win, 'old');
  const right = await readSide(win, 'new');

  expect(left.length, 'control: rows rendered').toBeGreaterThan(20);
  expect(right.length).toBe(left.length);
  left.forEach((c, i) => expect(right[i]!.top, `row ${i} aligned`).toBe(c.top));

  // AC36: the second hunk's first row is old 120 / new 124, preceded by a separator.
  const i120 = left.findIndex((c) => c.text.trim() === 'export const v120 = 120;');
  expect(i120).toBeGreaterThan(0);
  expect(left[i120]!.num).toBe('120');
  expect(right[i120]!.num).toBe('124');
  expect(right[i120]!.text.trim()).toBe('export const v120 = 120;');
  const seps = await separatorTops(win);
  expect(seps.some((t) => t > left[i120 - 1]!.top && t < left[i120]!.top), 'a separator sits right above old line 120').toBe(true);

  // AC35: the 3-for-1 block pairs once, then two removed lines face fillers.
  const j = left.findIndex((c) => c.text.trim() === 'export const v180 = 180;');
  expect(left.slice(j, j + 3).map((c) => c.type)).toEqual(['removed', 'removed', 'removed']);
  expect(right.slice(j, j + 3).map((c) => c.type)).toEqual(['added', 'filler', 'filler']);
  expect(right[j]!.text.trim()).toBe(LONG_MERGED);
  expect(right.slice(j + 1, j + 3).map((c) => c.num), 'fillers have no number').toEqual(['', '']);
  expect(right.slice(j + 1, j + 3).map((c) => c.text.trim()), 'fillers are empty').toEqual(['', '']);

  // The four inserted lines face left fillers.
  const k = right.findIndex((c) => c.text.trim() === LONG_INSERTED[0]);
  expect(right.slice(k, k + 4).map((c) => c.type)).toEqual(['added', 'added', 'added', 'added']);
  expect(left.slice(k, k + 4).map((c) => c.type)).toEqual(['filler', 'filler', 'filler', 'filler']);

  // Fillers: a neutral fill, neither the removed nor the added tint.
  const filler = right[j + 1]!;
  expect(filler.bg).not.toMatch(TRANSPARENT);
  expect(filler.bg).not.toBe(left[j]!.bg);
  expect(filler.bg).not.toBe(right[j]!.bg);

  // AC36: gutters cannot be selected with the code.
  const withNumber = left.filter((c) => c.num !== '');
  expect(withNumber.length).toBeGreaterThan(0);
  expect(new Set(withNumber.map((c) => c.userSelect))).toEqual(new Set(['none']));
});

test('scrolling: one vertical scroll keeps sides aligned, list scrolls on its own, long lines scroll per side without wrapping (AC16)', async () => {
  const win = await setup(['long', 'wide', 'many']);
  await shortenWindow();
  const panel = await openDiffTab(win);
  await selectRow(win, 'long.ts');
  const pane = paneOf(win);
  // diff-file-list is the <ul>; the element that scrolls is its nearest scrollable ancestor.
  await panel.getByTestId(DIFF_TESTIDS.list).evaluate((el) => {
    let n: HTMLElement | null = el as HTMLElement;
    while (n && !/auto|scroll/.test(getComputedStyle(n).overflowY)) n = n.parentElement;
    if (!n) throw new Error('no scrollable ancestor of the file list');
    n.setAttribute('data-e2e-listscroll', '');
  });
  const list = panel.locator('[data-e2e-listscroll]');
  expect(await list.evaluate((el, paneId) => el.contains(document.querySelector(`[data-testid="${paneId}"]`)), DIFF_TESTIDS.pane), 'the list scroller does not contain the pane').toBe(false);

  const metrics = (loc: Locator) => loc.evaluate((el) => ({ top: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight }));
  expect((await metrics(pane)).sh, 'control: the long diff overflows the pane').toBeGreaterThan((await metrics(pane)).ch);
  expect((await metrics(list)).sh, 'control: 60+ rows overflow the list').toBeGreaterThan((await metrics(list)).ch);

  const before = await readSide(win, 'old');
  await pane.evaluate((el) => { el.scrollTop = 150; });
  await expect.poll(async () => (await readSide(win, 'old'))[0]!.top).not.toBe(before[0]!.top);
  // The browser clamps scrollTop to the overflow, so read back where the pane actually sits.
  const paneTop = (await metrics(pane)).top;
  expect(paneTop, 'control: the pane scrolled').toBeGreaterThan(0);
  const l = await readSide(win, 'old');
  const r = await readSide(win, 'new');
  l.forEach((c, i) => expect(r[i]!.top, `row ${i} aligned after scroll`).toBe(c.top));
  expect((await metrics(list)).top, 'the list did not scroll with the pane').toBe(0);
  for (const s of ['old', 'new'] as const) {
    expect(await sideOf(win, s).evaluate((el) => el.scrollTop), `${s} side has no vertical scroll of its own`).toBe(0);
  }

  await list.evaluate((el) => { el.scrollTop = 200; });
  await expect.poll(async () => (await metrics(list)).top).toBeGreaterThan(0);
  expect((await metrics(pane)).top, 'the pane did not scroll with the list').toBe(paneTop);

  // Long lines: no wrap, and each side scrolls horizontally under its own column.
  await selectRow(win, 'wide.ts');
  const wideCell = cell(win, 'new', 'x'.repeat(50));
  await expect(wideCell).toBeVisible();
  expect(await wideCell.evaluate((el) => getComputedStyle(el.querySelector("code") ?? el).whiteSpace)).toMatch(/^pre/);
  const rows = await readSide(win, 'new');
  const wide = rows.find((c) => c.text.includes('x'.repeat(400)))!;
  const normal = rows.find((c) => c.text.includes('tail'))!;
  expect(wide.height, 'the 400-char line does not wrap').toBe(normal.height);

  const scrollerOf = (s: 'old' | 'new') => sideOf(win, s).evaluate((side) => {
    const all = [side, ...side.querySelectorAll('*')];
    const sc = all.find((n) => /auto|scroll/.test(getComputedStyle(n).overflowX) && n.scrollWidth > n.clientWidth);
    if (!sc) return null;
    sc.setAttribute('data-e2e-hscroll', side.getAttribute('data-testid') ?? '');
    return { sw: sc.scrollWidth, cw: sc.clientWidth };
  });
  const newScroller = await scrollerOf('new');
  expect(newScroller, 'the After side has a horizontal scroller that overflows').not.toBeNull();
  expect(await scrollerOf('old'), 'the Before side has its own horizontal scroller').not.toBeNull();
  await win.evaluate((id) => { document.querySelector(`[data-e2e-hscroll="${id}"]`)!.scrollLeft = 120; }, DIFF_TESTIDS.sideNew);
  const lefts = await win.evaluate((ids) => ids.map((id) => document.querySelector(`[data-e2e-hscroll="${id}"]`)?.scrollLeft ?? 0), [DIFF_TESTIDS.sideNew, DIFF_TESTIDS.sideOld]);
  expect(lefts[0], 'After scrolled').toBeGreaterThan(0);
  expect(lefts[1], 'Before did not').toBe(0);
});

/* ═══════════════════════════════ 5. highlighting ═══════════════════════════════ */

test('highlighting: keywords, a block comment opened above the hunk, per-side language on rename, plain for unknown and Dockerfile, live theme (AC36–AC39, AC42)', async () => {
  const win = await setup(['aTs', 'comment', 'rename', 'unknownExt', 'dockerfile']);
  await openDiffTab(win);

  await selectRow(win, 'a.ts', 'staged');
  for (const s of ['old', 'new'] as const) {
    expect(await scopeHolds(cell(win, s, 'return base;'), 'keyword', 'return'), `${s}: "return" is a keyword`).toBe(true);
  }
  await expect(win.getByTestId(DIFF_TESTIDS.highlightOff), 'no size note for a small file').toHaveCount(0);

  // AC38: the comment opens 10 lines above the hunk; the hunk's lines still colour as comment.
  await selectRow(win, 'comment.ts');
  expect(await scopeHolds(cell(win, 'old', 'comment line 12'), 'comment', 'comment line 12')).toBe(true);
  expect(await scopeHolds(cell(win, 'new', 'comment line 12 changed'), 'comment', 'comment line 12 changed')).toBe(true);
  for (const s of ['old', 'new'] as const) {
    expect(await scopeHolds(cell(win, s, 'comment line 10'), 'comment', 'comment line 10'), `${s}: context inside the comment`).toBe(true);
  }

  // AC37: old.ts is TypeScript (interface is a keyword), new name é.js is JavaScript (it is not).
  await selectRow(win, RENAME_NEW, 'staged');
  const ifaceOld = cell(win, 'old', 'export interface Shape');
  const ifaceNew = cell(win, 'new', 'export interface Shape');
  expect(await scopeHolds(ifaceOld, 'keyword', 'interface'), 'TS side').toBe(true);
  expect(await scopeHolds(ifaceNew, 'keyword', 'interface'), 'JS side').toBe(false);
  expect(await scopeHolds(cell(win, 'new', 'export const five'), 'keyword', 'const'), 'control: JS side is highlighted').toBe(true);

  // AC37 unknown extension and Dockerfile: plain text, no error. AC36: no "no newline" row.
  for (const [path, text] of [['x.unknownext', 'delta'], ['Dockerfile', 'RUN echo two']] as const) {
    await selectRow(win, path);
    await expect(cell(win, 'new', text)).toBeVisible();
    expect(await hljsSpanCount(paneOf(win)), `${path}: no highlight spans`).toBe(0);
    await expect(win.getByTestId(DIFF_TESTIDS.error)).toHaveCount(0);
    await expect(win.getByTestId(DIFF_TESTIDS.highlightOff), `${path}: no size note (AC42)`).toHaveCount(0);
  }
  await selectRow(win, 'x.unknownext');
  expect(await paneOf(win).innerText()).not.toContain('No newline at end of file');
  await expect(cell(win, 'old', 'gamma')).toHaveAttribute('data-type', 'removed');

  // AC39: switching theme recolours the open diff without reloading it.
  await selectRow(win, 'a.ts', 'staged');
  const keyword = cell(win, 'new', 'return base;').locator('.hljs-keyword').first();
  const colourBefore = await keyword.evaluate((el) => getComputedStyle(el).color);
  const themeBefore = await win.locator('html').getAttribute('data-theme');
  await watchPane(win);
  await win.getByTestId('theme-toggle').click();
  await expect(win.locator('html')).not.toHaveAttribute('data-theme', themeBefore ?? '__none__');
  await expect.poll(() => keyword.evaluate((el) => getComputedStyle(el).color)).not.toBe(colourBefore);
  const w = await paneWatch(win);
  expect(w.sawLoading, 'no "Loading diff…" on theme change').toBe(false);
  expect(w.sameElement, 'the pane was not replaced').toBe(true);
});

/* ═══════════════════════════════ 6. safety ═══════════════════════════════ */

test('content that looks like HTML or script is shown literally and never runs (AC40)', async () => {
  const win = await setup(['xss']);
  await openDiffTab(win);
  for (const path of ['xss.html', 'xss.unknownext']) {
    await selectRow(win, path);
    // Positive control: the payload text is on screen, literally.
    await expect(cell(win, 'new', XSS_IMG), `${path}: img payload as text`).toBeVisible();
    await expect(cell(win, 'new', XSS_SCRIPT), `${path}: script payload as text`).toBeVisible();
    await expect(panelOf(win).locator('img, script, iframe, object, embed'), `${path}: nothing rendered`).toHaveCount(0);
  }
  // An <img onerror> fires asynchronously; give it time before checking it did not.
  await win.waitForTimeout(1000);
  expect(await win.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBeUndefined();
});

/* ═══════════════════════════════ 7. special states ═══════════════════════════════ */

test('special states: binary, mode change, too large, large-file note, symlink text, git error with a usable list; P2 timing (AC17, AC18, AC20, AC41–AC43)', async ({}, testInfo) => {
  testInfo.setTimeout(120_000);
  const win = await setup(['aTs', 'binary', 'mode', 'big', 'mid', 'half', 'link', 'noperm']);
  await openDiffTab(win);
  const lineCells = () => paneOf(win).getByTestId(DIFF_TESTIDS.line);

  // AC18 binary: the message on both sides, no raw bytes.
  await selectRow(win, 'img.bin');
  await expect(win.getByTestId(DIFF_TESTIDS.binary).first()).toBeVisible();
  const binText = await panelOf(win).getByTestId(DIFF_TESTIDS.binary).allInnerTexts();
  expect(binText.join('\n').split(DIFF_COPY.binary).length - 1, 'binary message on both sides').toBe(2);
  await expect(lineCells()).toHaveCount(0);

  // AC18 mode-only change.
  await selectRow(win, 'run.sh');
  await expect(win.getByTestId(DIFF_TESTIDS.mode)).toContainText(DIFF_COPY.modeChanged('100644', '100755'));
  await expect(lineCells()).toHaveCount(0);

  // AC20, AC41: over 1 MiB shows the message and never a partial diff.
  await selectRow(win, 'big.txt');
  await expect(panelOf(win).getByText(DIFF_COPY.tooLarge, { exact: true })).toBeVisible();
  await expect(lineCells()).toHaveCount(0);

  // AC42: over 256 KiB per side: split view, numbers and tints, no highlighting, the note.
  await selectRow(win, 'mid.ts');
  await expect(cell(win, 'new', MID_EDIT)).toHaveAttribute('data-type', 'added');
  await expect(win.getByTestId(DIFF_TESTIDS.highlightOff)).toHaveText(DIFF_COPY.highlightOff);
  expect(await hljsSpanCount(paneOf(win)), 'no highlighting over the limit').toBe(0);
  const midRight = await readSide(win, 'new');
  const midAdded = midRight.find((c) => c.type === 'added')!;
  expect(midAdded.num).toMatch(/^\d+$/);
  expect(midAdded.bg).not.toMatch(TRANSPARENT);

  // P2 (plan §4): click-to-highlighted time, a ~250 KiB file (just under the cap) against a small one.
  const timeToHighlight = async (path: string, text: string): Promise<number> => {
    await selectRow(win, 'big.txt');
    return win.evaluate(async (a) => {
      const row = document.querySelector(`[data-testid="${a.row}"][data-path=${JSON.stringify(a.path)}]`) as HTMLElement;
      const done = () => [...document.querySelectorAll(`[data-testid="${a.sideNew}"] [data-testid="${a.line}"]`)]
        .some((c) => (c.textContent ?? '').includes(a.text) && c.querySelector('.hljs-keyword'));
      const t0 = performance.now();
      row.click();
      await new Promise<void>((resolve, reject) => {
        const tick = () => {
          if (done()) resolve();
          else if (performance.now() - t0 > 20_000) reject(new Error(`${a.path} was not highlighted within 20 s`));
          else requestAnimationFrame(tick);
        };
        tick();
      });
      return performance.now() - t0;
    }, { row: DIFF_TESTIDS.row, sideNew: DIFF_TESTIDS.sideNew, line: DIFF_TESTIDS.line, path, text });
  };
  const smallMs = await timeToHighlight('a.ts', 'const base = 2;');
  const halfMs = await timeToHighlight('half.ts', HALF_EDIT);
  await expect(win.getByTestId(DIFF_TESTIDS.highlightOff), 'at or under 256 KiB is highlighted, no note').toHaveCount(0);
  const note = `click→highlighted: half.ts (~250 KiB/side) ${halfMs.toFixed(0)} ms; a.ts ${smallMs.toFixed(0)} ms; difference ${(halfMs - smallMs).toFixed(0)} ms`;
  testInfo.annotations.push({ type: 'P2 highlight timing', description: note });
  console.log(`[P2] ${note}`);

  // AC43: a symlink shows its link text; the target is never read.
  await selectRow(win, 'link');
  const target = join(h!.isolatedHome, 'outside', 'secret.txt');
  await expect(cell(win, 'new', target)).toHaveAttribute('data-type', 'added');
  expect(await panelOf(win).innerText()).not.toContain(LINK_SECRET);

  // AC17: a failing diff shows git's error text; the list stays usable.
  await selectRow(win, 'noperm.txt');
  await expect(panelOf(win)).toContainText(/permission denied/i);
  await expect(lineCells()).toHaveCount(0);
  await selectRow(win, 'a.ts');
  await expect(cell(win, 'new', 'const base = 2;')).toBeVisible();
});

test('loading and "(no changes)": a held diff shows "Loading diff…"; a file reverted after listing shows "(no changes)" (AC17, AC18)', async () => {
  const win = await setup(['aTs', 'bTs']);
  const app = h!.app;
  await gateIpc(app, 'git:diff-sides');
  await gateIpc(app, 'git:panel-status');
  await openDiffTab(win);
  await expect(cell(win, 'new', 'const base = 2;')).toBeVisible();

  // AC17: while the diff request is pending the pane says so; the list stays usable.
  await setHeld(app, 'git:diff-sides', true);
  await rowOf(win, 'b.ts', 'unstaged').click();
  await expect(panelOf(win).getByText(DIFF_COPY.loadingDiff, { exact: true })).toBeVisible();
  await expect(rowOf(win, 'b.ts', 'staged')).toBeEnabled();
  await setHeld(app, 'git:diff-sides', false);
  await expect(cell(win, 'new', "'three'")).toBeVisible();
  await expect(panelOf(win).getByText(DIFF_COPY.loadingDiff, { exact: true })).toHaveCount(0);

  // AC18: freeze the list (status requests hang), revert b.ts in the worktree, then select it.
  await setHeld(app, 'git:panel-status', true);
  git(projDir(), ['checkout', '--', 'b.ts']);
  await selectRow(win, 'a.ts', 'staged');
  await selectRow(win, 'b.ts', 'unstaged');
  await expect(win.getByTestId(DIFF_TESTIDS.noChanges)).toHaveText(DIFF_COPY.noChanges);
  await expect(paneOf(win).getByTestId(DIFF_TESTIDS.line)).toHaveCount(0);
  await setHeld(app, 'git:panel-status', false);
});

test('path escapes are rejected by the Diff tab git calls and never leak outside content (AC31, AC43)', async () => {
  const win = await setup(['aTs']);
  const evil = join(h!.demoRoot, `${PROJ}-evil`);
  mkdirSync(evil);
  writeFileSync(join(evil, 'secret.txt'), `${LINK_SECRET}\n`);
  mkdirSync(join(projDir(), 'd'));
  symlinkSync(evil, join(projDir(), 'd', 'up'));
  const id = await projectId(win, PROJ);

  const call = (channel: string, req: Record<string, unknown>) => win.evaluate(async (a) => {
    const api = (window as unknown as { api: Api }).api;
    try { return { ok: true, body: JSON.stringify(await api.invoke(a.channel, a.req)) }; }
    catch (e) { return { ok: false, body: String(e) }; }
  }, { channel, req: { projectId: id, ...req } });

  // Control: a legitimate request succeeds.
  const good = await call('git:diff-sides', { kind: 'staged', path: 'a.ts' });
  expect(good.ok, good.body).toBe(true);
  expect(good.body).toContain('"status":"ok"');

  const escapes: Array<[string, Record<string, unknown>]> = [
    ['git:diff-sides', { kind: 'untracked', path: `../${PROJ}-evil/secret.txt` }],
    ['git:diff-sides', { kind: 'untracked', path: join(evil, 'secret.txt') }],
    ['git:diff-sides', { kind: 'untracked', path: `a/../../${PROJ}-evil/secret.txt` }],
    ['git:diff-sides', { kind: 'staged', path: 'a.ts', origPath: `../${PROJ}-evil/secret.txt` }],
    ['git:diff-sides', { kind: 'untracked', path: 'd/up/secret.txt' }],
    ['git:diff-sides', { kind: 'unstaged', path: 'd/up/secret.txt' }],
    ['git:file-diff', { path: `../${PROJ}-evil/secret.txt`, untracked: true }],
    ['git:file-diff', { path: join(evil, 'secret.txt'), untracked: true }],
    ['git:file-diff', { path: 'd/up/secret.txt', untracked: true }],
  ];
  for (const [channel, req] of escapes) {
    const res = await call(channel, req);
    expect(res.ok, `${channel} ${JSON.stringify(req)} is rejected`).toBe(false);
    expect(res.body, `${channel} ${JSON.stringify(req)} leaks nothing`).not.toContain(LINK_SECRET);
  }
});

/* ═══════════════════════════════ 8. refresh ═══════════════════════════════ */

test('live list, manual refresh, selection follow-up, quiet reload and clean state (AC21–AC23, AC25, AC27, AC30)', async ({}, testInfo) => {
  testInfo.setTimeout(90_000);
  const win = await setup(['aTs', 'long', 'unknownExt']);
  await shortenWindow();
  const panel = await openDiffTab(win);

  // AC21, AC23: a file reverted outside the tab disappears; its selection moves to the first row.
  await selectRow(win, 'x.unknownext');
  git(projDir(), ['checkout', '--', 'x.unknownext']);
  await expect(rowOf(win, 'x.unknownext')).toHaveCount(0, { timeout: POLL_WINDOW });
  await expect(rowOf(win, 'a.ts', 'staged')).toHaveAttribute('aria-current', /^(?!false$).+/);
  await expect(cell(win, 'new', 'const base = 2;')).toBeVisible();

  // AC22: Refresh shows a new file at once, without waiting for a poll.
  writeFileSync(join(projDir(), 'fresh.txt'), 'fresh\n');
  await panel.getByTestId(DIFF_TESTIDS.refresh).click();
  await expect(rowOf(win, 'fresh.txt', 'untracked')).toBeVisible({ timeout: 1500 });

  // AC30: polls reload the selected diff quietly — no loading text, no DOM change, same scroll.
  await selectRow(win, 'long.ts');
  const pane = paneOf(win);
  await pane.evaluate((el) => { el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2); });
  const scrollTop = await pane.evaluate((el) => el.scrollTop);
  expect(scrollTop, 'control: the pane scrolled').toBeGreaterThan(0);
  await watchPane(win);
  await win.waitForTimeout(7000); // two or more poll cycles
  let w = await paneWatch(win);
  expect(w.sawLoading, 'no "Loading diff…" on a poll').toBe(false);
  expect(w.mutations, 'an unchanged diff re-renders nothing').toBe(0);
  expect(w.sameElement).toBe(true);
  expect(await pane.evaluate((el) => el.scrollTop)).toBe(scrollTop);

  // AC23, AC30: a change to the selected file appears on the next poll, still quietly.
  appendFileSync(join(projDir(), 'long.ts'), 'export const appended = 1;\n');
  await expect(cell(win, 'new', 'export const appended = 1;')).toHaveCount(1, { timeout: POLL_WINDOW });
  w = await paneWatch(win);
  expect(w.sawLoading, 'no "Loading diff…" when the selected diff changes').toBe(false);
  expect(w.sameElement).toBe(true);
  expect(await pane.evaluate((el) => el.scrollTop)).toBe(scrollTop);
  await expect(rowOf(win, 'long.ts')).toHaveAttribute('aria-current', /^(?!false$).+/);

  // AC27, AC25: commit everything; the clean state replaces the list and the count goes.
  await expect(win.getByTestId(DIFF_TESTIDS.tabCount), 'control: count shown while dirty').toBeVisible();
  commitAll(projDir(), 'everything');
  await expect(panel.getByTestId(DIFF_TESTIDS.empty)).toContainText(DIFF_COPY.clean, { timeout: POLL_WINDOW });
  await expect(rowsOf(win)).toHaveCount(0);
  await expect(paneOf(win)).toHaveCount(0);
  await expect(win.getByTestId(DIFF_TESTIDS.tabCount)).toHaveCount(0, { timeout: 9000 });
});

test('no polling while hidden: the Diff body unmounts off-tab and status calls stop (AC21, AC24)', async () => {
  const win = await setup(['aTs']);
  const app = h!.app;
  await gateIpc(app, 'git:panel-status');
  await openDiffTab(win);
  const start = await gateCalls(app, 'git:panel-status');
  await expect.poll(() => gateCalls(app, 'git:panel-status'), { timeout: 9000, message: 'two polls within 8 s while visible' })
    .toBeGreaterThanOrEqual(start + 2);

  await win.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(panelOf(win)).toHaveCount(0);
  const hidden = await gateCalls(app, 'git:panel-status');
  await win.waitForTimeout(7000);
  expect(await gateCalls(app, 'git:panel-status'), 'no status calls while the Diff tab is hidden').toBe(hidden);
});

/* ═══════════════════════════════ 9. label, empty and error states ═══════════════════════════════ */

test('tab label count is the unique changed-path count, absent on a non-repo project (AC25)', async () => {
  h = await launch([PROJ, OTHER]);
  const entries = seedRepo({ dir: projDir(), outside: join(h.isolatedHome, 'outside') }, ['aTs', 'bTs', 'untracked']);
  rmSync(join(projDir(OTHER), '.git'), { recursive: true, force: true });
  const win = h.win;
  await openProject(win, PROJ);
  const n = uniquePathCount(entries);
  expect(n).toBe(4);

  const count = win.getByTestId(DIFF_TESTIDS.tabCount);
  await expect(count).toHaveText(new RegExp(`(^|\\D)${n}(\\D|$)`), { timeout: 9000 });
  await expect(win.getByTestId(DIFF_TESTIDS.tab)).toHaveAttribute('aria-label', DIFF_COPY.tabCountLabel(n));
  await expect(win.getByTestId('ab-git')).toHaveAttribute('aria-label', `Git — ${n} changed`);
  await openDiffTab(win);
  await expect(rowsOf(win), 'control: b.ts is listed twice, so rows exceed the count').toHaveCount(5);

  await selectProject(win, OTHER);
  await expect(panelOf(win).getByTestId(DIFF_TESTIDS.empty)).toHaveText(DIFF_COPY.notRepo);
  await expect(win.getByTestId(DIFF_TESTIDS.tab)).toContainText(DIFF_COPY.tabLabel);
  await expect(count).toHaveCount(0, { timeout: 9000 });
  await expect(win.getByTestId(DIFF_TESTIDS.tab)).not.toHaveAttribute('aria-label', /changed/);
});

test('empty and error states: not a repo, git rejects .git, clean tree (AC26–AC28)', async () => {
  h = await launch(['nonrepo', 'broken', 'cleanrepo']);
  rmSync(join(h.demoRoot, 'nonrepo', '.git'), { recursive: true, force: true });
  seedRepo({ dir: join(h.demoRoot, 'cleanrepo'), outside: join(h.isolatedHome, 'outside') }, []);
  const win = h.win;
  await openProject(win, 'nonrepo');
  const panel = await openDiffTab(win);

  // AC26
  await expect(panel.getByTestId(DIFF_TESTIDS.empty)).toHaveText(DIFF_COPY.notRepo);
  await expect(panel.getByTestId(DIFF_TESTIDS.list)).toHaveCount(0);
  await expect(paneOf(win)).toHaveCount(0);

  // AC28: the harness's empty .git is rejected by git — an error with git's text and Refresh.
  await selectProject(win, 'broken');
  const error = panel.getByTestId(DIFF_TESTIDS.error);
  await expect(error).toBeVisible({ timeout: 10000 });
  await expect(error).toContainText(DIFF_COPY.statusFailed);
  await expect(error).toContainText(/fatal: not a git repository/i);
  await expect(panel.getByTestId(DIFF_TESTIDS.refresh)).toBeVisible();
  await expect(panel.getByText(DIFF_COPY.clean, { exact: true })).toHaveCount(0);
  await expect(panel.getByText(DIFF_COPY.notRepo, { exact: true })).toHaveCount(0);

  // AC27
  await selectProject(win, 'cleanrepo');
  await expect(panel.getByTestId(DIFF_TESTIDS.empty)).toContainText(DIFF_COPY.clean);
  await expect(paneOf(win)).toHaveCount(0);
  await expect(panel.getByTestId(DIFF_TESTIDS.error)).toHaveCount(0);
});

test('project switch on the Diff tab shows only the new project\'s data (AC29)', async () => {
  h = await launch([PROJ, OTHER]);
  seedRepo({ dir: projDir(), outside: join(h.isolatedHome, 'outside') }, ['long']);
  seedRepo({ dir: projDir(OTHER), outside: join(h.isolatedHome, 'outside2') }, ['aTs']);
  const win = h.win;
  await openProject(win, PROJ);
  await openDiffTab(win);
  await selectRow(win, 'long.ts');
  await expect(cell(win, 'new', LONG_EDITED_123)).toBeVisible();

  // Record any moment the window shows OTHER's title while PROJ's diff text is on screen.
  await win.evaluate((a) => {
    const w = window as unknown as { __leak: boolean };
    w.__leak = false;
    new MutationObserver(() => {
      const panel = document.querySelector(`[data-testid="${a.panel}"]`);
      if (document.title.startsWith(a.other) && (panel?.textContent ?? '').includes(a.text)) w.__leak = true;
    }).observe(document, { subtree: true, childList: true, characterData: true });
  }, { panel: DIFF_TESTIDS.panel, other: OTHER, text: 'v123 = 9123' });

  await selectProject(win, OTHER);
  await expect(panelOf(win), 'stays on the Diff tab').toBeVisible();
  await expect(rowOf(win, 'a.ts')).toBeVisible();
  await expect(rowOf(win, 'long.ts')).toHaveCount(0);
  await expect(cell(win, 'new', 'const base = 2;')).toBeVisible();
  expect(await panelOf(win).innerText()).not.toContain('v123');
  expect(await win.evaluate(() => (window as unknown as { __leak: boolean }).__leak), 'no frame showed the old diff under the new project').toBe(false);
});

test('Diff to Shell does not focus the terminal (AC6)', async () => {
  const win = await setup(['aTs']);
  await openDiffTab(win);
  await expect(win.locator('[data-testid="shell-tab"]')).toHaveCount(0);
  await win.getByRole('button', { name: 'Shell', exact: true }).click();
  await expect(win.locator('[data-testid="shell-tab"] .xterm-screen'), 'positive control: the shell tab is rendered').toBeVisible({ timeout: 10000 });
  expect(await terminalActiveIn(win, '[data-testid="shell-tab"]'), 'Diff to Shell does not auto-focus the terminal').toBe(false);
});

/* ═══════════════════════════════ 10. Git panel ═══════════════════════════════ */

test('Git panel inherits the fixes: rename under its new path with a working diff, too large, git error text, no highlighting (AC33)', async () => {
  h = await launch([PROJ, OTHER]);
  seedRepo({ dir: projDir(), outside: join(h.isolatedHome, 'outside') }, ['rename', 'big', 'aTs']);
  const win = h.win;
  await openProject(win, PROJ);
  await win.getByTestId('ab-git').click();
  const gitView = win.locator('[data-view="git"]');

  const renameBtn = gitView.locator(`button[title=${JSON.stringify(`Toggle diff for ${RENAME_NEW}`)}]`);
  await expect(renameBtn).toBeVisible({ timeout: 10000 });
  await expect(renameBtn).toHaveText(new RegExp(`${RENAME_NEW}$`));
  await expect(gitView).not.toContainText('\\303');
  await expect(gitView).not.toContainText(`"${RENAME_NEW}"`);
  await renameBtn.click();
  await expect(gitView).toContainText(`rename from ${RENAME_OLD}`);
  await expect(gitView).toContainText('export const six = 66;');

  await gitView.locator('button[title="Toggle diff for big.txt"]').click();
  await expect(gitView.getByText(DIFF_COPY.tooLarge, { exact: true })).toBeVisible();

  expect(await hljsSpanCount(gitView), 'the panel diff stays unhighlighted').toBe(0);
  await expect(gitView.getByTestId(DIFF_TESTIDS.sideOld)).toHaveCount(0);

  // A failed status shows git's error, not the clean-tree message.
  await openProject(win, OTHER);
  await expect(gitView).toContainText(/fatal: not a git repository/i, { timeout: 10000 });
  await expect(gitView.getByText('Nothing to commit — working tree clean.')).toHaveCount(0);
});

test('Git panel unstages a staged rename completely: the old path is not left staged (AC33, gate F1)', async () => {
  h = await launch([PROJ]);
  seedRepo({ dir: projDir(), outside: join(h.isolatedHome, 'outside') }, ['rename']);
  const win = h.win;
  await openProject(win, PROJ);
  await win.getByTestId('ab-git').click();
  const gitView = win.locator('[data-view="git"]');

  // Positive control: the rename is staged in git and listed under Staged in the panel.
  expect(stagedEntries(projDir())).toEqual([{ xy: 'R ', path: RENAME_NEW, orig: RENAME_OLD }]);
  const staged = gitView.locator("xpath=.//span[starts-with(normalize-space(text()), 'Staged')]/ancestor::div[2]");
  const renameBtn = staged.locator(`button[title=${JSON.stringify(`Toggle diff for ${RENAME_NEW}`)}]`);
  await expect(renameBtn).toBeVisible({ timeout: 10000 });

  await renameBtn.locator('xpath=following-sibling::button[@title="Unstage"]').click();

  // Nothing is left staged: before the fix, "D  old.ts" stayed in the index.
  await expect.poll(() => stagedEntries(projDir()), { timeout: 5000 }).toEqual([]);
  const entries = porcelain(projDir());
  expect(entries).toContainEqual({ xy: '??', path: RENAME_NEW });
  expect(entries.find((e) => e.path === RENAME_OLD), 'old path is an unstaged deletion').toEqual({ xy: ' D', path: RENAME_OLD });
  await expect(gitView.locator("xpath=.//span[starts-with(normalize-space(text()), 'Staged')]"), 'no Staged section').toHaveCount(0, { timeout: 5000 });
  await expect(gitView.locator(`button[title=${JSON.stringify(`Toggle diff for ${RENAME_NEW}`)}]`)).toBeVisible();
});

/* ═══════════════════════════════ 11. repo-configured programs ═══════════════════════════════ */

test('repo-configured fsmonitor, external diff and textconv never run for the Diff tab or the Git panel (AC32, AC33, AC43)', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  h = await launch([PROJ]);
  const markers = seedRepoProgramsRepo(projDir(), join(h.isolatedHome, 'programs'));
  const win = h.win;
  await openProject(win, PROJ);
  await openDiffTab(win);

  await selectRow(win, 't.tc');
  await expect(cell(win, 'new', 'tracked two')).toBeVisible();
  await selectRow(win, 'u.tc');
  await expect(cell(win, 'new', 'untracked one')).toBeVisible();
  await win.waitForTimeout(7000); // two or more Diff tab polls, each reloading the selected diff
  await expect(paneOf(win)).not.toContainText(TEXTCONV_OUTPUT);

  expect(programRuns(markers.external), 'diff.external never ran').toEqual([]);
  expect(programRuns(markers.textconv), 'textconv never ran').toEqual([]);
  // The app-wide git:status poll is a recorded follow-up and may still run fsmonitor;
  // only the Diff tab's calls (status with -z, diff, cat-file) must never appear.
  const fsm = programRuns(markers.fsmonitor);
  testInfo.annotations.push({ type: 'fsmonitor runs (app-wide git:status, out of scope)', description: String(fsm.length) });
  for (const run of fsm) {
    expect(run, 'fsmonitor was not run by a Diff tab git call').not.toMatch(/ -z\b| diff\b| cat-file\b/);
  }

  // AC33: the Git panel's diff of the textconv file runs nothing either.
  await win.getByTestId('ab-git').click();
  const gitView = win.locator('[data-view="git"]');
  await gitView.locator('button[title="Toggle diff for t.tc"]').click();
  await expect(gitView).toContainText('tracked two');
  await expect(gitView).not.toContainText(TEXTCONV_OUTPUT);
  expect(programRuns(markers.external)).toEqual([]);
  expect(programRuns(markers.textconv)).toEqual([]);
});

/* ═══════════════════════════════ 12. restart ═══════════════════════════════ */

test('the Diff tab is restored after a restart; an unknown stored tab falls back to Shell (AC3)', async ({}, testInfo) => {
  testInfo.setTimeout(90_000);
  let win = await setup(['aTs']);
  await openDiffTab(win);

  win = await relaunch();
  await selectProject(win, PROJ);
  await expect(panelOf(win), 'Diff is active again').toBeVisible({ timeout: 10000 });
  await expect(cell(win, 'new', 'const base = 2;')).toBeVisible();
  await expect(win.locator('[data-testid="shell-tab"]')).toHaveCount(0);

  await win.evaluate(() => localStorage.setItem('metaide.mainTab', JSON.stringify('bogus')));
  win = await relaunch();
  await selectProject(win, PROJ);
  await expect(win.locator('[data-testid="shell-tab"] .xterm-screen'), 'falls back to Shell').toBeVisible({ timeout: 10000 });
  await expect(panelOf(win)).toHaveCount(0);
});
