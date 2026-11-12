import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CHROME_TESTIDS } from '../../src/renderer/chrome-testids';
import { SIDEBAR_WIDTH } from '../../src/renderer/sidebar-width';
import { DIFF_TESTIDS } from '../../src/renderer/diff-tab-copy';
import { PROJECT_SETTINGS_COPY, PROJECT_SETTINGS_TESTIDS } from '../../src/renderer/project-settings-contract';
import { AGENT_DOT } from '../../src/shared/agent-state';
import { PALETTE_COPY } from '../../src/renderer/command-palette-contract';
import type { EffectiveTheme } from '../../src/renderer/markdown/contract';
import { commitAll, git, GIT_ENV, initRepo, porcelain } from './helpers/git-repo';
import { badgeContrast, colourDistance, elementColour, fmtColour, isFrostedChrome, resolveToken } from './helpers/chrome-colour';
import { closeApp, guardedLaunch } from './helpers/claude-harness';

/**
 * Shell chrome dimensions; the main window has no title bar (its icons live at the bottom of the activity bar)
 * (docs/specs/2026-10-06-shell-chrome-cleanup.md AC1–AC15, AC25–AC28, AC31).
 *
 * One app, three projects under one root:
 *   - `chromed`: a real repo on `main`, three npm scripts (tasks badge "3")
 *     and 150 untracked files (git badge "99+");
 *   - `branchy`: a clean real repo with one npm script (tasks badge "1", no
 *     git badge); its branch is changed by the AC4/AC7 tests;
 *   - `plain`: not a repository (package.json marker only).
 * Every seeded fact is asserted at seed time (`seed`).
 *
 * Tests run in file order and share the app: the width-migration test reloads, so it
 * runs last.
 */

const PALETTES = ['default', 'catppuccin', 'rose-pine'] as const;
const THEMES: readonly EffectiveTheme[] = ['dark', 'light'];
/** The migration marker named in plan §2.8; not exported by the contract, so named here. */
const WIDTH_KEY = 'metaide.sidebarWidth';
const MIGRATED_KEY = 'metaide.sidebarWidth.migrated';
/** The status bar's only hint (command-palette AC29, AC32): one `<kbd>` inside the palette button. */
const STATUS_HINTS = [`${PALETTE_COPY.statusHintKey} ${PALETTE_COPY.statusHintText}`];

let app: ElectronApplication;
let win: Page;
let isolatedHome: string;
let demoRoot: string;

function seed(root: string): void {
  const write = (rel: string, content: string) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  const scripts = (names: string[]) =>
    JSON.stringify({ name: 'fixture', scripts: Object.fromEntries(names.map((n) => [n, `echo ${n}`])) });

  const chromed = join(root, 'chromed');
  mkdirSync(chromed);
  initRepo(chromed);
  write('chromed/package.json', scripts(['build', 'test', 'lint']));
  commitAll(chromed, 'baseline');
  for (let i = 0; i < 150; i++) write(`chromed/dirt/f${String(i).padStart(3, '0')}.txt`, `${i}\n`);

  const branchy = join(root, 'branchy');
  mkdirSync(branchy);
  initRepo(branchy);
  write('branchy/package.json', scripts(['dev']));
  commitAll(branchy, 'baseline');

  write('plain/package.json', scripts(['start']));

  const fail = (cause: string): never => { throw new Error(`chrome-dimensions seed self-check failed: ${cause}`); };
  if (porcelain(chromed).length !== 150) fail(`chromed must have exactly 150 changed paths (git badge "99+"), has ${porcelain(chromed).length}`);
  if (git(chromed, ['branch', '--show-current']).trim() !== 'main') fail('chromed must be on main');
  if (porcelain(branchy).length !== 0) fail('branchy must be clean (no git badge)');
  if (git(branchy, ['branch', '--show-current']).trim() !== 'main') fail('branchy must be on main');
  let plainIsRepo = true;
  try {
    execFileSync('git', ['-C', join(root, 'plain'), 'rev-parse', '--git-dir'], { env: GIT_ENV, stdio: 'ignore' });
  } catch { plainIsRepo = false; }
  if (plainIsRepo) fail('plain sits inside a git repository (is the temp dir under a repo?), so AC5 non-repo cannot be exercised');
}

