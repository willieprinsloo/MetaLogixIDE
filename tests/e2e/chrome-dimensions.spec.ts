import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CHROME_TESTIDS } from '../../src/renderer/chrome-testids';
import { SIDEBAR_WIDTH } from '../../src/renderer/sidebar-width';
import { DIFF_TESTIDS } from '../../src/renderer/diff-tab-copy';
import { ENV_TESTIDS } from '../../src/renderer/project-env-copy';
import { PROJECT_SETTINGS_COPY, PROJECT_SETTINGS_TESTIDS } from '../../src/renderer/project-settings-contract';
import { AGENT_DOT } from '../../src/shared/agent-state';
import { PALETTE_COPY } from '../../src/renderer/command-palette-contract';
import type { EffectiveTheme } from '../../src/renderer/markdown/contract';
import { commitAll, git, GIT_ENV, initRepo, porcelain } from './helpers/git-repo';
import { badgeContrast, colourDistance, elementColour, fmtColour, isMacPlatform, resolveToken } from './helpers/chrome-colour';

/**
 * Shell chrome dimensions and the centred title
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
 * Tests run in file order and share the app: the no-project title is read
 * before any project is opened, and the width-migration test reloads, so it
 * runs last.
 */

const PALETTES = ['default', 'catppuccin', 'rose-pine'] as const;
const THEMES: readonly EffectiveTheme[] = ['dark', 'light'];
const LONG_BRANCH = `feature/${'x'.repeat(192)}`;
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
  const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
  isolatedHome = mkdtempSync(join(tmpdir(), 'metaide-dims-home-'));
  demoRoot = mkdtempSync(join(tmpdir(), 'metaide-dims-root-'));
  seed(demoRoot);

  app = await electron.launch({
    args: ['.', `--user-data-dir=${join(isolatedHome, 'userData')}`],
    env: {
      ...process.env,
      HOME: isolatedHome,
      METAIDE_TEST_MODE: '1',
      METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
      METAIDE_DEFAULT_LAUNCH_FIRST:      JSON.stringify({ argv: ['node', mockClaude],              env: {} }),
      METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: ['node', mockClaude, '--continue'], env: {} }),
    },
  });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await resizeMain(1440, 900);
  await win.evaluate(async (path: string) => {
    const api = (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } }).api;
    await api.invoke('roots:add', { path });
  }, demoRoot);
  for (const name of ['chromed', 'branchy', 'plain']) await expect(projectRow(name)).toBeVisible({ timeout: 5000 });
});

test.afterAll(async () => {
  await app?.close();
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
  await expect(win.getByTestId(CHROME_TESTIDS.titleName)).toHaveText(name);
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

function titleBranch(): Locator {
  return win.getByTestId(CHROME_TESTIDS.titleBranch);
}

/** Midpoint of the title group minus the window's centre. */
async function titleOffCentre(): Promise<number> {
  const g = await box(win.getByTestId(CHROME_TESTIDS.titleGroup));
  const inner = await win.evaluate(() => window.innerWidth);
  return g.x + g.width / 2 - inner / 2;
}

async function expectCentredAt(widths: number[]): Promise<void> {
  for (const w of widths) {
    await resizeMain(w, 900);
    await expect.poll(async () => Math.abs(await titleOffCentre()), { message: `title group centred at width ${w}` })
      .toBeLessThanOrEqual(2);
  }
  await resizeMain(1440, 900);
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

async function projectId(name: string): Promise<number> {
  return win.evaluate(async (n) => {
    const api = (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<{ projects: { id: number; name: string }[] }> } }).api;
    const { projects } = await api.invoke('projects:list', undefined);
    const p = projects.find((x) => x.name === n);
    if (!p) throw new Error(`no project ${n}`);
    return p.id;
  }, name);
}

/* ─────────────────────────────── title ─────────────────────────────── */

test('AC5/AC6/AC2: with no project the title reads "MetaLogix IDE", has no branch, and is centred', async () => {
  const name = win.getByTestId(CHROME_TESTIDS.titleName);
  await expect(name, 'positive control: the title renders').toHaveText('MetaLogix IDE');
  await expect(win.getByTestId('status-bar'), 'no project is selected').toContainText('no project');
  await expect(titleBranch()).toHaveCount(0);
  expect(await css(name, 'font-size')).toBe('12.5px');
  await expectCentredAt([1440, 1000]);
});

test('AC6/AC31/AC3/AC4/AC2: a git project shows its name and branch, matches the status bar, and stays centred', async () => {
  await selectProject('chromed');
  await expect(win.locator('[data-testid="shell-tab"]')).toBeVisible({ timeout: 5000 });
  expect(await win.title(), 'document title format is unchanged').toBe('chromed — MetaLogix IDE');
  await expect(titleBranch()).toHaveText('main', { timeout: 10000 });
  await expect.poll(() => statusBranch(win), { message: 'status bar shows the same branch' }).toBe('main');
  expect(await css(win.getByTestId(CHROME_TESTIDS.titleName), 'font-size')).toBe('12.5px');
  await expectCentredAt([1440, 1000]);
});

test('AC5: a non-repo project shows its name, no branch, and stays centred', async () => {
  const id = await projectId('plain');
  const status = await win.evaluate(async (projectId) => {
    const api = (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<{ isRepo: boolean }> } }).api;
    return api.invoke('git:status', { projectId });
  }, id);
  expect(status.isRepo, 'input state: the app sees plain as a non-repo').toBe(false);

  await selectProject('plain');
  await expect(win.getByTestId('status-bar'), 'positive control: the status bar switched to plain').toContainText('plain');
  await expect(titleBranch()).toHaveCount(0);
  await expectCentredAt([1440, 1000]);
});

