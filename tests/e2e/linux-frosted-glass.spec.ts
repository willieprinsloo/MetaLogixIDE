/**
 * Linux frosted glass (docs/specs/linux-wayland-frosted-glass.md): the renderer
 * half of AC6, AC7, AC8, AC12 and AC13, observed in the built Electron app.
 *
 * Home: the built app via `_electron.launch` (same rig as
 * frosted-glass-settings.spec.ts), real Chromium, real React, real
 * frosted-chrome.css / frosted-glass-levels.css / styles.css, real settings
 * IPC and real `settings:changed` broadcast to a real popout window. Nothing
 * is stubbed, so each assertion below can go red: a wrong root flag, a
 * value-qualified CSS gate, a missing broadcast or a mac-only Material row all
 * show up in computed style or the DOM.
 *
 * Linux-only: every test calls `test.skip(process.platform !== 'linux', ...)`
 * first. The suite is run locally (CI runs no e2e; spec "Constraints").
 *
 * Not covered here, on purpose:
 *  - AC1 (windows are created with `transparent: true` and a fully transparent
 *    background). Electron has no `transparent` getter and
 *    `BrowserWindow.getBackgroundColor()` drops the alpha, so it is not
 *    observable through Electron's API. It rests on the unit test of
 *    `platformChrome('linux', ...)`; AC18 is the visible proof (manual).
 *  - AC6's "same --surface-chrome as macOS for the same palette/theme/level"
 *    cannot be compared on a single-platform run; the cascade equality is the
 *    unit contrast matrix (frosted-chrome-contrast.test.ts, linux state). Here
 *    we prove the Linux root takes the frosted cascade at all.
 *  - AC22 (Linux Reduce transparency notice) needs the OS preference forced,
 *    which this rig cannot do; it is a component test on exact strings.
 *  - Real compositor blur (AC18, AC19) is manual.
 *
 * Every negative assertion (an attribute absent, a control absent, a string
 * absent) is paired with a positive control in the same render.
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FROST_ATTR, FROSTED_GLASS_COPY, FROSTED_GLASS_TESTIDS } from '../../src/renderer/frosted-chrome-contract';
import { FROSTED_GLASS_KEYS, toFrostPlatform, type ChromeFrostLevel, type TerminalFrostLevel } from '../../src/shared/frosted-glass';
import { colourDistance, elementColour, fmtColour, isFrostedChrome, resolveColour, resolveToken } from './helpers/chrome-colour';
import type { Rgba } from './helpers/mermaid-palette';
import { closeApp, guardedLaunch } from './helpers/claude-harness';

const PROJECT = 'linuxglass';
const LINUX_ONLY = 'Linux frosted glass: runs on linux only';
/** The value `data-platform` must carry on this host, from the shared resolver (not retyped). */
const EXPECTED_PLATFORM = toFrostPlatform(process.platform);
type Api = { invoke: (c: string, r: unknown) => Promise<unknown> };

interface Launched {
  app: ElectronApplication;
  win: Page;
  cleanup: () => void;
}

/**
 * Isolated-profile app with one project and a shell tab open. Mirrors
 * frosted-glass-settings.spec.ts `launchGlassApp` (spec files do not export
 * helpers in this suite). A fresh HOME means a fresh settings DB, so the
 * frost settings are at their seeded defaults: Frosted chrome on, Subtle, Off.
 */