test.beforeAll(async () => {
  await guardedLaunch(async (scope) => {
    const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
    isolatedHome = scope.tempDir('metaide-dims-home-');
    demoRoot = scope.tempDir('metaide-dims-root-');
    seed(demoRoot);

    app = scope.own(await electron.launch({
      args: ['.', `--user-data-dir=${join(isolatedHome, 'userData')}`],
      env: {
        ...process.env,
        HOME: isolatedHome,
        METAIDE_TEST_MODE: '1',
        METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
        METAIDE_DEFAULT_LAUNCH_FIRST:      JSON.stringify({ argv: ['node', mockClaude],              env: {} }),
        METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: ['node', mockClaude, '--continue'], env: {} }),
      },
    }));
    win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await resizeMain(1440, 900);
    await win.evaluate(async (path: string) => {
      const api = (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } }).api;
      await api.invoke('roots:add', { path });
    }, demoRoot);
    for (const name of ['chromed', 'branchy', 'plain']) await expect(projectRow(name)).toBeVisible({ timeout: 5000 });
  });
});

test.afterAll(async () => {
  if (app) await closeApp(app);
  rmSync(isolatedHome, { recursive: true, force: true });
  rmSync(demoRoot, { recursive: true, force: true });
});

/* ─────────────────────────────── helpers ─────────────────────────────── */

/** Sets the main window's content size and waits until the renderer sees the new width. */
async function resizeMain(width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('popout=1'));
    if (!main) throw new Error('main window not found');
    main.setContentSize(s.width, s.height);
  }, { width, height });
  await expect.poll(() => win.evaluate(() => window.innerWidth), { message: `window width ${width}` }).toBe(width);
}

function projectRow(name: string): Locator {
  return win.locator('[data-testid="project-row"]').filter({ has: win.getByText(name, { exact: true }) }).first();
}

async function selectProject(name: string): Promise<void> {
  await projectRow(name).click();
  await expect(win.getByTestId('status-bar')).toContainText(name);
}

async function box(l: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await l.boundingBox();
  if (!b) throw new Error('element has no bounding box (not rendered)');
  return b;
}

function css(l: Locator, prop: string): Promise<string> {
  return l.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
}

/** All four corner radii of an element. */
function radii(l: Locator): Promise<string[]> {
  return l.evaluate((el) => {
    const cs = getComputedStyle(el);
    return [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius];
  });
}

/**
 * The branch text the status bar shows. StatusBar has no test id for it: the
 * branch group is the span whose icon holder wears `--hue-pink`; its text is
 * the holder's next sibling.
 */
function statusBranch(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-testid="status-bar"]');
    if (!bar) return null;
    for (const svg of bar.querySelectorAll('svg')) {
      const holder = svg.parentElement;
      if (holder && holder.className.includes('--hue-pink')) return holder.nextElementSibling?.textContent ?? null;
    }
    return null;
  });
}

async function setLook(page: Page, palette: string, theme: EffectiveTheme): Promise<void> {
  await page.evaluate(({ palette, theme }) => {
    document.documentElement.setAttribute('data-palette', palette);
    document.documentElement.setAttribute('data-theme', theme);
  }, { palette, theme });
}

async function currentLook(page: Page): Promise<{ palette: string | null; theme: string | null }> {
  return page.evaluate(() => ({
    palette: document.documentElement.getAttribute('data-palette'),
    theme: document.documentElement.getAttribute('data-theme'),
  }));
}

async function restoreLook(page: Page, look: { palette: string | null; theme: string | null }): Promise<void> {
  await page.evaluate((l) => {
    const root = document.documentElement;
    for (const [attr, v] of [['data-palette', l.palette], ['data-theme', l.theme]] as const) {
      if (v === null) root.removeAttribute(attr);
      else root.setAttribute(attr, v);
    }
  }, look);
}

/* ─────────────────────────────── no title bar ─────────────────────────────── */

test('no title bar: the title group is gone and the shell area starts at the top of the window', async () => {
  await expect(win.getByTestId('activity-bar'), 'positive control: the chrome renders').toBeVisible();
  await expect(win.getByTestId('title-group')).toHaveCount(0);
  await expect(win.getByTestId('title-name')).toHaveCount(0);
  const bar = await box(win.getByTestId('activity-bar'));
  const main = await box(win.locator('main').first());
  expect(bar.y, 'activity bar fills from the top edge').toBe(0);
  expect(main.y, 'main sheet is not pushed down by a 44px title bar').toBeLessThan(44);
});