test('AC4/AC14: the branch follows a checkout and detached HEAD in title and status bar; a clean repo shows no git badge', async () => {
  const dir = join(demoRoot, 'branchy');
  await selectProject('branchy');
  await expect(titleBranch()).toHaveText('main', { timeout: 10000 });
  await expect(win.locator('[data-testid="ab-tasks"] [data-tone]'), 'positive control: the tasks badge renders').toHaveText('1');
  await expect(win.locator('[data-testid="ab-git"] [data-tone]'), 'clean tree (0 changes): no git badge').toHaveCount(0);

  git(dir, ['checkout', '-q', '-b', 'feature/title-bar']);
  await expect.poll(async () => [await titleBranch().textContent(), await statusBranch(win)], { timeout: 10000 })
    .toEqual(['feature/title-bar', 'feature/title-bar']);

  git(dir, ['checkout', '-q', '--detach']);
  await expect.poll(async () => [await titleBranch().textContent(), await statusBranch(win)], { timeout: 10000 })
    .toEqual(['HEAD', 'HEAD']);
});

test('AC7: a 200-character branch truncates with an ellipsis and stays clear of the traffic lights and buttons at 1000px', async () => {
  const dir = join(demoRoot, 'branchy');
  expect(LONG_BRANCH).toHaveLength(200);
  git(dir, ['checkout', '-q', '-b', LONG_BRANCH]);
  await selectProject('branchy');
  await resizeMain(1000, 900);
  try {
    await expect(titleBranch()).toHaveText(LONG_BRANCH, { timeout: 10000 });
    const group = await box(win.getByTestId(CHROME_TESTIDS.titleGroup));
    const buttons = await box(win.getByTestId(CHROME_TESTIDS.titleButtons));
    const name = await box(win.getByTestId(CHROME_TESTIDS.titleName));
    expect(name.width, 'positive control: the project name is still shown').toBeGreaterThan(0);
    expect(group.x, 'title group clears the traffic-light zone').toBeGreaterThanOrEqual(76);
    expect(group.x + group.width, 'title group ends before the title buttons').toBeLessThanOrEqual(buttons.x);
    const overflow = await titleBranch().evaluate((el) => ({
      scroll: el.scrollWidth, client: el.clientWidth, ellipsis: getComputedStyle(el).textOverflow,
    }));
    expect(overflow.scroll, 'branch text overflows its box').toBeGreaterThan(overflow.client);
    expect(overflow.ellipsis).toBe('ellipsis');
  } finally {
    await resizeMain(1440, 900);
  }
});

test('AC8: title-bar buttons are 32x32 with an 8px radius, in the title-buttons group', async () => {
  const group = win.getByTestId(CHROME_TESTIDS.titleButtons);
  for (const id of ['theme-toggle', 'tile-windows', 'settings-open']) {
    const b = group.getByTestId(id);
    await expect(b, `${id} sits in the title-buttons group`).toBeVisible();
    const r = await box(b);
    expect([r.width, r.height], `${id} size`).toEqual([32, 32]);
    expect(await radii(b), `${id} radius`).toEqual(['8px', '8px', '8px', '8px']);
  }
  // AC8a: the last button's glyph ends 12px from the window's right edge.
  const glyph = await box(group.getByTestId('settings-open').locator('svg'));
  const inner = await win.evaluate(() => window.innerWidth);
  expect(Math.abs(inner - (glyph.x + glyph.width) - 12), `gear glyph right inset ${inner - (glyph.x + glyph.width)}px`).toBeLessThanOrEqual(1);
  expect(await css(win.locator('.drag').first(), 'padding-right')).toBe('3px');
});

test('AC10a: the activity bar has no Settings button; Settings stays reachable from the title-bar gear', async () => {
  await expect(win.getByTestId('activity-bar').locator('button'), 'positive control: the activity bar renders').toHaveCount(5);
  await expect(win.getByTestId('ab-settings')).toHaveCount(0);
  await expect(win.getByTestId(CHROME_TESTIDS.titleButtons).getByTestId('settings-open')).toBeVisible();
});