async function launchApp(): Promise<Launched> {
  return guardedLaunch(async (scope) => {
    const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
    const home = scope.tempDir('metaide-linuxglass-home-');
    const root = scope.tempDir('metaide-linuxglass-root-');
    const proj = join(root, PROJECT);
    mkdirSync(proj);
    mkdirSync(join(proj, '.git'));
    const app = scope.own(await electron.launch({
      args: ['.', `--user-data-dir=${join(home, 'userData')}`],
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
      cleanup: () => {
        rmSync(home, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
      },
    };
  });
}

async function openPopout(app: ElectronApplication, win: Page): Promise<Page> {
  const [popout] = await Promise.all([
    app.waitForEvent('window'),
    win.getByTestId('popout-shell').click(),
  ]);
  await popout.waitForLoadState('domcontentloaded');
  await expect(popout.getByTestId('shell-tab')).toBeVisible({ timeout: 8000 });
  return popout;
}

async function closePopout(app: ElectronApplication, popout: Page): Promise<void> {
  await Promise.all([popout.waitForEvent('close'), (await app.browserWindow(popout)).evaluate((w) => w.close())]);
}

async function openSettings(win: Page): Promise<void> {
  await win.getByTestId('settings-open').click();
  await expect(win.getByTestId('settings-modal')).toBeVisible();
}

async function closeSettings(win: Page): Promise<void> {
  await win.getByTestId('settings-done').click();
  await expect(win.getByTestId('settings-modal')).toHaveCount(0);
}

/** Reads a settings value through the real `settings:get` IPC round-trip. */
async function storedValue(win: Page, key: string): Promise<unknown> {
  return win.evaluate(async (k: string) => {
    const r = await (window as unknown as { api: Api }).api.invoke('settings:get', { key: k }) as { value: unknown };
    return r.value;
  }, key);
}

/** Flips the Frosted chrome switch through the Settings UI and waits for the stored value. */
async function setFrostChrome(win: Page, on: boolean): Promise<void> {
  await openSettings(win);
  const toggle = win.getByTestId(FROSTED_GLASS_TESTIDS.frostChrome);
  if ((await toggle.isChecked()) !== on) await toggle.click();
  await expect.poll(() => storedValue(win, FROSTED_GLASS_KEYS.frostChrome), { timeout: 2000 }).toBe(on);
  await closeSettings(win);
}

/** Picks Chrome frost and/or Terminal frost through the Settings UI. Frosted chrome must be on. */
async function setLevels(win: Page, levels: { chrome?: ChromeFrostLevel; terminal?: TerminalFrostLevel }): Promise<void> {
  await openSettings(win);
  if (levels.chrome) {
    await win.getByTestId(FROSTED_GLASS_TESTIDS.chromeFrost).getByRole('radio', { name: FROSTED_GLASS_COPY.levels[levels.chrome] }).click();
    await expect.poll(() => storedValue(win, FROSTED_GLASS_KEYS.chromeFrostLevel), { timeout: 2000 }).toBe(levels.chrome);
  }
  if (levels.terminal) {
    await win.getByTestId(FROSTED_GLASS_TESTIDS.terminalFrost).getByRole('radio', { name: FROSTED_GLASS_COPY.levels[levels.terminal] }).click();
    await expect.poll(() => storedValue(win, FROSTED_GLASS_KEYS.terminalFrostLevel), { timeout: 2000 }).toBe(levels.terminal);
  }
  await closeSettings(win);
}

function rootAttr(w: Page, name: string): Promise<string | null> {
  return w.evaluate((a: string) => document.documentElement.getAttribute(a), name);
}

const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };
/**
 * The clear colour of Electron's opaque (non-`transparent`) Linux window, which is what the page
 * background composited over before Linux windows became transparent. The driver's AC7 ruling
 * names it as #000000; the frost-off underlay must reproduce it.
 */
const OPAQUE_WINDOW_CLEAR: Rgba = { r: 0, g: 0, b: 0, a: 1 };

/** Porter-Duff source-over with alpha on both sides (helpers' `over` assumes an opaque destination). */
function overAlpha(src: Rgba, dst: Rgba): Rgba {
  const a = src.a + dst.a * (1 - src.a);
  if (a === 0) return { ...TRANSPARENT };
  const mix = (s: number, d: number) => (s * src.a + d * dst.a * (1 - src.a)) / a;
  return { r: mix(src.r, dst.r), g: mix(src.g, dst.g), b: mix(src.b, dst.b), a };
}

/**
 * The background layers an element paints, bottom first: `background-color`, then each
 * `background-image` layer (CSS lists image layers top first). A solid-colour gradient layer
 * (`linear-gradient(c, c)`, a common way to stack a colour over an underlay) is modelled as that
 * colour; any other image layer is not modelled and fails loudly, so a mechanism this oracle
 * does not understand is reported as such rather than read as a pass.
 */
async function backgroundLayers(w: Page, selector: 'html' | 'body'): Promise<Rgba[]> {
  const el = w.locator(selector);
  const layers: Rgba[] = [await elementColour(w, el, 'background-color')];
  const image = await el.evaluate((n) => getComputedStyle(n).backgroundImage);
  if (image === 'none') return layers;
  const parts = image.split(/,\s*(?=(?:linear|radial|conic|repeating|url)\b)/).reverse();
  for (const part of parts) {
    const colours = part.match(/(?:rgba?|oklab|oklch|lab|lch|color|hsla?)\([^()]*\)|#[0-9a-f]{3,8}\b/gi) ?? [];
    const unique = [...new Set(colours.map((c) => c.replace(/\s+/g, ' ')))];
    if (!part.startsWith('linear-gradient(') || unique.length !== 1) {
      throw new Error(`${selector} background-image layer is not a solid-colour gradient; the oracle does not model it: ${part}`);
    }
    layers.push(await resolveColour(w, unique[0]!));
  }
  return layers;
}

/** What the window shows of the page background: body's layers over html's layers, over `base`. */
async function pageComposite(w: Page, base: Rgba = TRANSPARENT): Promise<{ colour: Rgba; html: Rgba[]; body: Rgba[] }> {
  const html = await backgroundLayers(w, 'html');
  const body = await backgroundLayers(w, 'body');
  const colour = [...html, ...body].reduce((acc, layer) => overAlpha(layer, acc), base);
  return { colour, html, body };
}

const describeLayers = (c: { html: Rgba[]; body: Rgba[] }) => `html [${c.html.map(fmtColour).join(', ')}] body [${c.body.map(fmtColour).join(', ')}]`;

function chromeRoot(w: Page) {
  return w.locator(`[${FROST_ATTR.chromeRoot}]`).first();
}

/* ─────────────────────────────── AC6: default boot is frosted ─────────────────────────────── */

test('AC6: a default Linux boot carries data-platform="linux", transparent html/body and a translucent --surface-chrome on the chrome root', async () => {
  test.skip(process.platform !== 'linux', LINUX_ONLY);
  expect(EXPECTED_PLATFORM, 'the shared resolver maps this host to linux').toBe('linux');
  const l = await launchApp();
  try {
    const { win } = l;
    expect(await rootAttr(win, FROST_ATTR.platform), 'AC6: the fresh profile (Frosted chrome on by default) sets data-platform to the resolver value').toBe(EXPECTED_PLATFORM);
    expect(await isFrostedChrome(win), 'the shared helper reports frosted chrome active').toBe(true);
    expect(await win.evaluate((a: string) => document.documentElement.hasAttribute(a), FROST_ATTR.transparentWindow), 'the Linux root marks its window transparent').toBe(true);

    const page = await pageComposite(win);
    for (const layer of [...page.html, ...page.body]) {
      expect(layer.a, `AC6: html and body paint nothing (${describeLayers(page)})`).toBe(0);
    }
    expect(page.colour.a, 'AC6: the page background lets the desktop through').toBe(0);

    const root = chromeRoot(win);
    await expect(root, 'the chrome root renders').toBeVisible();
    const token = await resolveToken(win, '--surface-chrome', root);
    const painted = await elementColour(win, root, 'background-color');
    expect(token.a, `AC6: --surface-chrome ${fmtColour(token)} is translucent`).toBeLessThan(1);
    expect(token.a, `AC6: --surface-chrome ${fmtColour(token)} is painted, not transparent`).toBeGreaterThan(0);
    expect(painted.a, `the chrome root paints --surface-chrome (${fmtColour(painted)} vs ${fmtColour(token)})`).toBeCloseTo(token.a, 2);

    // Positive control for the alpha oracle in this same render: the frosted stack's
    // working-area solid is opaque, so the reader does report alpha 1 when it is 1.
    const sheetSolid = await resolveToken(win, '--sheet-solid', root);
    expect(sheetSolid.a, `control: --sheet-solid ${fmtColour(sheetSolid)} reads as opaque`).toBe(1);
  } finally {
    await closeApp(l.app);
    l.cleanup();
  }
});

/* ─────────────────────────────── AC7 + AC8: Frosted chrome off, live, main + popout ─────────────────────────────── */

test('AC7/AC8: turning Frosted chrome off drops every frost attribute and repaints html/body opaque in the main window and a popout, live; on again restores it', async () => {
  test.skip(process.platform !== 'linux', LINUX_ONLY);
  const l = await launchApp();
  try {
    const { app, win } = l;
    const popout = await openPopout(app, win);
    const windows = [['main', win], ['popout', popout]] as const;
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 'main process: the main window and the popout both exist').toBe(2);

    // Raise both levels first so every frost attribute is present: the positive control
    // for each absence asserted after the switch goes off.
    await setLevels(win, { chrome: 'strong', terminal: 'medium' });
    const marks = await Promise.all(windows.map(([, w]) => w.evaluate(() => {
      const mark = Math.random().toString(36).slice(2);
      (window as unknown as { __noReload: string }).__noReload = mark;
      return mark;
    })));
    for (const [name, w] of windows) {
      await expect.poll(() => rootAttr(w, FROST_ATTR.chromeFrost), { timeout: 1000, message: `${name} control: chrome frost reaches strong` }).toBe('strong');
      expect(await rootAttr(w, FROST_ATTR.terminalFrost), `${name} control: terminal frost is medium`).toBe('medium');
      expect(await rootAttr(w, FROST_ATTR.platform), `${name} control: data-platform is set`).toBe(EXPECTED_PLATFORM);
      expect(await rootAttr(w, FROST_ATTR.transparentWindow), `${name} control: transparent-window mark is set while frosted`).not.toBeNull();
      expect((await pageComposite(w)).colour.a, `${name} control: the page background starts transparent`).toBe(0);
    }

    await setFrostChrome(win, false);

    for (const [name, w] of windows) {
      await expect.poll(() => rootAttr(w, FROST_ATTR.platform), { timeout: 1000, message: `${name}: AC7/AC8 data-platform drops live` }).toBeNull();
      expect(await rootAttr(w, FROST_ATTR.chromeFrost), `${name}: AC7 data-chrome-frost is gone`).toBeNull();
      expect(await rootAttr(w, FROST_ATTR.terminalFrost), `${name}: AC7 data-terminal-frost is gone`).toBeNull();
      // Positive control in the same render: the root is still themed and the chrome
      // root still renders, so the absences are the switch, not a wiped document.
      // Positive control in the same render: the root is still themed, still marked as a
      // transparent window, and the chrome root still renders, so the absences are the
      // switch, not a wiped document.
      expect(await rootAttr(w, 'data-palette'), `${name} control: the root still carries its palette`).not.toBeNull();
      expect(await rootAttr(w, FROST_ATTR.transparentWindow), `${name} control: transparent-window mark stays while frost is off`).not.toBeNull();
      await expect(chromeRoot(w), `${name} control: the chrome root still renders`).toBeVisible();
    }
    for (const [name, w] of windows) {
      // AC7 "opaque, same colours as on Linux today". The window is now always transparent
      // (AC1), so the page background composites over nothing; before, styles.css's --bg on
      // html and again on body composited over the opaque window's clear colour.
      const page = await pageComposite(w);
      const bg = await resolveToken(w, '--bg');
      const today = [bg, bg].reduce((acc, layer) => overAlpha(layer, acc), OPAQUE_WINDOW_CLEAR);
      expect(page.colour.a, `${name}: AC7 page background is opaque over the transparent window (${describeLayers(page)})`).toBeGreaterThanOrEqual(0.999);
      expect(colourDistance(page.colour, today), `${name}: AC7 page background ${fmtColour(page.colour)} matches today's --bg ${fmtColour(bg)} over --bg over ${fmtColour(OPAQUE_WINDOW_CLEAR)} = ${fmtColour(today)}`).toBeLessThanOrEqual(2);
    }

    // AC8: on again, live, levels restored, in both windows.
    await setFrostChrome(win, true);
    for (const [name, w] of windows) {
      await expect.poll(() => rootAttr(w, FROST_ATTR.platform), { timeout: 1000, message: `${name}: data-platform returns live` }).toBe(EXPECTED_PLATFORM);
      expect(await rootAttr(w, FROST_ATTR.chromeFrost), `${name}: chrome frost restored`).toBe('strong');
      expect((await pageComposite(w)).colour.a, `${name}: the page background is transparent again (underlay gone)`).toBe(0);
    }

    const after = await Promise.all(windows.map(([, w]) => w.evaluate(() => (window as unknown as { __noReload?: string }).__noReload ?? null)));
    expect(after, 'AC8: neither window reloaded (the in-page marker survived)').toEqual(marks);
    await closePopout(app, popout);
  } finally {
    await closeApp(l.app);
    l.cleanup();
  }
});

/* ─────────────────────────────── AC8: Chrome / Terminal frost level, live, main + popout ─────────────────────────────── */

test('AC8: Chrome frost Strong and Terminal frost Medium reach the main window and a popout live, and change the painted chrome alpha', async () => {
  test.skip(process.platform !== 'linux', LINUX_ONLY);
  const l = await launchApp();
  try {
    const { app, win } = l;
    const popout = await openPopout(app, win);
    const windows = [['main', win], ['popout', popout]] as const;

    const subtleAlpha: Record<string, number> = {};
    for (const [name, w] of windows) {
      // Positive control: frost is on (data-platform set) while Subtle/Off omit the level attributes.
      expect(await rootAttr(w, FROST_ATTR.platform), `${name} control: frosted`).toBe(EXPECTED_PLATFORM);
      expect(await rootAttr(w, FROST_ATTR.chromeFrost), `${name}: Subtle omits data-chrome-frost`).toBeNull();
      expect(await rootAttr(w, FROST_ATTR.terminalFrost), `${name}: Off omits data-terminal-frost`).toBeNull();
      subtleAlpha[name] = (await resolveToken(w, '--surface-chrome', chromeRoot(w))).a;
    }

    await setLevels(win, { chrome: 'strong', terminal: 'medium' });

    for (const [name, w] of windows) {
      await expect.poll(() => rootAttr(w, FROST_ATTR.chromeFrost), { timeout: 1000, message: `${name}: chrome frost reaches strong live` }).toBe('strong');
      await expect.poll(() => rootAttr(w, FROST_ATTR.terminalFrost), { timeout: 1000, message: `${name}: terminal frost reaches medium live` }).toBe('medium');
      const strong = await resolveToken(w, '--surface-chrome', chromeRoot(w));
      expect(strong.a, `${name}: Strong repaints --surface-chrome (${fmtColour(strong)} vs Subtle alpha ${subtleAlpha[name]!.toFixed(3)})`).not.toBeCloseTo(subtleAlpha[name]!, 2);
      expect(strong.a, `${name}: Strong stays translucent`).toBeLessThan(1);
    }
    await closePopout(app, popout);
  } finally {
    await closeApp(l.app);
    l.cleanup();
  }
});

/* ─────────────────────────────── AC12 + AC13: the Settings group on Linux ─────────────────────────────── */

test('AC12/AC13: Settings shows the Frosted glass group with the switch and both levels, no Material row, and the compositor hint', async () => {
  test.skip(process.platform !== 'linux', LINUX_ONLY);
  const l = await launchApp();
  try {
    const { win } = l;
    await openSettings(win);
    const modal = win.getByTestId('settings-modal');
    const group = modal.getByTestId(FROSTED_GLASS_TESTIDS.group);

    // AC12 positives: the group and its three Linux controls render.
    await expect(group, 'AC12: the Frosted glass group renders on Linux').toBeVisible();
    await expect(modal.getByRole('group', { name: FROSTED_GLASS_COPY.group }), 'the group is named "Frosted glass"').toHaveCount(1);
    await expect(group.getByRole('switch', { name: FROSTED_GLASS_COPY.frostChrome })).toBeVisible();
    await expect(group.getByTestId(FROSTED_GLASS_TESTIDS.chromeFrost)).toBeVisible();
    await expect(group.getByTestId(FROSTED_GLASS_TESTIDS.terminalFrost)).toBeVisible();
    // AC12 negative, controlled by the positives above in this same render.
    await expect(modal.getByTestId(FROSTED_GLASS_TESTIDS.material), 'AC12: no Material select on Linux').toHaveCount(0);
    await expect(modal.getByText(FROSTED_GLASS_COPY.material, { exact: true }), 'AC12: no Material label on Linux').toHaveCount(0);
    await expect(modal.getByText(FROSTED_GLASS_COPY.materialHint, { exact: true }), 'AC12: no Material hint on Linux').toHaveCount(0);

    // AC13: the Linux hint, exactly, and no macOS wording anywhere in the group.
    await expect(group.getByText(FROSTED_GLASS_COPY.frostChromeHintLinux, { exact: true }), 'AC13: compositor hint, exact').toHaveCount(1);
    await expect(group.getByText(FROSTED_GLASS_COPY.frostChromeHint, { exact: true }), 'AC13: the mac-only hint is not shown').toHaveCount(0);
    await expect(group, 'control: the group has text to scan').toContainText(FROSTED_GLASS_COPY.frostChrome);
    await expect(group, 'AC13: the group never mentions macOS').not.toContainText('macOS');
    await closeSettings(win);
  } finally {
    await closeApp(l.app);
    l.cleanup();
  }
});