test('the sidebar keeps its 48px top inset from the old title bar, level with the first rail icon', async () => {
  const sidebar = await box(win.locator('aside[data-view="projects"]'));
  const firstChild = await box(win.locator('aside[data-view="projects"] > div:not([aria-hidden])').first());
  expect(sidebar.y).toBe(0);
  expect(firstChild.y - sidebar.y).toBe(48);
  const firstIcon = await box(win.getByTestId('activity-bar').locator('button').first());
  const main = await box(win.locator('main').first());
  expect(Math.round(main.x + main.width), 'main sheet keeps an 8px right margin while the status bar shows').toBe(await win.evaluate(() => window.innerWidth) - 8);
  const filter = await box(win.getByTestId('sidebar-filter').locator('xpath=..'));
  expect(firstIcon.y + firstIcon.height / 2, 'the sidebar toggle centres on the filter field').toBe(filter.y + filter.height / 2);
});

test('empty chrome drags the window: rail, sidebar below the list and the top tab row; controls and overlays do not', async () => {
  const region = (l: Locator) => css(l, '-webkit-app-region');
  expect(await region(win.getByTestId('activity-bar'))).toBe('drag');
  expect(await region(win.getByTestId('activity-bar').locator('button').first())).toBe('no-drag');
  const fill = win.getByTestId('sidebar-drag-fill');
  expect(await region(fill)).toBe('drag');
  const aside = await box(win.locator('aside[data-view="projects"]'));
  const f = await box(fill);
  expect(Math.round(f.y + f.height), 'the drag fill reaches the bottom of the sidebar').toBe(Math.round(aside.y + aside.height));
  expect(await region(win.getByPlaceholder(/filter projects/i)), 'the filter field is not a drag region').not.toBe('drag');
  const tabBar = win.getByTestId(DIFF_TESTIDS.tabBar);
  expect(await region(tabBar)).toBe('drag');
  expect(await region(tabBar.getByRole('button', { name: 'Shell', exact: true }))).toBe('no-drag');
  await win.getByTestId('settings-open').click();
  const dialog = win.getByRole('dialog').first();
  await expect(dialog).toBeVisible();
  expect(await region(dialog), 'a modal over the drag band stays clickable').toBe('no-drag');
  await win.keyboard.press('Escape');
});

test('Chat, Git and Tasks open in the sidebar column in place of the project list, not as a second column', async () => {
  const projects = win.locator('aside[data-view="projects"]');
  await expect(projects, 'positive control: the project list shows first').toBeVisible();
  const sidebarX = (await box(projects)).x;
  try {
    for (const view of ['git', 'tasks', 'chat'] as const) {
      await win.getByTestId(`ab-${view}`).click();
      const panel = win.locator(`[data-view="${view}"]`);
      await expect(panel).toBeVisible();
      await expect(projects, `${view}: the project list is replaced`).toHaveCount(0);
      await expect.poll(async () => Math.round((await box(panel)).x), `${view}: same column as the project list`).toBe(Math.round(sidebarX));
      expect(await win.locator('[data-view]').filter({ visible: true }).count(), `${view}: one sidebar column`).toBe(1);
    }
  } finally {
    await win.getByTestId('ab-projects').click();
  }
  await expect(projects).toBeVisible();
});

test('switching the sidebar view animates the column to that view\'s width; dragging follows the pointer without lag', async () => {
  const column = win.getByTestId('sidebar-column');
  expect(await css(column, 'transition-property')).toContain('width');
  expect(await css(column, 'transition-duration')).toBe('0.2s');
  await win.waitForTimeout(300); // let an earlier view switch finish animating
  const projectsW = (await box(column)).width;
  try {
    await win.getByTestId('ab-chat').click();
    const target = await win.evaluate(() => Number(localStorage.getItem('metaide.chatPanelWidth') ?? 400) || 400);
    test.skip(Math.round(target) === Math.round(projectsW), 'both views share a width');
    const samples: number[] = [];
    for (let i = 0; i < 6; i++) { samples.push((await box(column)).width); await win.waitForTimeout(25); }
    expect(samples.some((w) => Math.round(w) !== Math.round(projectsW) && Math.round(w) !== Math.round(target)), `an in-between width while animating: ${samples.join(', ')}`).toBe(true);
    await expect.poll(async () => Math.round((await box(column)).width)).toBe(Math.round(target));
  } finally {
    await win.getByTestId('ab-projects').click();
  }
  await expect.poll(async () => Math.round((await box(column)).width)).toBe(Math.round(projectsW));
  const handle = win.locator('[data-testid="sidebar-column"] + [data-testid="resize-handle"]');
  const h = await box(handle);
  await handle.hover({ position: { x: h.width / 2, y: 200 } });
  await win.mouse.down();
  await win.mouse.move(h.x + 40, h.y + 200, { steps: 4 });
  await expect(handle, 'positive control: the handle is mid-drag').toHaveClass(/(^| )bg-\[color:var\(--accent\)\]/);
  await expect.poll(() => css(column, 'transition-duration'), 'no width transition mid-drag').toBe('0s');
  await win.mouse.up();
  await handle.dblclick();
  await win.waitForTimeout(300); // the reset width animates; let it land before the next test measures
});

