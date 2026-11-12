/**
 * macOS frosted-glass chrome: docs/specs/macos-frosted-chrome.md AC7, AC8,
 * AC17, AC21, AC25(c), AC27, AC28 (plan §8 "E2E (build Phase 5)"), reconciled
 * in Phase 5 (docs/specs/macos-frosted-glass-settings.md) against the landed
 * four-setting contract: the single `frost_terminal` boolean switch is gone
 * (D19). Every test here now drives the terminal-frost level (Off/Subtle)
 * with "Frosted chrome" left at its default ON, which reproduces the old
 * switch's OFF/ON behaviour exactly (AC14 of the new spec).
 *
 * Why this home can observe the behaviour: the suite drives the built
 * Electron app (real Chromium 128 compositor, the real frosted-chrome.css,
 * frosted-glass-levels.css and styles.css, real React) through
 * `_electron.launch`, the same pattern as window-opacity.spec.ts and
 * modal-glass.spec.ts. Computed `background-color` is read from the live
 * DOM and resolved through the canvas oracle in helpers/mermaid-palette.ts
 * (`resolveColour`), so `rgb(from ...)` and `color-mix()` are checked as
 * Chromium actually resolves them, not re-derived by the test.
 *
 * Mac-only: every test calls `test.skip(process.platform !== 'darwin', ...)`
 * first, because the frosted chrome, the setting's visible effect and the
 * `data-platform="mac"` attribute only exist on darwin with Frosted chrome
 * ON (AC13, AC25 of the prior spec; AC6/AC7 of this one). The re-skip uses
 * `isFrostedChrome` (attribute present); on darwin that is exactly
 * `data-platform="mac"`, so mac results are unchanged. Linux shares this
 * cascade but its coverage lives in linux-frosted-glass.spec.ts
 * (docs/specs/linux-wayland-frosted-glass.md AC6-AC8, AC21).
 *
 * Reconciled contract (Phase 5, against the real diff):
 *  - Root attributes: `[data-chrome-root]` on both the main and popout app
 *    roots (App.tsx ~779, ~1160); `data-sheet-content="shell"|"other"` on
 *    the main `<main>` sheet (App.tsx:930) and the popout sheet
 *    (App.tsx:1187), from FROST_ATTR (frosted-chrome-contract.ts). Unchanged
 *    from the pre-landing assumption.
 *  - Chat column selector: `[data-view="chat"]`; split card selectors
 *    `.split-left` and `[data-testid="split-right"]` (SPLIT_TESTIDS.right).
 *    Unchanged.
 *  - The terminal-frost control is `[data-testid="frosted-glass-terminal-level"]`
 *    (FROSTED_GLASS_TESTIDS.terminalFrost), a `role="radiogroup"` of
 *    `role="radio"` buttons named by their level label (SegmentedRadioGroup),
 *    not the old `role="switch"` checkbox.
 *  - The IPC write path is the dedicated `settings:set-terminal-frost-level
 *    { level }` channel (register.ts:757); a direct `settings:set` for
 *    `terminal_frost_level` is refused by the generic channel (D19), so
 *    seeding a stored value before launch goes through that same dedicated
 *    channel, post-launch (mirrors how window-opacity.spec.ts seeds
 *    `window_opacity`, which the generic channel does accept).
 *  - `--sheet-solid` is the mac token name for the opaque sheet background;
 *    see MAC_SHEET_SOLID_TOKEN in helpers/mermaid-palette.ts.
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  FROST_ATTR,
  FROSTED_GLASS_COPY,
  FROSTED_GLASS_TESTIDS,
  MAC_PLATFORM,
} from '../../src/renderer/frosted-chrome-contract';
import type { TerminalFrostLevel } from '../../src/shared/frosted-glass';
import { backgroundAlpha, isFrostedChrome } from './helpers/chrome-colour';
import { newShellTab } from './helpers/focus';
import { SPLIT_TESTIDS } from '../../src/renderer/split-copy';
import { closeApp, guardedLaunch } from './helpers/claude-harness';

const PROJECT = 'frostproj';
type Api = { invoke: (c: string, r: unknown) => Promise<unknown> };

interface Launched {
  app: ElectronApplication;
  win: Page;
  home: string;
  root: string;
  cleanup: () => void;
}

/**
 * Launches an isolated-profile app with one project, optionally pre-seeding
 * `terminal_frost_level`. Pass the SAME `home` across two calls to simulate a
 * relaunch of the same profile: settings persist to `$HOME/.metaide/metaide.db`
 * (`buildServices`, services.ts `homedir()`/`dbPath`), not to Electron's
 * `--user-data-dir` — a relaunch test that only reuses `userDataDir` (and
 * lets this helper mint a fresh `home` every call) silently reads a brand
 * new, default-valued settings DB.
 */
