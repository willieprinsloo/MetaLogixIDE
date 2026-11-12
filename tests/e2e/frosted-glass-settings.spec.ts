/**
 * macOS frosted-glass settings (docs/specs/macos-frosted-glass-settings.md),
 * the four dedicated settings and their live/first-paint/migration behaviour:
 * AC2 (migration), AC4 (live apply to main + popout), AC5 (first-paint, no
 * flash), AC8 (OFF -> ON restores levels), AC9 (disabled level controls),
 * AC19 (material change calls setVibrancy on every window), AC31 (live
 * terminal repaint on a lifted --term-fg).
 *
 * Same home as frosted-chrome.spec.ts: the built Electron app via
 * `_electron.launch`, real Chromium compositor, real React, real
 * frosted-chrome.css / frosted-glass-levels.css / styles.css. Mac-only:
 * every test skips off darwin first (Material, setVibrancy and the mac
 * first-paint value are macOS-only), then re-skips if frosted chrome
 * (`isFrostedChrome`, the `data-platform` attribute, which is "mac" on
 * darwin) was not actually observed (defends against a misconfigured CI
 * runner the same way frosted-chrome.spec.ts does). Linux coverage of the
 * shared group lives in linux-frosted-glass.spec.ts
 * (docs/specs/linux-wayland-frosted-glass.md AC7, AC8, AC12, AC13).
 *
 * Settings persist to `$HOME/.metaide/metaide.db` (services.ts
 * `buildServices`), not to Electron's `--user-data-dir` — every relaunch
 * test below reuses the same `home`, never a fresh one.
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import electronBinaryPath from 'electron';
import { FROST_ATTR, FROSTED_GLASS_COPY, FROSTED_GLASS_TESTIDS } from '../../src/renderer/frosted-chrome-contract';
import type { ChromeFrostLevel, TerminalFrostLevel } from '../../src/shared/frosted-glass';
import { isFrostedChrome, resolveColour } from './helpers/chrome-colour';
import { closeApp, guardedLaunch } from './helpers/claude-harness';

const PROJECT = 'glassproj';
type Api = { invoke: (c: string, r: unknown) => Promise<unknown> };

interface Launched {
  app: ElectronApplication;
  win: Page;
  home: string;
  root: string;
  cleanup: () => void;
}

/** Launches an isolated-profile app with one project and a shell tab already open. */
async function launchGlassApp(opts: { home?: string; userDataDir?: string } = {}): Promise<Launched> {
  return guardedLaunch(async (scope) => {
    const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
    const home = opts.home ?? scope.tempDir('metaide-glass-home-');
    const root = scope.tempDir('metaide-glass-root-');
    const proj = join(root, PROJECT);
    mkdirSync(proj);
    mkdirSync(join(proj, '.git'));
    const userDataDir = opts.userDataDir ?? join(home, 'userData');
    const app = scope.own(await electron.launch({
      args: ['.', `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        HOME: home,
        SHELL: '/bin/sh',
        METAIDE_TEST_MODE: '1',
        METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
        METAIDE_DEFAULT_LAUNCH_FIRST: JSON.stringify({ argv: ['node', mockClaude], env: {} }),
        METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: ['node', mockClaude, '--continue'], env: {} }),
      },
    }));
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.evaluate(async (path: string) => {
      await (window as unknown as { api: Api }).api.invoke('roots:add', { path });
    }, root);
    const projectRow = win.getByTestId('project-row').filter({ hasText: PROJECT }).first();
    await expect(projectRow).toBeVisible({ timeout: 10000 });
    await projectRow.click();
    await expect(win.getByTestId('shell-tab')).toBeVisible({ timeout: 10000 });
    return {
      app,
      win,
      home,
      root,
      cleanup: () => {
        rmSync(home, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
      },
    };
  });
}

async function openSettings(win: Page): Promise<void> {
  await win.getByTestId('settings-open').click();
  await expect(win.getByTestId('settings-modal')).toBeVisible();
}

async function closeSettings(win: Page): Promise<void> {
  await win.getByTestId('settings-done').click();
  await expect(win.getByTestId('settings-modal')).toHaveCount(0);
}

function levelRadio(win: Page, group: string, label: string) {
  return win.getByTestId(group).getByRole('radio', { name: label });
}

/** Reads a settings value through the real `settings:get` IPC round-trip. */
async function storedValue(win: Page, key: string): Promise<unknown> {
  return win.evaluate(async (k: string) => {
    const r = await (window as unknown as { api: Api }).api.invoke('settings:get', { key: k }) as { value: unknown };
    return r.value;
  }, key);
}

/** Opens Settings, sets Chrome frost and/or Terminal frost, and closes. Frosted chrome must already be ON. */
async function setLevels(win: Page, levels: { chrome?: ChromeFrostLevel; terminal?: TerminalFrostLevel }): Promise<void> {
  await openSettings(win);
  if (levels.chrome) {
    await levelRadio(win, FROSTED_GLASS_TESTIDS.chromeFrost, FROSTED_GLASS_COPY.levels[levels.chrome]).click();
    await expect.poll(() => storedValue(win, 'chrome_frost_level'), { timeout: 2000 }).toBe(levels.chrome);
  }
  if (levels.terminal) {
    await levelRadio(win, FROSTED_GLASS_TESTIDS.terminalFrost, FROSTED_GLASS_COPY.levels[levels.terminal]).click();
    await expect.poll(() => storedValue(win, 'terminal_frost_level'), { timeout: 2000 }).toBe(levels.terminal);
  }
  await closeSettings(win);
}

async function setFrostChrome(win: Page, on: boolean): Promise<void> {
  await openSettings(win);
  const toggle = win.getByTestId(FROSTED_GLASS_TESTIDS.frostChrome);
  if ((await toggle.isChecked()) !== on) await toggle.click();
  await expect.poll(() => storedValue(win, 'frost_chrome'), { timeout: 2000 }).toBe(on);
  await closeSettings(win);
}

/**
 * Seeds raw settings rows directly in the SQLite file, run through the project's own Electron
 * binary in `ELECTRON_RUN_AS_NODE=1` mode (same technique as terminal-font-weight.spec.ts
 * AC9 and tests/unit/main/claude-hooks/receiver.test.ts): `better-sqlite3`'s native binding is
 * built against Electron's own Node ABI, which does not load under the plain Node.js the
 * Playwright runner uses, and neither `require` nor dynamic `import()` exists inside
 * `electronApplication.evaluate`'s injected script. Running the app's own binary as plain
 * Node sidesteps both.
 */
async function seedRows(home: string, rows: Array<{ key: string; value: unknown }>, deleteKeys: string[] = []): Promise<void> {
  const dbPath = join(home, '.metaide', 'metaide.db');
  const upsert = 'const Database = require(\'better-sqlite3\'); const db = new Database(' + JSON.stringify(dbPath) + ');'
    + 'const up = db.prepare(\'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value\');'
    + 'const del = db.prepare(\'DELETE FROM settings WHERE key = ?\');';
  const script = upsert
    + rows.map((r) => `up.run(${JSON.stringify(r.key)}, ${JSON.stringify(JSON.stringify(r.value))});`).join('')
    + deleteKeys.map((k) => `del.run(${JSON.stringify(k)});`).join('')
    + 'db.close();';
  await promisify(execFile)(electronBinaryPath as unknown as string, ['-e', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
}

/* ─────────────────────────────── AC4: live apply, main + popout, no reload ─────────────────────────────── */

test('AC4: changing each setting reaches the main window and an open popout live, with no reload', async () => {
  test.skip(process.platform !== 'darwin', 'mac-only settings group');
  const l = await launchGlassApp();
  try {
    const { app, win } = l;
    test.skip(!(await isFrostedChrome(win)), 'data-platform (frosted chrome) was not set');

    const [popout] = await Promise.all([
      app.waitForEvent('window'),
      win.getByTestId('popout-shell').click(),
    ]);
    await popout.waitForLoadState('domcontentloaded');
    await expect(popout.getByTestId('shell-tab')).toBeVisible({ timeout: 8000 });

    // Positive control: Subtle (default) omits data-chrome-frost / data-terminal-frost
    // (applyRootFlags), so both attributes start absent on both windows.
    for (const w of [win, popout]) {
      expect(await w.evaluate((a: string) => document.documentElement.hasAttribute(a), FROST_ATTR.chromeFrost), 'control: chrome frost attr starts absent at Subtle').toBe(false);
      expect(await w.evaluate((a: string) => document.documentElement.hasAttribute(a), FROST_ATTR.terminalFrost), 'control: terminal frost attr starts absent at Off').toBe(false);
    }

    await setLevels(win, { chrome: 'medium', terminal: 'medium' });

    for (const [name, w] of [['main', win], ['popout', popout]] as const) {
      await expect.poll(() => w.evaluate((a: string) => document.documentElement.getAttribute(a), FROST_ATTR.chromeFrost), { timeout: 1000, message: `${name}: chrome frost reaches medium, no reload` }).toBe('medium');
      await expect.poll(() => w.evaluate((a: string) => document.documentElement.getAttribute(a), FROST_ATTR.terminalFrost), { timeout: 1000, message: `${name}: terminal frost reaches medium, no reload` }).toBe('medium');
    }

    // Frosted chrome OFF reaches both windows too: every mac flag drops at once (AC7 of the
    // prior spec, re-proved live here for the new switch).
    await setFrostChrome(win, false);
    for (const [name, w] of [['main', win], ['popout', popout]] as const) {
      await expect.poll(() => w.evaluate((a: string) => document.documentElement.hasAttribute(a), FROST_ATTR.platform), { timeout: 1000, message: `${name}: data-platform drops live when Frosted chrome goes OFF` }).toBe(false);
    }

    await Promise.all([popout.waitForEvent('close'), (await app.browserWindow(popout)).evaluate((w) => w.close())]);
  } finally {
    await closeApp(l.app);
    l.cleanup();
  }
});

/* ─────────────────────────────── AC5: first paint, no flash ─────────────────────────────── */

test('AC5: a relaunched window renders the stored chrome/level flags on first paint, no flash of the defaults', async () => {
  test.skip(process.platform !== 'darwin', 'mac-only settings group');
  const home = mktempHome();
  const first = await launchGlassApp({ home });
  try {
    test.skip(!(await isFrostedChrome(first.win)), 'data-platform (frosted chrome) was not set');
    await setLevels(first.win, { chrome: 'strong', terminal: 'medium' });
  } finally {
    await first.app.close();
  }

  const second = await launchGlassApp({ home });
  try {
    const { win } = second;
    const flags = await win.evaluate((a: typeof FROST_ATTR) => ({
      platform: document.documentElement.getAttribute(a.platform),
      chrome: document.documentElement.getAttribute(a.chromeFrost),
      terminal: document.documentElement.getAttribute(a.terminalFrost),
    }), FROST_ATTR);
    expect(flags, 'the stored levels are already on the root at first observable paint, no flash').toEqual({ platform: 'mac', chrome: 'strong', terminal: 'medium' });

    // Positive control: a fresh (never-touched) profile boots at the no-effect defaults, so
    // the above is the persisted value doing something, not an always-on flag.
    const fresh = await launchGlassApp({});
    try {
      const freshFlags = await fresh.win.evaluate((a: typeof FROST_ATTR) => ({
        chrome: document.documentElement.getAttribute(a.chromeFrost),
        terminal: document.documentElement.getAttribute(a.terminalFrost),
      }), FROST_ATTR);
      expect(freshFlags, 'control: a fresh profile starts at Subtle/Off (no attrs)').toEqual({ chrome: null, terminal: null });
    } finally {
      await closeApp(fresh.app);
      fresh.cleanup();
    }
  } finally {
    await closeApp(second.app);
    second.cleanup();
  }
});

function mktempHome(): string {
  return mkdtempSync(join(tmpdir(), 'metaide-glass-relaunch-'));
}

/* ─────────────────────────────── AC8: OFF -> ON restores levels ─────────────────────────────── */

test('AC8: Frosted chrome OFF then ON restores the previously chosen levels; other settings are untouched', async () => {
  test.skip(process.platform !== 'darwin', 'mac-only settings group');
  const l = await launchGlassApp();
  try {
    const { win } = l;
    test.skip(!(await isFrostedChrome(win)), 'data-platform (frosted chrome) was not set');

    await setLevels(win, { chrome: 'strong', terminal: 'medium' });
    await openSettings(win);
    await win.getByTestId(FROSTED_GLASS_TESTIDS.material).selectOption('hud');
    await expect.poll(() => storedValue(win, 'vibrancy_material'), { timeout: 2000 }).toBe('hud');
    await closeSettings(win);

    await setFrostChrome(win, false);
    await expect(win.evaluate((a: string) => document.documentElement.hasAttribute(a), FROST_ATTR.platform)).resolves.toBe(false);
    // Material stays enabled and keeps its value while OFF (D13).
    await openSettings(win);
    await expect(win.getByTestId(FROSTED_GLASS_TESTIDS.material)).toHaveValue('hud');
    await expect(win.getByTestId(FROSTED_GLASS_TESTIDS.material)).toBeEnabled();
    await closeSettings(win);

    await setFrostChrome(win, true);
    await expect.poll(() => win.evaluate((a: string) => document.documentElement.getAttribute(a), FROST_ATTR.chromeFrost), { timeout: 1000, message: 'chrome frost restores to strong, not reset to subtle' }).toBe('strong');
    expect(await win.evaluate((a: string) => document.documentElement.getAttribute(a), FROST_ATTR.terminalFrost), 'terminal frost restores to medium').toBe('medium');
    expect(await storedValue(win, 'vibrancy_material'), 'material is unchanged by the OFF/ON round trip').toBe('hud');
  } finally {
    await closeApp(l.app);
    l.cleanup();
  }
});

/* ─────────────────────────────── AC9: disabled level controls ─────────────────────────────── */

test('AC9: with Frosted chrome OFF, the level controls are disabled, say why, and keep their values readable', async () => {
  test.skip(process.platform !== 'darwin', 'mac-only settings group');
  const l = await launchGlassApp();
  try {
    const { win } = l;
    test.skip(!(await isFrostedChrome(win)), 'data-platform (frosted chrome) was not set');

    await setLevels(win, { chrome: 'medium', terminal: 'strong' });
    await setFrostChrome(win, false);
    await openSettings(win);

    for (const [group, label] of [
      [FROSTED_GLASS_TESTIDS.chromeFrost, FROSTED_GLASS_COPY.levels.medium],
      [FROSTED_GLASS_TESTIDS.terminalFrost, FROSTED_GLASS_COPY.levels.strong],
    ] as const) {
      const radio = levelRadio(win, group, label);
      await expect(radio, `${group}: the chosen level stays visible/checked while disabled`).toHaveAttribute('aria-checked', 'true');
      await expect(radio).toHaveAttribute('aria-disabled', 'true');
      await expect(radio).toBeDisabled();
    }
    await expect(win.getByText(FROSTED_GLASS_COPY.disabledReason).first()).toBeVisible();
    // Positive control: re-enabling clears the disabled state (not a static "always disabled" row).
    await closeSettings(win);
    await setFrostChrome(win, true);
    await openSettings(win);
    await expect(levelRadio(win, FROSTED_GLASS_TESTIDS.chromeFrost, FROSTED_GLASS_COPY.levels.medium)).not.toBeDisabled();
    await closeSettings(win);
  } finally {
    await closeApp(l.app);
    l.cleanup();
  }
});

/* ─────────────────────────────── AC19: material change -> setVibrancy on every window ─────────────────────────────── */

test('AC19: changing the material calls setVibrancy exactly once on every open, non-destroyed window', async () => {
  test.skip(process.platform !== 'darwin', 'mac-only settings group');
  const l = await launchGlassApp();
  try {
    const { app, win } = l;
    test.skip(!(await isFrostedChrome(win)), 'data-platform (frosted chrome) was not set');

    // Patch every currently-open window's setVibrancy to record calls, and patch future
    // windows (the popout) the same way via browser-window-created.
    await app.evaluate(({ app: a, BrowserWindow }) => {
      const calls: Record<number, string[]> = {};
      (globalThis as unknown as Record<string, unknown>).__vibrancyCalls = calls;
      function patch(w: ReturnType<typeof BrowserWindow.getAllWindows>[number]): void {
        calls[w.id] = [];
        const orig = w.setVibrancy.bind(w);
        w.setVibrancy = (m) => { calls[w.id]!.push(String(m)); orig(m); };
      }
      for (const w of BrowserWindow.getAllWindows()) patch(w);
      a.on('browser-window-created', (_e, w) => patch(w));
    });

    const [popout] = await Promise.all([
      app.waitForEvent('window'),
      win.getByTestId('popout-shell').click(),
    ]);
    await popout.waitForLoadState('domcontentloaded');
    await expect(popout.getByTestId('shell-tab')).toBeVisible({ timeout: 8000 });

    await openSettings(win);
    await win.getByTestId(FROSTED_GLASS_TESTIDS.material).selectOption('popover');
    await expect.poll(() => storedValue(win, 'vibrancy_material'), { timeout: 2000 }).toBe('popover');
    await closeSettings(win);

    const calls = await app.evaluate(() => (globalThis as unknown as Record<string, unknown>).__vibrancyCalls as Record<number, string[]>);
    const windowCount = Object.keys(calls).length;
    expect(windowCount, 'both the main window and the popout were patched').toBeGreaterThanOrEqual(2);
    for (const [id, recorded] of Object.entries(calls)) {
      expect(recorded, `window ${id}: setVibrancy called exactly once with the new material`).toEqual(['popover']);
    }

    await Promise.all([popout.waitForEvent('close'), (await app.browserWindow(popout)).evaluate((w) => w.close())]);
  } finally {
    await closeApp(l.app);
    l.cleanup();
  }
});

/* ─────────────────────────────── AC2: migration from the legacy frost_terminal boolean ─────────────────────────────── */

test('AC2: an upgrading profile with a stored frost_terminal=true migrates to terminal frost Subtle, once, without overwriting a later user choice', async () => {
  test.skip(process.platform !== 'darwin', 'mac-only settings group');
  const home = mktempHome();
  // First run creates the `settings` table and seeds today's defaults (terminal_frost_level
  // migrates from an absent frost_terminal to 'off', since there is no legacy row yet).
  const boot = await launchGlassApp({ home });
  test.skip(!(await isFrostedChrome(boot.win)), 'data-platform (frosted chrome) was not set');
  await boot.app.close();

  // Simulate "a build that has not yet seen terminal_frost_level": drop the row the first
  // run just seeded, and write the legacy boolean a pre-upgrade build would have left.
  await seedRows(home, [{ key: 'frost_terminal', value: true }], ['terminal_frost_level']);

  const migrated = await launchGlassApp({ home });
  try {
    expect(await storedValue(migrated.win, 'terminal_frost_level'), 'AC2: frost_terminal=true migrates to Subtle').toBe('subtle');
    expect(await storedValue(migrated.win, 'frost_terminal'), 'the legacy row itself is left in place (D4/D19), never written').toBe(true);

    // The user now picks a different level explicitly.
    await setLevels(migrated.win, { terminal: 'off' });
  } finally {
    await migrated.app.close();
  }

  // A later start must not re-run the migration and clobber the user's own choice, even
  // though the legacy row still reads `true`.
  const after = await launchGlassApp({ home });
  try {
    expect(await storedValue(after.win, 'terminal_frost_level'), 'the migration does not rerun and overwrite a later user choice').toBe('off');
  } finally {
    await closeApp(after.app);
    after.cleanup();
  }
});

/* ─────────────────────────────── AC31: live terminal repaint on the lifted --term-fg ─────────────────────────────── */

test('AC31: switching chrome to Strong with terminal Subtle repaints a running terminal\'s foreground, no reopen', async () => {
  test.skip(process.platform !== 'darwin', 'mac-only settings group');
  const l = await launchGlassApp();
  try {
    const { win } = l;
    test.skip(!(await isFrostedChrome(win)), 'data-platform (frosted chrome) was not set');

    // D14's lift only applies in catppuccin and rose-pine light at chrome Medium/Strong
    // with a terminal level other than Off. Set through the real Theme/Mode controls
    // (settings-board.spec.ts `applyAppearance` pattern) rather than poking
    // data-palette/data-theme directly: useTheme's own effect re-applies its state from
    // React on every render the dialog causes, so a hand-set attribute does not survive
    // the later setLevels() round trips below.
    await openSettings(win);
    await win.getByTestId('settings-modal').getByRole('button', { name: 'Catppuccin', exact: true }).click();
    await win.getByTestId('settings-modal').getByRole('radio', { name: 'Light', exact: true }).click();
    await expect(win.locator('html')).toHaveAttribute('data-palette', 'catppuccin');
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'light');
    await closeSettings(win);

    // Force the DOM renderer fallback (same technique as terminal-font-weight.spec.ts
    // loseWebglContext): lose the live WebGL context so the addon disposes after its
    // fixed 3000ms grace window and xterm falls back to painting `.xterm-rows` in the DOM,
    // where a plain getComputedStyle read can see the live foreground colour.
    const lost = await win.evaluate(() => {
      const canvases = [...document.querySelectorAll<HTMLCanvasElement>('.xterm canvas')];
      for (const canvas of canvases) {
        const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
        const ext = gl?.getExtension('WEBGL_lose_context');
        if (ext) { ext.loseContext(); return true; }
      }
      return false;
    });
    expect(lost, 'a live WebGL context was found to force-lose').toBe(true);
    await expect.poll(
      () => win.evaluate(() => !!document.querySelector('.xterm-rows span')),
      { timeout: 6000, message: 'the DOM renderer fallback (.xterm-rows) appears with at least one painted span' },
    ).toBe(true);

    const readFg = () => win.locator('.xterm-rows span').first().evaluate((el) => getComputedStyle(el).color);
    const before = await resolveColour(win, await readFg());

    // Today's look (chrome Subtle, terminal Off) is the default; move to chrome Strong /
    // terminal Subtle, which is exactly the D14 lift's trigger in this palette/theme.
    await setLevels(win, { chrome: 'strong', terminal: 'subtle' });
    await expect(win.locator('html')).toHaveAttribute('data-palette', 'catppuccin');

    await expect.poll(async () => {
      const after = await resolveColour(win, await readFg());
      return after.r === before.r && after.g === before.g && after.b === before.b;
    }, { timeout: 3000, message: 'the live --term-fg lift repaints the terminal with no reopen' }).toBe(false);

    // Positive control / reversibility: back to Subtle chrome restores today's colour.
    await setLevels(win, { chrome: 'subtle', terminal: 'off' });
    await expect.poll(async () => {
      const reverted = await resolveColour(win, await readFg());
      return reverted.r === before.r && reverted.g === before.g && reverted.b === before.b;
    }, { timeout: 3000, message: 'switching back restores the original colour' }).toBe(true);
  } finally {
    await closeApp(l.app);
    l.cleanup();
  }
});