test('the status bar sits under the main sheet only (not the sidebar), with no top border; shown it rounds and insets the sheet, hidden the sheet runs square to the edges', async () => {
  const setStatusBar = (value: boolean) => win.evaluate(async (v: boolean) => {
    const api = (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } }).api;
    await api.invoke('settings:set', { key: 'show_status_bar', value: v });
  }, value);
  await expect(win.getByTestId('status-bar'), 'positive control: shown by default').toBeVisible();
  const main = win.locator('main').first();
  const height = await win.evaluate(() => window.innerHeight);
  const column = await box(win.getByTestId('main-column'));
  await expect(main.getByTestId('status-bar'), 'not inside the main sheet').toHaveCount(0);
  const m = await box(main);
  const bar = await box(win.getByTestId('status-bar'));
  expect([bar.x, Math.round(bar.width)], 'spans the main column, not the sidebar').toEqual([column.x, Math.round(column.width)]);
  expect(bar.x, 'starts right of the sidebar').toBeGreaterThan(64);
  expect(await css(win.getByTestId('status-bar'), 'border-top-width'), 'no top border').toBe('0px');
  expect(Math.round(bar.y + bar.height), 'at the bottom of the window').toBe(height);
  expect(Math.round(m.y + m.height), 'the sheet ends where the status bar starts').toBe(Math.round(bar.y));
  expect(await radii(main), 'rounded while the status bar shows').toEqual(['14px', '14px', '14px', '14px']);
  expect([await css(main, 'margin-top'), await css(main, 'margin-right')], 'inset while the status bar shows').toEqual(['8px', '8px']);
  expect(await css(main, 'transition-property'), 'margin and rounding animate').toContain('border-radius');
  /** Largest document overflow (px) seen while the bar folds; any overflow shows window scrollbars. */
  const maxOverflowDuring = (value: boolean) => win.evaluate(async (v: boolean) => {
    const api = (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } }).api;
    const d = document.scrollingElement as HTMLElement;
    let worst = 0;
    const until = performance.now() + 400;
    const sample = () => { worst = Math.max(worst, d.scrollHeight - d.clientHeight, d.scrollWidth - d.clientWidth); };
    const done = new Promise<void>((resolve) => {
      const tick = () => { sample(); if (performance.now() < until) requestAnimationFrame(tick); else resolve(); };
      requestAnimationFrame(tick);
    });
    await api.invoke('settings:set', { key: 'show_status_bar', value: v });
    await done;
    return worst;
  }, value);
  try {
    expect(await maxOverflowDuring(false), 'hiding never overflows the window (no scrollbars)').toBe(0);
    await expect(win.getByTestId('status-bar')).toHaveCount(0);
    await expect.poll(async () => { const b = await box(main); return Math.round(b.y + b.height); }).toBe(height);
    await expect.poll(() => radii(main), 'square on every window edge').toEqual(['0px', '0px', '0px', '0px']);
    await expect.poll(async () => [await css(main, 'margin-top'), await css(main, 'margin-right')]).toEqual(['0px', '0px']);
    expect(await maxOverflowDuring(true), 'showing never overflows the window (no scrollbars)').toBe(0);
  } finally {
    await setStatusBar(true);
  }
  await expect(win.getByTestId('status-bar')).toBeVisible();
  await win.waitForTimeout(300);
});

test('the project name and branch still show in the status bar and the OS window title', async () => {
  await selectProject('chromed');
  await expect(win.locator('[data-testid="shell-tab"]')).toBeVisible({ timeout: 5000 });
  expect(await win.title(), 'document title format is unchanged').toBe('chromed — MetaLogix IDE');
  await expect.poll(() => statusBranch(win), { timeout: 10000 }).toBe('main');
});