async function launchFrostApp(opts: { terminalFrost?: TerminalFrostLevel; home?: string; userDataDir?: string } = {}): Promise<Launched> {
  return guardedLaunch(async (scope) => {
    const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
    const home = opts.home ?? scope.tempDir('metaide-frost-home-');
    const root = scope.tempDir('metaide-frost-root-');
    const proj = join(root, PROJECT);
    mkdirSync(proj);
    mkdirSync(join(proj, '.git'));
    const userDataDir = opts.userDataDir ?? join(home, 'userData');
    const app = scope.own(await electron.launch({
      args: ['.', `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        HOME: home,
        // Plain POSIX shell: with the isolated HOME, the user's own shell
        // (zsh) prints its own prompt/setup instead of the `$` the AC8 new-tab
        // check (helpers/focus.ts newShellTab) waits for (same as helpers/focus.ts `launch`).
        SHELL: '/bin/sh',
        METAIDE_TEST_MODE: '1',
        METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
        METAIDE_DEFAULT_LAUNCH_FIRST: JSON.stringify({ argv: ['node', mockClaude], env: {} }),
        METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: ['node', mockClaude, '--continue'], env: {} }),
      },
    }));
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    if (opts.terminalFrost !== undefined) {
      // terminal_frost_level is a validated key: the generic settings:set
      // channel refuses it (register.ts:627), so seeding goes through its own
      // channel, same as the UI's write path (FrostedGlassGroup -> useFrostedGlassSettings.setTerminalFrostLevel).
      await win.evaluate(async (level: TerminalFrostLevel) => {
        await (window as unknown as { api: Api }).api.invoke('settings:set-terminal-frost-level', { level });
      }, opts.terminalFrost);
    }
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

/** `chrome-root`, `main`/`popout` sheet and chat/split locators, by the assumed attribute contract. */
function surfaces(win: Page) {
  return {
    chromeRoot: win.locator(`[${FROST_ATTR.chromeRoot}]`).first(),
    sheet: win.locator(`[${FROST_ATTR.sheetContent}]`).first(),
    chat: win.locator('[data-view="chat"]'),
    splitLeft: win.locator('.split-left'),
    splitRight: win.getByTestId('split-right'),
  };
}

/** Opens Settings, selects the given Terminal frost level, and closes the dialog. */
async function setFrostToggle(win: Page, level: TerminalFrostLevel): Promise<void> {
  await win.getByTestId('settings-open').click();
  const group = win.getByTestId(FROSTED_GLASS_TESTIDS.terminalFrost);
  await expect(group).toBeVisible({ timeout: 5000 });
  const option = group.getByRole('radio', { name: FROSTED_GLASS_COPY.levels[level] });
  if ((await option.getAttribute('aria-checked')) !== 'true') await option.click();
  await expect(option).toHaveAttribute('aria-checked', 'true');
  // useFrostedGlassSettings.setTerminalFrostLevel fires the write with `void`
  // (fire-and-forget): the control's own state flips synchronously (it is
  // optimistic), but the IPC write can still be in flight. Poll the stored
  // value so a caller that immediately quits the app (AC7) does not race an
  // unwritten setting.
  await expect.poll(() => win.evaluate(async () => {
    const r = await (window as unknown as { api: Api }).api.invoke('settings:get', { key: 'terminal_frost_level' }) as { value: unknown };
    return r.value;
  }), { timeout: 2000, message: 'terminal_frost_level setting is persisted before continuing' }).toBe(level);
  await win.getByTestId('settings-done').click();
  await expect(win.getByTestId('settings-modal')).toHaveCount(0);
}

async function focusOutOfTerminal(win: Page): Promise<void> {
  await win.getByTestId('activity-bar').click({ position: { x: 20, y: 400 } });
}

/** Opens the chat sidebar view, mounting `[data-view="chat"]` (it is conditionally rendered on `activeView === 'chat'`, App.tsx ~855). */
async function openChat(win: Page): Promise<void> {
  await win.getByTestId('ab-chat').click();
  await expect(win.locator('[data-view="chat"]')).toBeVisible({ timeout: 5000 });
}

/**
 * Activates split-pane mode. `.split-left` carries the `--surface-pane` card
 * background only in split mode (ShellSplit.tsx `usePaneMode`/`cardClass`
 * `paneMode` gate) — a single, unsplit shell paints no background on it at
 * all (alpha 0), so AC9/AC10's split-card checks need split actually on.
 */
async function openSplit(win: Page): Promise<void> {
  await win.getByTestId(SPLIT_TESTIDS.toggle).click();
  await expect(win.getByTestId(SPLIT_TESTIDS.right)).toBeVisible({ timeout: 5000 });
}

/* ─────────────────────────────── AC17: computed alpha relationships ─────────────────────────────── */

test.describe('AC17: computed alpha relationships (default palette, dark+light, OFF+ON)', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`default palette, ${theme}`, async () => {
      test.skip(process.platform !== 'darwin', 'mac-only chrome');
      const l = await launchFrostApp({ terminalFrost: 'off' });
      try {
        const { win } = l;
        test.skip(!(await isFrostedChrome(win)), 'data-platform (frosted chrome) was not set; chrome floors do not apply here');
        await win.evaluate((t: string) => {
          document.documentElement.setAttribute('data-palette', 'default');
          document.documentElement.setAttribute('data-theme', t);
        }, theme);
        await focusOutOfTerminal(win);
        await openChat(win);
        await openSplit(win);
        const s = surfaces(win);

        // AC1/AC2: chrome is visibly translucent in every combination.
        const chromeAlpha = await backgroundAlpha(win, s.chromeRoot);
        expect(chromeAlpha, `${theme}: chrome root is frosted`).toBeLessThan(1);

        // AC4/AC10: working-area surfaces are solid with the setting OFF.
        const sheetOff = await backgroundAlpha(win, s.sheet);
        const chatOff = await backgroundAlpha(win, s.chat);
        const splitOff = await backgroundAlpha(win, s.splitLeft);
        expect(sheetOff, `${theme}: shell sheet OFF reads solid`).toBeGreaterThanOrEqual(0.95);
        expect(chatOff, `${theme}: chat column OFF reads solid`).toBeGreaterThanOrEqual(0.95);
        expect(splitOff, `${theme}: split card OFF reads solid`).toBeGreaterThanOrEqual(0.95);

        // AC9/AC10: turning the setting ON lowers only the terminal group.
        await setFrostToggle(win, 'subtle');
        await expect.poll(() => backgroundAlpha(win, s.sheet), { timeout: 2000 }).toBeLessThan(sheetOff);
        const chatOn = await backgroundAlpha(win, s.chat);
        const splitOn = await backgroundAlpha(win, s.splitLeft);
        expect(chatOn, `${theme}: chat column stays solid ON (D10, AC10)`).toBeCloseTo(chatOff, 2);
        expect(splitOn, `${theme}: split card is lowered ON (AC9)`).toBeLessThan(splitOff);

        // Positive control: the two settings states actually differ (guards against a no-op toggle).
        expect(sheetOff, 'positive control: OFF and ON differ').not.toBeCloseTo(await backgroundAlpha(win, s.sheet), 2);
      } finally {
        await closeApp(l.app);
        l.cleanup();
      }
    });
  }
});

/* ─────────────────────────────── AC27: popout Shell vs Files ─────────────────────────────── */

test('AC27: popout sheet is frosted only on the Shell tab, never on Files', async () => {
  test.skip(process.platform !== 'darwin', 'mac-only chrome');
  const l = await launchFrostApp({ terminalFrost: 'subtle' });
  try {
    const { app, win } = l;
    test.skip(!(await isFrostedChrome(win)), 'data-platform (frosted chrome) was not set');
    await focusOutOfTerminal(win);

    const [popout] = await Promise.all([
      app.waitForEvent('window'),
      win.getByTestId('popout-shell').click(),
    ]);
    await popout.waitForLoadState('domcontentloaded');
    await expect(popout.getByTestId('shell-tab')).toBeVisible({ timeout: 8000 });

    const sheet = popout.locator(`[${FROST_ATTR.sheetContent}]`).first();
    await expect(sheet, 'popout sheet reports the shell tab').toHaveAttribute(FROST_ATTR.sheetContent, 'shell');
    const shellAlpha = await backgroundAlpha(popout, sheet);

    await popout.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(sheet, 'popout sheet reports the files tab').toHaveAttribute(FROST_ATTR.sheetContent, 'other');
    const filesAlpha = await backgroundAlpha(popout, sheet);

    expect(filesAlpha, 'Files sheet is solid even with the setting ON').toBeGreaterThanOrEqual(0.95);
    expect(shellAlpha, 'Shell sheet is frosted (AC9) and lower than Files').toBeLessThan(filesAlpha);

    await Promise.all([popout.waitForEvent('close'), (await app.browserWindow(popout)).evaluate((w) => w.close())]);
  } finally {
    await closeApp(l.app);
    l.cleanup();
  }
});

/* ─────────────────────────────── AC8: live apply ─────────────────────────────── */

test('AC8: toggling the setting updates the main window and an open popout within 1s', async () => {
  test.skip(process.platform !== 'darwin', 'mac-only chrome');
  const l = await launchFrostApp({ terminalFrost: 'off' });
  try {
    const { app, win } = l;
    test.skip(!(await isFrostedChrome(win)), 'data-platform (frosted chrome) was not set');
    await focusOutOfTerminal(win);

    const [popout] = await Promise.all([
      app.waitForEvent('window'),
      win.getByTestId('popout-shell').click(),
    ]);
    await popout.waitForLoadState('domcontentloaded');
    await expect(popout.getByTestId('shell-tab')).toBeVisible({ timeout: 8000 });

    const mainSheet = surfaces(win).sheet;
    const popoutSheet = popout.locator(`[${FROST_ATTR.sheetContent}]`).first();
    const mainBefore = await backgroundAlpha(win, mainSheet);
    const popoutBefore = await backgroundAlpha(popout, popoutSheet);

    const t0 = Date.now();
    await setFrostToggle(win, 'subtle');
    await expect.poll(() => backgroundAlpha(win, mainSheet), { timeout: 1000 }).toBeLessThan(mainBefore);
    expect(Date.now() - t0, 'main window updates within 1s').toBeLessThanOrEqual(1000);

    const t1 = Date.now();
    await expect.poll(() => backgroundAlpha(popout, popoutSheet), { timeout: 1000 }).toBeLessThan(popoutBefore);
    expect(Date.now() - t1, 'the already-open popout updates within 1s, with no reload').toBeLessThanOrEqual(1000);

    // A popout opened after the toggle reflects the current (ON) value from
    // first paint. `windows:popout-shell` focuses an existing popout for the
    // same project+shellIndex rather than opening a second window
    // (src/main/index.ts createPopoutWindow), so a genuinely new window
    // needs a second shell tab popped out, not a repeat click.
    await newShellTab(win, PROJECT);
    const [popout2] = await Promise.all([
      app.waitForEvent('window'),
      win.getByTestId('popout-shell').click(),
    ]);
    await popout2.waitForLoadState('domcontentloaded');
    await expect(popout2.getByTestId('shell-tab')).toBeVisible({ timeout: 8000 });
    const popout2Sheet = popout2.locator(`[${FROST_ATTR.sheetContent}]`).first();
    expect(await backgroundAlpha(popout2, popout2Sheet), 'a popout opened after the toggle starts frosted').toBeLessThan(mainBefore);
  } finally {
    await closeApp(l.app);
    l.cleanup();
  }
});

/* ─────────────────────────────── AC7: persistence ─────────────────────────────── */

test('AC7: the setting persists across relaunch, from first paint, with no flash of the other state', async () => {
  test.skip(process.platform !== 'darwin', 'mac-only chrome');
  // Same `home` for both launches: settings live at $HOME/.metaide/metaide.db
  // (services.ts buildServices), not under Electron's --user-data-dir, so
  // that is the directory a "relaunch of the same profile" has to share.
  const home = mkdtempSync(join(tmpdir(), 'metaide-frost-relaunch-'));
  const first = await launchFrostApp({ terminalFrost: 'off', home });
  try {
    test.skip(!(await isFrostedChrome(first.win)), 'data-platform (frosted chrome) was not set');
    await focusOutOfTerminal(first.win);
    await setFrostToggle(first.win, 'subtle');
  } finally {
    await first.app.close();
  }

  // Relaunch against the same profile: the stored value must already be ON
  // at first paint. `applyRootFlags` runs from the query string synchronously
  // in main.tsx before `createRoot` (plan §2.2/§2.3), so by the time the page
  // reaches domcontentloaded the attribute should already be set, with no
  // observed transition from absent/off to on.
  const second = await launchFrostApp({ home });
  try {
    const { win } = second;
    const attrPresent = await win.evaluate((attr: string) => document.documentElement.hasAttribute(attr), FROST_ATTR.terminalFrost);
    expect(attrPresent, 'the data-terminal-frost attribute is already set at first observable paint, no flash').toBe(true);

    await focusOutOfTerminal(win);
    const sheet = surfaces(win).sheet;
    const alpha = await backgroundAlpha(win, sheet);

    // Positive control: a fresh (never-toggled) profile boots solid, so the
    // persisted ON value above is actually doing something.
    const fresh = await launchFrostApp({});
    try {
      await focusOutOfTerminal(fresh.win);
      const freshAlpha = await backgroundAlpha(fresh.win, surfaces(fresh.win).sheet);
      expect(alpha, 'positive control: relaunched-ON differs from a fresh OFF profile').toBeLessThan(freshAlpha);
    } finally {
      await closeApp(fresh.app);
      fresh.cleanup();
    }
  } finally {
    await closeApp(second.app);
    second.cleanup(); // removes the shared `home`, used by both launches
  }
});

/* ─────────────────────────────── AC21: Reduce transparency ─────────────────────────────── */

test('AC21: emulated prefers-reduced-transparency makes every surface alpha 1, whatever the setting', async () => {
  test.skip(process.platform !== 'darwin', 'mac-only chrome');
  const l = await launchFrostApp({ terminalFrost: 'subtle' });
  try {
    const { win } = l;
    test.skip(!(await isFrostedChrome(win)), 'data-platform (frosted chrome) was not set');
    await focusOutOfTerminal(win);
    await openChat(win);
    await openSplit(win);
    const s = surfaces(win);

    // Positive control in the same app state: translucent before emulation.
    expect(await backgroundAlpha(win, s.chromeRoot), 'control: chrome is frosted before emulation').toBeLessThan(1);
    expect(await backgroundAlpha(win, s.sheet), 'control: terminal group is frosted ON before emulation').toBeLessThan(0.95);

    const cdp = await win.context().newCDPSession(win);
    try {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
      const flipped = await win.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches);
      // Same fallback as modal-glass.spec.ts AC24: if Chromium 128 does not
      // honour this CDP feature here, AC21's proof is the Agent 3 CSS unit
      // test plus the manual macOS "Reduce transparency" record (AC22).
      test.skip(!flipped, 'CDP cannot emulate prefers-reduced-transparency here; AC21 is proved by the unit test + manual macOS record');

      for (const theme of ['dark', 'light'] as const) {
        await win.evaluate((t: string) => document.documentElement.setAttribute('data-theme', t), theme);
        const misses: string[] = [];
        for (const [name, locator] of [['chrome', s.chromeRoot], ['sheet', s.sheet], ['chat', s.chat], ['split-left', s.splitLeft]] as const) {
          const a = await backgroundAlpha(win, locator);
          if (a !== 1) misses.push(`${theme}/${name}: alpha ${a}`);
        }
        expect(misses, `${theme}: reduced transparency: every surface alpha 1`).toEqual([]);
      }
    } finally {
      await cdp.send('Emulation.setEmulatedMedia', { features: [] });
      await cdp.detach();
    }
  } finally {
    await closeApp(l.app);
    l.cleanup();
  }
});

/* ─────────────────────────────── AC25(c): non-mac unchanged (attribute strip) ─────────────────────────────── */

test('AC25(c): stripping data-platform restores the original (non-mac) palette and surface tokens', async () => {
  test.skip(process.platform !== 'darwin', 'mac-only chrome; the strip simulates non-mac on a real mac build');
  const l = await launchFrostApp({ terminalFrost: 'off' });
  try {
    const { win } = l;
    test.skip(!(await isFrostedChrome(win)), 'data-platform (frosted chrome) was not set to begin with');
    await win.evaluate(() => {
      document.documentElement.setAttribute('data-palette', 'default');
      document.documentElement.setAttribute('data-theme', 'dark');
    });

    // Recorded baseline (styles.css:21-26, untouched by this feature — plan
    // §6 "styles.css not edited"): the non-mac default-dark literals.
    const BASELINE: Record<string, string> = {
      '--bg': 'rgba(22, 26, 34, 0.55)',
      '--panel': 'rgba(28, 32, 40, 0.82)',
      '--panel-strong': 'rgba(34, 38, 46, 0.92)',
      '--chat-surface': 'rgba(22, 26, 33, 0.75)',
    };

    await win.evaluate((attr: string) => document.documentElement.removeAttribute(attr), FROST_ATTR.platform);

    const misses: string[] = [];
    for (const [name, expected] of Object.entries(BASELINE)) {
      const actual = await win.evaluate((n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
      // Direct string compare: these are the stylesheet's own literal
      // declarations (not derived), so no colour-space resolution is needed.
      if (actual.replace(/\s+/g, ' ') !== expected) misses.push(`${name}: expected ${expected}, got ${actual}`);
    }
    expect(misses, 'every baseline token equals its recorded (pre-feature) literal once data-platform is stripped').toEqual([]);

    // Positive control: re-applying data-platform="mac" changes at least one
    // of them back (proves the strip, not an always-equal token, did the
    // work). `--bg` itself is deliberately never redeclared on macOS (plan
    // §2.1: "`--bg` is never redeclared, so `--modal-scrim` keeps its tint
    // value") — only `html`/`body` stop painting it — so `--panel` (which
    // frosted-chrome.css does redeclare, alpha 1 vs. the baseline's 0.82) is
    // the control, not `--bg`.
    await win.evaluate(({ attr, val }: { attr: string; val: string }) => document.documentElement.setAttribute(attr, val), { attr: FROST_ATTR.platform, val: MAC_PLATFORM });
    const panelMac = await win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--panel').trim());
    expect(panelMac, 'positive control: re-applying mac changes --panel away from the baseline literal').not.toBe(BASELINE['--panel']);
  } finally {
    await closeApp(l.app);
    l.cleanup();
  }
});

/* ─────────────────────────────── AC28: window opacity still applies, setting ON ─────────────────────────────── */

test('AC28: window opacity still applies to main and popout with terminal frost ON', async () => {
  test.skip(process.platform !== 'darwin', 'mac-only chrome');
  const l = await launchFrostApp({ terminalFrost: 'subtle' });
  try {
    const { app, win } = l;
    test.skip(!(await isFrostedChrome(win)), 'data-platform (frosted chrome) was not set');
    await focusOutOfTerminal(win);

    await win.getByTestId('settings-open').click();
    const subtle = win.getByTestId(FROSTED_GLASS_TESTIDS.terminalFrost).getByRole('radio', { name: FROSTED_GLASS_COPY.levels.subtle });
    await expect(subtle).toHaveAttribute('aria-checked', 'true');
    await win.getByTestId('window-opacity-slider').fill('70');
    await win.getByTestId('settings-done').click();
    await expect(win.getByTestId('settings-modal')).toHaveCount(0);

    const mainHandle = await app.browserWindow(win);
    await expect.poll(() => mainHandle.evaluate((w) => w.getOpacity()), { timeout: 3000 }).toBeCloseTo(0.7, 2);

    const [popout] = await Promise.all([
      app.waitForEvent('window'),
      win.getByTestId('popout-shell').click(),
    ]);
    await popout.waitForLoadState('domcontentloaded');
    await expect(popout.getByTestId('shell-tab')).toBeVisible({ timeout: 8000 });
    const popoutHandle = await app.browserWindow(popout);
    expect(await popoutHandle.evaluate((w) => w.getOpacity()), 'AC28: a popout opened after the opacity change picks it up, frost ON').toBeCloseTo(0.7, 2);

    // Window opacity (native composite) and the in-page frosted alpha are
    // independent (plan Assumptions: "they interact only by multiplying");
    // the terminal group is still frosted at its own alpha underneath.
    const sheetAlpha = await backgroundAlpha(popout, popout.locator(`[${FROST_ATTR.sheetContent}]`).first());
    expect(sheetAlpha, 'the terminal group is still frosted under the opacity setting').toBeLessThan(0.95);

    await Promise.all([popout.waitForEvent('close'), popoutHandle.evaluate((w) => w.close())]);
  } finally {
    await closeApp(l.app);
    l.cleanup();
  }
});