/* ─────────────────────────────── palette x theme matrix ─────────────────────────────── */

test('AC1/AC3/AC10–AC13/AC15/AC25–AC28: chrome dimensions, badges and branch colour hold in every palette and theme', async () => {
  await selectProject('chromed');
  await expect(titleBranch()).toHaveText('main', { timeout: 10000 });
  const gitBadge = win.locator('[data-testid="ab-git"] [data-tone]');
  const taskBadge = win.locator('[data-testid="ab-tasks"] [data-tone]');
  await expect(gitBadge, 'AC14: 150 changes cap at 99+').toHaveText('99+', { timeout: 10000 });
  await expect(taskBadge).toHaveText('3');

  const look = await currentLook(win);
  const mac = await isMacPlatform(win);
  try {
    for (const palette of PALETTES) {
      for (const theme of THEMES) {
        const at = `${palette}/${theme}`;
        await setLook(win, palette, theme);

        // AC1
        expect((await box(win.locator('.drag').first())).height, `${at} title bar height`).toBe(44);

        // AC10
        const bar = win.getByTestId('activity-bar');
        expect((await box(bar)).width, `${at} activity bar width`).toBe(56);
        const buttons = bar.locator('button');
        expect(await buttons.count(), `${at} AC10a: five activity bar buttons`).toBe(5);
        for (const b of await buttons.all()) {
          const label = await b.getAttribute('aria-label');
          const r = await box(b);
          expect([r.width, r.height], `${at} ${label} size`).toEqual([36, 36]);
          expect(await radii(b), `${at} ${label} radius`).toEqual(['10px', '10px', '10px', '10px']);
          const icon = await box(b.locator('svg').first());
          expect([icon.width, icon.height], `${at} ${label} icon`).toEqual([17, 17]);
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

        // AC3. The token is resolved beside the branch, so on macOS it reads the
        // chrome's D16 lift (docs/specs/macos-frosted-chrome.md); off mac nothing
        // overrides it and this equals the root value.
        const branchColour = await elementColour(win, titleBranch(), 'color');
        const pink = await resolveToken(win, '--hue-pink', titleBranch().locator('xpath=..'));
        expect(colourDistance(branchColour, pink), `${at} branch ${fmtColour(branchColour)} is --hue-pink ${fmtColour(pink)}`).toBeLessThanOrEqual(1);
        if (mac) {
          // Positive control: on mac the chrome pink is lifted away from the root (working-area) pink.
          const rootPink = await resolveToken(win, '--hue-pink');
          expect(colourDistance(pink, rootPink), `${at} control: chrome --hue-pink ${fmtColour(pink)} is lifted from root ${fmtColour(rootPink)}`).toBeGreaterThan(1);
        }

        // AC15 (fresh HOME, no stored width)
        expect((await box(win.locator('aside[data-view="projects"]'))).width, `${at} sidebar width`).toBe(SIDEBAR_WIDTH.default);

        // AC25
        const main = win.locator('main').first();
        expect(await radii(main), `${at} sheet radius`).toEqual(['14px', '14px', '14px', '14px']);
        expect(await css(main, 'margin-right'), `${at} sheet right margin`).toBe('8px');

        // AC26
        const tabBar = win.getByTestId(DIFF_TESTIDS.tabBar);
        for (const [label, tab] of [
          ['Shell', tabBar.getByRole('button', { name: 'Shell', exact: true })],
          ['Files', tabBar.getByRole('button', { name: 'Files', exact: true })],
          ['Diff', win.getByTestId(DIFF_TESTIDS.tab)],
          ['Env', win.getByTestId(ENV_TESTIDS.tab)],
          [PROJECT_SETTINGS_COPY.tab, win.getByTestId(PROJECT_SETTINGS_TESTIDS.tab)],
        ] as const) {
          expect((await box(tab)).height, `${at} ${label} tab height`).toBe(32);
          expect([await css(tab, 'padding-left'), await css(tab, 'padding-right')], `${at} ${label} tab padding`).toEqual(['12px', '12px']);
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

  const mac = await isMacPlatform(win);
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
          if (mac && view === 'chat') {
            // D10/AC10 (docs/specs/macos-frosted-chrome.md): on macOS the
            // chat column gets its own solid surface, painted directly on
            // the panel element itself (not a pseudo or ancestor tint) —
            // exactly one layer, exactly --sheet-solid. Off mac, unchanged
            // (the `else` branch below, which this view still hits there).
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
  await win.locator('aside[data-view="projects"] + [data-testid="resize-handle"]').dblclick();
  await expect.poll(async () => (await box(aside)).width).toBe(SIDEBAR_WIDTH.default);
  await expect.poll(stored).toBe(String(SIDEBAR_WIDTH.default));
});