test('AC4/AC14: the status bar branch follows a checkout and detached HEAD; a clean repo shows no git badge', async () => {
  const dir = join(demoRoot, 'branchy');
  await selectProject('branchy');
  await expect.poll(() => statusBranch(win), { timeout: 10000 }).toBe('main');
  await expect(win.locator('[data-testid="ab-tasks"] [data-tone]'), 'positive control: the tasks badge renders').toHaveText('1');
  await expect(win.locator('[data-testid="ab-git"] [data-tone]'), 'clean tree (0 changes): no git badge').toHaveCount(0);

  git(dir, ['checkout', '-q', '-b', 'feature/title-bar']);
  await expect.poll(() => statusBranch(win), { timeout: 10000 }).toBe('feature/title-bar');

  git(dir, ['checkout', '-q', '--detach']);
  await expect.poll(() => statusBranch(win), { timeout: 10000 }).toBe('HEAD');
});

test('AC8: the theme, tile, settings and AI usage buttons sit at the bottom of the activity bar, 44x44 with a 10px radius', async () => {
  const bar = win.getByTestId('activity-bar');
  const group = bar.getByTestId(CHROME_TESTIDS.titleButtons);
  const barBox = await box(bar);
  const fleet = await box(bar.getByTestId('ab-fleet'));
  let previousBottom = fleet.y + fleet.height;
  for (const id of ['theme-toggle', 'tile-windows', 'settings-open']) {
    const b = group.getByTestId(id);
    await expect(b, `${id} sits in the title-buttons group`).toBeVisible();
    const r = await box(b);
    expect([r.width, r.height], `${id} size`).toEqual([44, 44]);
    expect(await radii(b), `${id} radius`).toEqual(['10px', '10px', '10px', '10px']);
    expect(r.y, `${id} is below the previous button`).toBeGreaterThanOrEqual(previousBottom);
    previousBottom = r.y + r.height;
    expect(await b.getAttribute('aria-label'), `${id} has an accessible name`).toBeTruthy();
  }
  const usage = await box(group.getByTestId('ab-usage'));
  expect(usage.y, 'the AI usage meter sits below settings').toBeGreaterThanOrEqual(previousBottom);
  previousBottom = usage.y + usage.height;
  expect(barBox.y + barBox.height - previousBottom, 'the usage meter is pinned to the bottom with the rail padding').toBeLessThanOrEqual(16);
  const gapAboveFooter = (await box(group.getByTestId('theme-toggle'))).y - (fleet.y + fleet.height);
  expect(gapAboveFooter, 'a flexible spacer separates the footer from the nav buttons').toBeGreaterThan(40);
});

test('the top of the activity bar is a draggable strip (traffic-light room on macOS) and the footer buttons are not draggable', async () => {
  const platform = await app.evaluate(() => process.platform);
  const strip = win.getByTestId('ab-drag-region');
  if (platform === 'darwin') {
    expect((await box(strip)).height).toBe(36);
    expect(await css(strip, '-webkit-app-region')).toBe('drag');
  } else {
    await expect(strip).toHaveCount(0);
  }
  expect(await css(win.getByTestId(CHROME_TESTIDS.titleButtons), '-webkit-app-region')).toBe('no-drag');
});

test('AC10a: the activity bar has six rail buttons plus the four footer buttons, and no ab-settings button', async () => {
  await expect(win.getByTestId('activity-bar').locator('button'), 'positive control: the activity bar renders').toHaveCount(10);
  await expect(win.getByTestId('ab-settings')).toHaveCount(0);
  await expect(win.getByTestId('activity-bar').getByTestId('settings-open')).toBeVisible();
});

/* ─────────────────────────────── palette x theme matrix ─────────────────────────────── */

test('AC1/AC3/AC10–AC13/AC15/AC25–AC28: chrome dimensions, badges and branch colour hold in every palette and theme', async () => {
  await selectProject('chromed');
  await expect.poll(() => statusBranch(win), { timeout: 10000 }).toBe('main');
  const gitBadge = win.locator('[data-testid="ab-git"] [data-tone]');
  const taskBadge = win.locator('[data-testid="ab-tasks"] [data-tone]');
  await expect(gitBadge, 'AC14: 150 changes cap at 99+').toHaveText('99+', { timeout: 10000 });
  await expect(taskBadge).toHaveText('3');

  const look = await currentLook(win);
  try {
    for (const palette of PALETTES) {
      for (const theme of THEMES) {
        const at = `${palette}/${theme}`;
        await setLook(win, palette, theme);

        // AC10
        const bar = win.getByTestId('activity-bar');
        expect((await box(bar)).width, `${at} activity bar width`).toBe(64);
        const buttons = bar.locator('button');
        expect(await buttons.count(), `${at} AC10a: six rail buttons and four footer buttons`).toBe(10);
        for (const b of await buttons.all()) {
          // The AI usage meter stacks its weekly bars under the icon, so it is taller than 44px.
          if ((await b.getAttribute('data-testid')) === 'ab-usage') continue;
          const label = await b.getAttribute('aria-label');
          const r = await box(b);
          expect([r.width, r.height], `${at} ${label} size`).toEqual([44, 44]);
          expect(await radii(b), `${at} ${label} radius`).toEqual(['10px', '10px', '10px', '10px']);
          const icon = await box(b.locator('svg').first());
          expect([icon.width, icon.height], `${at} ${label} icon`).toEqual([16, 16]);
        }

        // AC11–AC13 for both tones
        for (const [tone, badge, button, solid, softText] of [
          ['accent', gitBadge, win.getByTestId('ab-git'), '--accent', '--badge-accent-text'],
          ['orange', taskBadge, win.getByTestId('ab-tasks'), '--hue-orange', '--hue-orange-soft-text'],
        ] as const) {
          const what = `${at} ${tone} badge`;
          await expect(badge).toHaveAttribute('data-tone', tone);
          const bb = await box(badge);
          const btn = await box(button);
          expect(bb.y - btn.y, `${what} top inset`).toBeGreaterThanOrEqual(2);
          expect(bb.y - btn.y, `${what} top inset`).toBeLessThanOrEqual(4);
          const right = btn.x + btn.width - (bb.x + bb.width);
          expect(right, `${what} right inset`).toBeGreaterThanOrEqual(0);
          expect(right, `${what} right inset`).toBeLessThanOrEqual(2);
          expect(bb.height, `${what} height`).toBe(16);
          expect(bb.width, `${what} width`).toBeGreaterThanOrEqual(16);
          expect(await css(badge, 'min-width'), `${what} min-width`).toBe('16px');
          expect(await radii(badge), `${what} radius`).toEqual(['8px', '8px', '8px', '8px']);
          expect(await css(badge, 'font-size'), `${what} font size`).toBe('10px');
          expect(await css(badge, 'font-weight'), `${what} font weight`).toBe('600');

          const fill = await elementColour(win, badge, 'background-color');
          const hue = await resolveToken(win, solid);
          expect(fill.a < 1 || colourDistance(fill, hue) > 2, `${what} fill ${fmtColour(fill)} is a soft tint, not solid ${fmtColour(hue)}`).toBe(true);
          const text = await elementColour(win, badge, 'color');
          const wantText = await resolveToken(win, softText);
          expect(colourDistance(text, wantText), `${what} text ${fmtColour(text)} is ${softText} ${fmtColour(wantText)}`).toBeLessThanOrEqual(2);
          const c = await badgeContrast(win, badge, theme);
          // Soft, so one run reports every palette x theme that falls short.
          expect.soft(c.ratio, `${what} contrast (text ${fmtColour(c.text)} on fill ${fmtColour(c.fill)} over ${c.under.map(fmtColour).join(' > ')})`)
            .toBeGreaterThanOrEqual(4.5);
        }

        // AC15 (fresh HOME, no stored width)
        expect((await box(win.locator('aside[data-view="projects"]'))).width, `${at} sidebar width`).toBe(SIDEBAR_WIDTH.default);

        // AC25
        const main = win.locator('main').first();
        expect(await radii(main), `${at} sheet radius (rounded while the status bar shows)`).toEqual(['14px', '14px', '14px', '14px']);
        expect(await css(main, 'margin-right'), `${at} sheet right margin`).toBe('8px');

        // AC26: compact tabs (28px, 8px side padding) with more room around and between them.
        const tabBar = win.getByTestId(DIFF_TESTIDS.tabBar);
        expect([await css(tabBar, 'padding-top'), await css(tabBar, 'padding-left'), await css(tabBar, 'column-gap')], `${at} tab bar spacing`).toEqual(['10px', '12px', '6px']);
        for (const [label, tab] of [
          ['Shell', tabBar.getByRole('button', { name: 'Shell', exact: true })],
          ['Files', tabBar.getByRole('button', { name: 'Files', exact: true })],
          ['Diff', win.getByTestId(DIFF_TESTIDS.tab)],
          [PROJECT_SETTINGS_COPY.tab, win.getByTestId(PROJECT_SETTINGS_TESTIDS.tab)],
        ] as const) {
          expect((await box(tab)).height, `${at} ${label} tab height`).toBe(28);
          expect([await css(tab, 'padding-left'), await css(tab, 'padding-right')], `${at} ${label} tab padding`).toEqual(['8px', '8px']);
          expect(await radii(tab), `${at} ${label} tab radius`).toEqual(['8px', '8px', '8px', '8px']);
        }

        // AC27
        const status = win.getByTestId('status-bar');
        expect((await box(status)).height, `${at} status bar height`).toBe(34);
        expect(await css(status, 'font-size'), `${at} status bar font size`).toBe('12px');
        const hints = await status.locator('kbd').evaluateAll((kbds) => kbds.map((k) => (k.parentElement?.textContent ?? '').trim()));
        expect(hints, `${at} the single palette hint`).toEqual(STATUS_HINTS);
        await expect(status.getByText(/^v\d+\.\d+\.\d+/), `${at} version`).toBeVisible();
      }
    }
  } finally {
    await restoreLook(win, look);
  }
});

/**
 * macOS frosted chrome (docs/specs/macos-frosted-chrome.md D10, AC10):
 * on macOS the chat column sits directly on the chrome and deliberately
 * gets its own solid surface, `background-color: var(--sheet-solid)`
 * (frosted-chrome.css `[data-view="chat"]`) — a one-layer "tint" by design,
 * not a regression of this AC. Off macOS (and with `data-platform` absent,
 * i.e. Windows/Linux, AC25) nothing changes: the original "no tint at all"
 * assertion still holds for every view, chat included.
 */
test('AC24a: the projects, chat and git panels paint no section tint in any palette or theme (off mac); on mac the chat column wears exactly its own solid --sheet-solid surface (D10)', async () => {
  await selectProject('chromed');
  /** Every non-transparent layer between the panel (incl. its ::before/::after) and the window's chrome surface. */
  const tints = (view: string) => win.evaluate((v) => {
    const panel = document.querySelector(`[data-view="${v}"]`);
    if (!panel) throw new Error(`no ${v} panel`);
    const painted = (c: string) => c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent';
    const out: string[] = [];
    for (const pseudo of ['::before', '::after']) {
      const cs = getComputedStyle(panel, pseudo);
      if (cs.content !== 'none' && painted(cs.backgroundColor)) out.push(`${pseudo} ${cs.backgroundColor}`);
      if (cs.content !== 'none' && cs.backgroundImage !== 'none') out.push(`${pseudo} ${cs.backgroundImage}`);
    }
    let el: Element | null = panel;
    let surface: string | null = null;
    for (; el && el !== document.body; el = el.parentElement) {
      const bg = getComputedStyle(el).backgroundColor;
      if (el.classList.contains('h-screen')) { surface = bg; break; }
      if (painted(bg)) out.push(`${el.tagName}.${el.className.slice(0, 40)} ${bg}`);
    }
    if (!surface || !painted(surface)) throw new Error(`chrome surface behind the ${v} panel not found or transparent (${surface})`);
    return out;
  }, view);

  // Positive control: the probe sees a tint layer when one is injected.
  await win.evaluate(() => {
    const s = document.createElement('style');
    s.id = 'e2e-tint-control';
    s.textContent = '[data-view="projects"]::before { content: ""; background: rgba(255, 0, 0, 0.1); }';
    document.head.appendChild(s);
  });
  expect(await tints('projects'), 'positive control: an injected ::before tint is detected').toHaveLength(1);
  await win.evaluate(() => document.getElementById('e2e-tint-control')?.remove());

  const frosted = await isFrostedChrome(win);
  /**
   * The chat panel's own `<tag>.<classPrefix> <resolved --sheet-solid>`
   * entry, in the exact shape `tints()` emits for a painted element in its
   * ancestor walk — computed fresh per palette/theme (the solid colour
   * differs per combination; see frosted-chrome.css's per-palette blocks).
   */
  const expectedChatTint = (): Promise<string> =>
    win.evaluate(() => {
      const panel = document.querySelector('[data-view="chat"]');
      if (!panel) throw new Error('no chat panel');
      const probe = document.createElement('div');
      probe.style.backgroundColor = 'var(--sheet-solid)';
      document.body.appendChild(probe);
      const colour = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return `${panel.tagName}.${(panel as HTMLElement).className.slice(0, 40)} ${colour}`;
    });

  const look = await currentLook(win);
  try {
    for (const [view, open] of [['projects', null], ['chat', 'ab-chat'], ['git', 'ab-git']] as const) {
      if (open) await win.getByTestId(open).click();
      await expect(win.locator(`[data-view="${view}"]`)).toBeVisible();
      for (const palette of PALETTES) {
        for (const theme of THEMES) {
          await setLook(win, palette, theme);
          const at = `${palette}/${theme} ${view}`;
          const signedOut = view === 'chat' && (await win.locator('[data-view="chat"] > .chat-signin').count()) > 0;
          if (frosted && view === 'chat' && !signedOut) {
            // D10/AC10 (docs/specs/macos-frosted-chrome.md): on macOS the
            // signed-in chat column gets its own solid surface, painted
            // directly on the panel element itself (not a pseudo or ancestor
            // tint) — exactly one layer, exactly --sheet-solid. Signed out it
            // shows the chrome like the other sheets; off mac, unchanged.
            expect(await tints(view), `${at} panel tint layers (mac, D10)`).toEqual([await expectedChatTint()]);
          } else {
            expect(await tints(view), `${at} panel tint layers`).toEqual([]);
          }
        }
      }
      if (open) await win.getByTestId(open).click();
      await expect(win.locator(`[data-view="${view}"]`)).toHaveCount(view === 'projects' ? 1 : 0);
    }
  } finally {
    await restoreLook(win, look);
  }
});

test('AC9a/AC28: a popout shell window\'s title bar is 44px in every palette and theme, with its content unchanged', async () => {
  await selectProject('chromed');
  await expect(win.locator('[data-testid="shell-tab"] .xterm-screen')).toBeVisible({ timeout: 8000 });
  const [popout] = await Promise.all([
    app.waitForEvent('window'),
    win.getByTestId('popout-shell').click(),
  ]);
  try {
    await popout.waitForLoadState('domcontentloaded');
    const drag = popout.locator('.drag').first();
    await expect(drag.getByText('chromed', { exact: true })).toBeVisible({ timeout: 8000 });
    await expect(drag.getByText('Shell 0', { exact: true })).toBeVisible();
    await expect(drag.getByText('MetaLogix IDE', { exact: true })).toHaveCount(1);
    await expect(drag.getByTestId(AGENT_DOT.testId)).toHaveCount(1);
    for (const palette of PALETTES) {
      for (const theme of THEMES) {
        await setLook(popout, palette, theme);
        expect((await box(drag)).height, `${palette}/${theme} popout title bar height`).toBe(44);
      }
    }
  } finally {
    await popout.close();
  }
});

/* ─────────────────────────────── width migration (reloads; keep last) ─────────────────────────────── */

test('AC15: a stored 288 migrates once to 260, other widths are kept, and reset returns to 260', async () => {
  const aside = win.locator('aside[data-view="projects"]');
  const stored = () => win.evaluate((k) => localStorage.getItem(k), WIDTH_KEY);
  const reloadWith = async (width: string, clearMarker: boolean) => {
    await win.evaluate(({ k, m, width, clearMarker }) => {
      localStorage.setItem(k, width);
      if (clearMarker) localStorage.removeItem(m);
    }, { k: WIDTH_KEY, m: MIGRATED_KEY, width, clearMarker });
    await win.reload();
    await win.waitForLoadState('domcontentloaded');
    await expect(aside).toBeVisible();
  };

  // Fresh HOME: the default was stored on first mount and the marker set.
  expect(await stored()).toBe(String(SIDEBAR_WIDTH.default));
  expect(await win.evaluate((m) => localStorage.getItem(m), MIGRATED_KEY), 'migration marker set').toBe('1');

  // A pre-change install: 288 stored, no marker.
  await reloadWith('288', true);
  await expect.poll(async () => (await box(aside)).width).toBe(SIDEBAR_WIDTH.default);
  await expect.poll(stored).toBe(String(SIDEBAR_WIDTH.default));

  // After the migration a deliberate 288 is kept.
  await reloadWith('288', false);
  await expect.poll(async () => (await box(aside)).width).toBe(288);
  expect(await stored()).toBe('288');

  // Any other stored width is honoured, even before the migration has run.
  await reloadWith('320', true);
  await expect.poll(async () => (await box(aside)).width).toBe(320);
  expect(await stored()).toBe('320');

  // Reset on the resize handle.
  // Reset on the resize handle, with a real mouse: the handle must be hittable.
  await win.locator('[data-testid="sidebar-column"] + [data-testid="resize-handle"]').dblclick();
  await expect.poll(async () => (await box(aside)).width).toBe(SIDEBAR_WIDTH.default);
  await expect.poll(stored).toBe(String(SIDEBAR_WIDTH.default));
});
