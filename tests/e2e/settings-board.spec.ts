import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveColour } from './helpers/mermaid-palette';
import { effectiveColours, backgroundLuminance, paintedOver, textContrast, type Theme } from './helpers/contrast';

/**
 * Settings General board restyle (docs/specs/2026-10-06-settings-board-restyle.md).
 *
 * Runs against the built app in Electron at window 1440x900, zoom 1, with an isolated profile;
 * the renderer is the real one, so computed styles and boxes are what the user sees. Colours
 * are compared against tokens resolved in-page through a probe inside the dialog, so the
 * assertion follows the palette x theme under test instead of hard-coding one instance.
 */

type Api = { invoke: (channel: string, request: unknown) => Promise<unknown> };
type InvokeHandler = (event: unknown, request: unknown) => unknown;
type IpcMainWithHandlers = { _invokeHandlers?: Map<string, InvokeHandler> };

const PALETTES = [
  { id: 'default', label: 'Default' },
  { id: 'catppuccin', label: 'Catppuccin' },
  { id: 'rose-pine', label: 'Rosé Pine' },
] as const;
type PaletteId = (typeof PALETTES)[number]['id'];
const THEMES: readonly Theme[] = ['dark', 'light'];

/** AC15a, left to right. */
const SWATCHES: Record<PaletteId, Record<Theme, readonly string[]>> = {
  default: { dark: ['#1c2028', '#3b82f6', '#22c55e', '#fbbf24'], light: ['#eceef3', '#2563eb', '#16a34a', '#d97706'] },
  catppuccin: { dark: ['#1e1e2e', '#89b4fa', '#a6e3a1', '#f5c2e7'], light: ['#eff1f5', '#1e66f5', '#40a02b', '#ea76cb'] },
  'rose-pine': { dark: ['#191724', '#c4a7e7', '#9ccfd8', '#f6c177'], light: ['#faf4ed', '#907aa9', '#56949f', '#ea9d34'] },
};

const ROW_HINTS = {
  Mode: 'System follows your OS appearance.',
  'Window opacity': 'Below 100% your desktop shows through.',
  // Literal copy, not read back from `FONT_COPY` (the contract under test): AC1.
  'Terminal font size': 'Every terminal uses this size. ⌘= / ⌘- / ⌘0 also change it.',
  'Keep-alive cap': 'Shells kept running at once; the oldest is closed first.',
  'Root scan depth': 'Folder levels below a root that count as projects.',
  'Max watched paths': 'File-watcher limit across all roots.',
} as const;
const FONTS_HINT = 'Pick an installed font or type an exact family name.';
const NAV = ['General', 'Root directories', 'Launch commands', 'Environment', 'Metaproject'] as const;
const SECTIONS = ['Appearance', 'Fonts', 'Workspace', 'Notifications'] as const;
const SWITCHES = [
  { testId: 'notify-needs-input-toggle', label: 'When Claude needs input', key: 'notify_claude_needs_input' },
  { testId: 'notify-finished-toggle', label: 'When Claude finishes', key: 'notify_claude_finished' },
] as const;
const NUMBERS = [
  { label: 'Keep-alive cap', key: 'keep_alive_cap', min: 1, max: 20, step: 1, over: 99, under: 0 },
  { label: 'Root scan depth', key: 'scan_depth', min: 1, max: 4, step: 1, over: 9, under: 0 },
  { label: 'Max watched paths', key: 'max_watched_paths', min: 50, max: 5000, step: 50, over: 6000, under: 10 },
] as const;

let app: ElectronApplication;
let win: Page;
let home: string;

test.beforeAll(async () => {
  const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
  home = mkdtempSync(join(tmpdir(), 'metaide-settings-board-'));
  app = await electron.launch({
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
  });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w?.setContentSize(1440, 900);
    w?.webContents.setZoomFactor(1);
  });
  await expect.poll(() => win.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([1440, 900]);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor())).toBe(1);
  await mockLocalFonts();
});

test.afterAll(async () => {
  await app?.close();
  rmSync(home, { recursive: true, force: true });
});

/** Deterministic installed-font discovery, so the option list has rows besides "System default". */
async function mockLocalFonts(): Promise<void> {
  await win.evaluate(() => {
    Object.defineProperty(window, 'queryLocalFonts', {
      configurable: true,
      value: async () => [{ family: 'Menlo' }, { family: 'Helvetica Neue' }],
    });
  });
}

function dialog(): Locator {
  return win.getByRole('dialog', { name: 'Settings' });
}

function region(name: (typeof SECTIONS)[number]): Locator {
  return dialog().getByRole('region', { name });
}

/**
 * Waits for every running animation and transition in the open modal to finish: the open
 * scale/fade, colour transitions after a palette or mode change, the list pop-in. Boxes and
 * colours read mid-transition are interpolated, and the contrast oracle refuses translucent
 * ancestors.
 */
async function settle(): Promise<void> {
  await win.getByTestId('settings-modal').evaluate((el) =>
    Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))),
  );
}

/** Opens Settings (if closed) on the General section. */
async function openGeneral(): Promise<void> {
  if (!(await win.getByTestId('settings-modal').isVisible())) {
    await win.getByTestId('settings-open').click();
  }
  await expect(dialog()).toBeVisible();
  await settle();
  await dialog().getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'General', exact: true }).click();
  await expect(region('Appearance')).toBeVisible();
}

async function closeSettings(): Promise<void> {
  if (await win.getByTestId('settings-modal').isVisible()) await win.getByTestId('settings-done').click();
  await expect(win.getByTestId('settings-modal')).toBeHidden();
}

/** Selects a palette and an explicit Light/Dark mode through the board's own controls. */
async function applyAppearance(palette: PaletteId, theme: Theme): Promise<void> {
  await openGeneral();
  const label = PALETTES.find((p) => p.id === palette)?.label ?? '';
  await dialog().getByRole('button', { name: label, exact: true }).click();
  await dialog().getByRole('radio', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true }).click();
  await expect(win.locator('html')).toHaveAttribute('data-palette', palette);
  await expect(win.locator('html')).toHaveAttribute('data-theme', theme);
  // Park the pointer off the board so no hover fill skews colours.
  await win.mouse.move(2, 2);
  await settle();
}

/** Runs `fn` in every palette x theme, then restores Default / Dark. */
async function forEachAppearance(fn: (palette: PaletteId, theme: Theme) => Promise<void>): Promise<void> {
  for (const { id } of PALETTES) {
    for (const theme of THEMES) {
      await applyAppearance(id, theme);
      await fn(id, theme);
    }
  }
  await applyAppearance('default', 'dark');
}

async function box(el: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await el.boundingBox();
  if (!b) throw new Error('element has no box');
  return b;
}

function style(el: Locator, prop: string): Promise<string> {
  return el.evaluate((node, p) => getComputedStyle(node).getPropertyValue(p), prop);
}

/** `expr` resolved as `prop` on a hidden probe appended inside `scope`, so it sees the same custom properties. */
function resolveIn(scope: Locator, prop: 'color' | 'background-color', expr: string): Promise<string> {
  return scope.evaluate((node, { prop, expr }) => {
    const probe = document.createElement('span');
    probe.style.display = 'none';
    probe.style.setProperty(prop, expr);
    node.appendChild(probe);
    const value = getComputedStyle(probe).getPropertyValue(prop);
    probe.remove();
    return value;
  }, { prop, expr });
}

/** A resolved token must be a visible colour: an undefined custom property resolves to transparent and would match anything else that is transparent. */
async function expectVisibleColour(css: string, what: string): Promise<void> {
  expect(css, `${what} resolved to transparent`).not.toBe('rgba(0, 0, 0, 0)');
  expect((await resolveColour(win, css)).a, `${what} alpha (${css})`).toBeGreaterThan(0);
}

/**
 * Waits until the renderer sees the emulated OS scheme, then two frames so React has
 * committed whatever a matchMedia change listener scheduled. A negative read after this
 * means the app had the chance to react and did not.
 */
async function osSchemeIs(scheme: Theme): Promise<void> {
  await expect
    .poll(() => win.evaluate(() => window.matchMedia('(prefers-color-scheme: dark)').matches))
    .toBe(scheme === 'dark');
  await win.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

function rgbOf(hex: string): string {
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return `rgb(${n(1)}, ${n(3)}, ${n(5)})`;
}

async function setting(key: string): Promise<unknown> {
  return win.evaluate(async (k) => {
    const api = (window as unknown as { api: Api }).api;
    return ((await api.invoke('settings:get', { key: k })) as { value: unknown }).value;
  }, key);
}

function expectPx(actual: number, expected: number, what: string, tolerance = 0.5): void {
  expect(Math.abs(actual - expected), `${what}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);
}

function scroller(): Locator {
  return region('Appearance').locator('xpath=../..');
}

function cards(): Locator {
  return region('Appearance').getByRole('group', { name: 'Theme' }).getByRole('button');
}

function swatchStrip(card: Locator): Locator {
  return card.locator(':scope > span').first();
}

async function swatchColours(card: Locator): Promise<string[]> {
  return swatchStrip(card).locator(':scope > span').evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
}

test('colour oracle reads oklab() the way the browser paints it', async () => {
  const red = await paintedOver(win, 'dark', 'oklab(0.627955 0.224863 0.125846)');
  expect(Math.abs(red.r - 255) + Math.abs(red.g) + Math.abs(red.b)).toBeLessThanOrEqual(2);
  // Positive control: a translucent fill really composites over the theme base.
  const half = await paintedOver(win, 'light', 'rgba(0, 0, 0, 0.5)');
  expect(Math.abs(half.r - 128)).toBeLessThanOrEqual(1);
});

test('AC1-AC3, AC8: dialog shell geometry, semantics and footer fill in every palette x theme', async () => {
  await forEachAppearance(async (palette, theme) => {
    const at = `${palette}/${theme}`;
    const panel = dialog();
    await expect(panel).toHaveAttribute('aria-modal', 'true');
    const labelledBy = await panel.getAttribute('aria-labelledby');
    const title = win.locator(`[id="${labelledBy}"]`);
    await expect(title).toHaveText('Settings');
    expect(await title.evaluate((e) => e.tagName)).toBe('H1');
    await expect(win.getByTestId('settings-modal').getByRole('dialog')).toHaveCount(1);

    const p = await box(panel);
    expectPx(p.width, 820, `${at} panel width`);
    expectPx(p.height, 640, `${at} panel height`);
    expect(await style(panel, 'border-top-left-radius')).toBe('16px');
    const panelBg = await style(panel, 'background-color');
    expect(panelBg, `${at} panel bg`).toBe(await resolveIn(panel, 'background-color', 'var(--panel-strong)'));
    expect(panelBg).not.toBe('rgb(31, 33, 48)');

    const header = title.locator('xpath=..');
    expectPx((await box(header)).height, 52, `${at} header height`);
    expect(await style(title, 'font-size')).toBe('15px');
    expect(await style(title, 'font-weight')).toBe('600');
    const close = win.getByTestId('settings-close');
    await expect(close).toHaveAccessibleName('Close settings');
    const c = await box(close);
    expectPx(c.width, 36, `${at} close width`);
    expectPx(c.height, 36, `${at} close height`);
    expect(await style(close, 'border-top-left-radius')).toBe('10px');

    const done = win.getByTestId('settings-done');
    const footer = done.locator('xpath=..');
    expectPx((await box(footer)).height, 60, `${at} footer height`);
    expectPx((await box(done)).height, 36, `${at} Done height`);
    expect(await style(done, 'border-top-left-radius')).toBe('10px');
    expect(await style(done, 'background-color')).toBe(await resolveIn(panel, 'background-color', 'var(--accent-soft)'));
    expect(await style(done, 'color')).toBe(await resolveIn(panel, 'color', 'var(--accent-soft-text)'));

    // User review addition: footer bar = surface-chrome 25% into panel-strong, resolved in-page.
    const footerBg = await style(footer, 'background-color');
    expect(footerBg, `${at} footer bg`).toBe(
      await resolveIn(panel, 'background-color', 'color-mix(in oklab, var(--surface-chrome) 25%, var(--panel-strong))'),
    );
    // Positive control: the mix is distinguishable from the plain panel whenever the two tokens differ.
    const chrome = await resolveIn(panel, 'background-color', 'var(--surface-chrome)');
    if (chrome !== panelBg) expect(footerBg, `${at} footer differs from panel`).not.toBe(panelBg);
  });
});

test('AC4: focus moves to the panel, Tab is contained, and returns to the opener', async () => {
  await closeSettings();
  const gear = win.getByTestId('settings-open');
  await gear.focus();
  await gear.press('Enter');
  await expect(dialog()).toBeFocused();
  // Not the first input: the Interface combobox would open its list and start discovery.
  await expect(dialog().getByRole('listbox')).toHaveCount(0);

  const insidePanel = () =>
    dialog().evaluate((p) => p !== document.activeElement && p.contains(document.activeElement));
  const tabbables = await dialog().evaluate(
    (p) => p.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])').length,
  );
  for (let i = 0; i < tabbables + 2; i++) {
    await win.keyboard.press('Tab');
    expect(await insidePanel(), `Tab ${i + 1} stays inside`).toBe(true);
  }
  for (let i = 0; i < 3; i++) {
    await win.keyboard.press('Shift+Tab');
    expect(await insidePanel(), `Shift+Tab ${i + 1} stays inside`).toBe(true);
  }
  // Wrap at both ends: close button is first, Done is last.
  await win.getByTestId('settings-close').focus();
  await win.keyboard.press('Shift+Tab');
  await expect(win.getByTestId('settings-done')).toBeFocused();
  await win.keyboard.press('Tab');
  await expect(win.getByTestId('settings-close')).toBeFocused();

  await win.keyboard.press('Escape');
  await expect(win.getByTestId('settings-modal')).toBeHidden();
  await expect(gear).toBeFocused();

  // Done also restores focus to the opener.
  await gear.press('Enter');
  await expect(dialog()).toBeFocused();
  await win.getByTestId('settings-done').click();
  await expect(win.getByTestId('settings-modal')).toBeHidden();
  await expect(gear).toBeFocused();

  // Escape on an open font list closes the list only; the trap still holds; a second Escape closes Settings.
  await openGeneral();
  const input = dialog().getByRole('combobox', { name: 'Interface' });
  await input.click();
  await expect(dialog().getByRole('listbox', { name: 'Interface options' })).toBeVisible();
  await win.keyboard.press('Escape');
  await expect(dialog().getByRole('listbox')).toHaveCount(0);
  await expect(dialog()).toBeVisible();
  await expect(input).toBeFocused();
  // Shift+Tab: backwards to the opacity slider (Tab would open the Terminal list, whose Escape is its own).
  await win.keyboard.press('Shift+Tab');
  expect(await insidePanel()).toBe(true);
  await expect(dialog().getByRole('slider', { name: 'Window opacity' })).toBeFocused();
  await win.keyboard.press('Escape');
  await expect(win.getByTestId('settings-modal')).toBeHidden();
});

test('AC5, AC6: nav geometry, icons, names, aria-current; every label on one line', async () => {
  const nav = () => dialog().getByRole('navigation', { name: 'Settings sections' });
  const item = (name: string) => nav().getByRole('button', { name, exact: true });

  await forEachAppearance(async (palette, theme) => {
    const at = `${palette}/${theme}`;
    expectPx((await box(nav())).width, 196, `${at} nav width`);
    let prevBottom: number | null = null;
    for (const name of NAV) {
      const b = item(name);
      await expect(b).toHaveCount(1);
      const bb = await box(b);
      expectPx(bb.height, 38, `${at} ${name} height`);
      expect(await style(b, 'border-top-left-radius')).toBe('10px');
      if (prevBottom !== null) expectPx(bb.y - prevBottom, 2, `${at} gap before ${name}`);
      prevBottom = bb.y + bb.height;
      const svg = b.locator('svg');
      await expect(svg).toHaveAttribute('aria-hidden', 'true');
      const s = await box(svg);
      expectPx(s.width, 15, `${at} ${name} icon width`);
      expectPx(s.height, 15, `${at} ${name} icon height`);
      expect(s.x + s.width, `${at} ${name} icon before label`).toBeLessThanOrEqual((await box(b.locator(':scope > span:last-child'))).x);
    }
    const iconColour = (name: string) => item(name).locator('svg').evaluate((e) => getComputedStyle(e).color);
    expect(await iconColour('General'), `${at} General icon`).toBe(await style(item('General'), 'color'));
    for (const [name, hue] of [['Root directories', '--hue-yellow'], ['Launch commands', '--hue-purple'], ['Metaproject', '--hue-cyan']] as const) {
      const expected = await resolveIn(nav(), 'color', `var(${hue})`);
      expect(await iconColour(name), `${at} ${name} icon`).toBe(expected);
      // Positive control: the hue is not just the inherited item text colour.
      expect(expected).not.toBe(await style(item(name), 'color'));
    }
  });

  for (const active of NAV) {
    await item(active).click();
    await expect(item(active)).toHaveAttribute('aria-current', 'page');
    for (const other of NAV.filter((n) => n !== active)) {
      expect(await item(other).getAttribute('aria-current'), `${other} while ${active} is active`).toBeNull();
    }
    // User review addition: every label on one line, not truncated, active item included.
    for (const name of NAV) {
      const label = item(name).locator(':scope > span:last-child');
      const m = await label.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const lines = new Set(Array.from(range.getClientRects()).filter((r) => r.width > 0).map((r) => Math.round(r.top)));
        return { lines: lines.size, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, text: el.textContent };
      });
      expect(m.text).toBe(name);
      expect(m.lines, `${name} line boxes while ${active} active`).toBe(1);
      expect(m.scrollWidth, `${name} not truncated while ${active} active`).toBeLessThanOrEqual(m.clientWidth);
    }
  }
  await openGeneral();
});

test('AC7: footer shows the real version; no "Phase 1" in any section', async () => {
  await openGeneral();
  const version = await app.evaluate(({ app: a }) => a.getVersion());
  expect(version).toMatch(/^\d+\.\d+\.\d+/);
  const label = dialog().getByRole('navigation', { name: 'Settings sections' }).getByText(/^MetaLogix IDE/);
  await expect(label).toHaveText(`MetaLogix IDE ${version}`);
  expect(await style(label, 'font-size')).toBe('11.5px');
  for (const name of NAV) {
    const item = dialog().getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name, exact: true });
    await item.click();
    await expect(item).toHaveAttribute('aria-current', 'page');
    const text = await dialog().innerText();
    expect(text, `${name} section text`).toContain('MetaLogix IDE');
    expect(text, `${name} section`).not.toContain('Phase 1');
  }
  await openGeneral();
});

test('AC9-AC12: four section headings, control order, spacing, row layout and hints', async () => {
  await forEachAppearance(async (palette, theme) => {
    const at = `${palette}/${theme}`;
    const headings = scroller().getByRole('heading', { level: 2 });
    await expect(headings).toHaveText([...SECTIONS]);
    const muted = await resolveIn(dialog(), 'color', 'var(--text-muted)');
    for (const h of await headings.all()) {
      expect(await style(h, 'font-size')).toBe('12px');
      expect(await style(h, 'font-weight')).toBe('600');
      expect(await style(h, 'text-transform')).toBe('uppercase');
      expect(await style(h, 'letter-spacing')).toBe('0.6px');
      expect(await style(h, 'color'), `${at} heading colour`).toBe(muted);
    }
  });

  // AC9: no board header; the nav item named General is the positive control that the word exists in the dialog.
  await expect(scroller().getByText('General', { exact: true })).toHaveCount(0);
  await expect(scroller().getByText('Appearance and workspace defaults')).toHaveCount(0);
  await expect(dialog().getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(dialog().getByRole('button', { name: 'General', exact: true })).toHaveCount(1);

  // AC10: each control in its own section, in order top to bottom.
  const order: [string, Locator[]][] = [
    ['Appearance', [
      region('Appearance').getByRole('group', { name: 'Theme' }),
      region('Appearance').getByRole('radiogroup', { name: 'Mode' }),
      region('Appearance').getByRole('slider', { name: 'Window opacity' }),
    ]],
    ['Fonts', [
      region('Fonts').getByRole('combobox', { name: 'Interface', exact: true }),
      region('Fonts').getByRole('combobox', { name: 'Terminal', exact: true }),
      region('Fonts').getByRole('spinbutton', { name: 'Terminal font size', exact: true }),
    ]],
    ['Workspace', NUMBERS.map((n) => region('Workspace').getByRole('spinbutton', { name: n.label, exact: true }))],
    ['Notifications', SWITCHES.map((s) => region('Notifications').getByRole('switch', { name: new RegExp(s.label, 'i') }))],
  ];
  for (const [name, controls] of order) {
    let prevY = -Infinity;
    for (const control of controls) {
      await expect(control, `${name} control`).toHaveCount(1);
      const y = (await box(control)).y;
      expect(y, `${name} order`).toBeGreaterThan(prevY);
      prevY = y;
    }
  }

  // AC11: content padding and section gap.
  const sc = scroller();
  expect(await style(sc, 'padding-top')).toBe('4px');
  expect(await style(sc, 'padding-right')).toBe('28px');
  expect(await style(sc, 'padding-bottom')).toBe('28px');
  expect(await style(sc, 'padding-left')).toBe('12px');
  let prevBottom: number | null = null;
  for (const name of SECTIONS) {
    const b = await box(region(name));
    if (prevBottom !== null) expectPx(b.y - prevBottom, 30, `gap before ${name}`);
    prevBottom = b.y + b.height;
  }

  // AC12: row layout and exact hints; Theme has a label and no hint.
  const muted = await resolveIn(dialog(), 'color', 'var(--text-muted)');
  for (const [label, hint] of Object.entries(ROW_HINTS)) {
    const hintEl = scroller().getByText(hint, { exact: true });
    await expect(hintEl).toHaveCount(1);
    const labelCol = hintEl.locator('xpath=..');
    const row = labelCol.locator('xpath=..');
    const labelEl = labelCol.locator(':scope > *').first();
    await expect(labelEl).toHaveText(label);
    expect(await style(labelEl, 'font-weight')).toBe('500');
    expect(await style(hintEl, 'font-size')).toBe('12px');
    expect(await style(hintEl, 'color')).toBe(muted);
    const control = row.locator(':scope > *').nth(1);
    const [l, c, r] = [await box(labelCol), await box(control), await box(row)];
    expect(c.x - (l.x + l.width), `${label}: label/control gap`).toBeGreaterThanOrEqual(16);
    expectPx(c.y + c.height / 2, l.y + l.height / 2, `${label}: vertical centre`, 1);
    expectPx(c.x + c.width, r.x + r.width, `${label}: control at right`, 1);
  }
  await expect(region('Appearance').getByRole('group', { name: 'Theme' })).toHaveText('ThemeDefaultCatppuccinRosé Pine');
});

test('AC11: the content never scrolls horizontally at 1440 and 900 wide', async () => {
  await openGeneral();
  for (const width of [1440, 900]) {
    await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0]?.setContentSize(w, 900), width);
    await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(width);
    const m = await scroller().evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight }));
    expect(m.sw, `scrollWidth at ${width}`).toBe(m.cw);
    // Positive control: the same region does scroll vertically, so the measure reads overflow.
    expect(m.sh, `vertical overflow at ${width}`).toBeGreaterThan(m.ch);
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
  await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(1440);
});

test('AC13-AC15a: palette card geometry, selected state and swatch colours in every palette x theme', async () => {
  await forEachAppearance(async (selected, theme) => {
    const at = `${selected}/${theme}`;
    await expect(cards()).toHaveCount(3);
    const accentSoft = await resolveIn(dialog(), 'background-color', 'var(--accent-soft)');
    const accent = await resolveIn(dialog(), 'color', 'var(--accent)');
    for (const { id, label } of PALETTES) {
      const card = dialog().getByRole('button', { name: label, exact: true });
      await expect(card).toHaveAccessibleName(label);
      const cb = await box(card);
      expectPx(cb.width, 152, `${at} ${label} width`);
      for (const side of ['top', 'right', 'bottom', 'left']) expect(await style(card, `padding-${side}`)).toBe('10px');
      expect(await style(card, 'border-top-left-radius')).toBe('12px');

      const strip = swatchStrip(card);
      const sb = await box(strip);
      expectPx(sb.height, 26, `${at} ${label} strip height`);
      expect(await style(strip, 'border-top-left-radius')).toBe('7px');
      // User review addition: the strip fills the card and its four swatches share it evenly.
      expectPx(sb.width, cb.width - 20, `${at} ${label} strip width`, 1);
      const swatches = await strip.locator(':scope > span').all();
      expect(swatches).toHaveLength(4);
      for (const [i, s] of swatches.entries()) {
        const w = (await box(s)).width;
        expect(w, `${at} ${label} swatch ${i} width`).toBeGreaterThan(0);
        expectPx(w, sb.width / 4, `${at} ${label} swatch ${i} share`, 1);
      }
      expect(await swatchColours(card), `${at} ${label} swatches`).toEqual(SWATCHES[id][theme].map(rgbOf));

      const check = card.locator('svg');
      if (id === selected) {
        await expect(card).toHaveAttribute('aria-pressed', 'true');
        expect(await style(card, 'background-color'), `${at} selected fill`).toBe(accentSoft);
        // Tailwind stacks transparent ring/shadow layers before the arbitrary inset ring.
        const shadows = (await style(card, 'box-shadow')).split(/,(?![^(]*\))/).map((x) => x.trim());
        expect(shadows.at(-1), `${at} selected ring`).toBe(`${accent} 0px 0px 0px 1.5px inset`);
        for (const other of shadows.slice(0, -1)) expect(other, `${at} other shadow layers`).toMatch(/^rgba\(0, 0, 0, 0\) /);
        await expect(check).toHaveCount(1);
        await expect(check).toHaveAttribute('aria-hidden', 'true');
        const k = await box(check);
        expectPx(k.width, 13, `${at} check size`);
        expectPx(cb.x + cb.width - (k.x + k.width), 10, `${at} check inset from card right`, 1);
      } else {
        await expect(card).toHaveAttribute('aria-pressed', 'false');
        expect(await style(card, 'box-shadow'), `${at} ${label} unselected ring`).toBe('none');
        await expect(check).toHaveCount(0);
      }
    }
  });
});

test('AC15b: swatches follow Light/Dark live and the OS only in System mode', async () => {
  await applyAppearance('default', 'dark');
  const all = async () => Promise.all(PALETTES.map((p) => swatchColours(dialog().getByRole('button', { name: p.label, exact: true }))));
  const set = (theme: Theme) => PALETTES.map((p) => SWATCHES[p.id][theme].map(rgbOf));
  const radio = (name: string) => dialog().getByRole('radio', { name: new RegExp(`^${name}`) });

  await radio('Light').click();
  await expect.poll(all).toEqual(set('light'));
  await radio('Dark').click();
  await expect.poll(all).toEqual(set('dark'));

  await win.emulateMedia({ colorScheme: 'dark' });
  await osSchemeIs('dark');
  await radio('System').click();
  await expect(radio('System')).toHaveText('System · dark');
  await expect.poll(all).toEqual(set('dark'));
  await win.emulateMedia({ colorScheme: 'light' });
  await osSchemeIs('light');
  await expect(radio('System')).toHaveText('System · light');
  await expect.poll(all).toEqual(set('light'));
  await win.emulateMedia({ colorScheme: 'dark' });
  await osSchemeIs('dark');
  await expect.poll(all).toEqual(set('dark'));

  // Each negative flip is real: the OS starts on the scheme the explicit mode matches, then moves away.
  await win.emulateMedia({ colorScheme: 'light' });
  await osSchemeIs('light');
  await radio('Light').click();
  await expect.poll(all).toEqual(set('light'));
  await win.emulateMedia({ colorScheme: 'dark' });
  await osSchemeIs('dark');
  expect(await all(), 'Light ignores an OS flip to dark').toEqual(set('light'));
  await radio('Dark').click();
  await expect.poll(all).toEqual(set('dark'));
  await win.emulateMedia({ colorScheme: 'light' });
  await osSchemeIs('light');
  expect(await all(), 'Dark ignores an OS flip to light').toEqual(set('dark'));

  await win.emulateMedia({ colorScheme: null });
  await applyAppearance('default', 'dark');
});

test('AC16: Mode is a radiogroup with roving tab stop and arrow-key selection', async () => {
  await applyAppearance('default', 'dark');
  const group = dialog().getByRole('radiogroup', { name: 'Mode' });
  const radio = (name: 'System' | 'Light' | 'Dark') => group.getByRole('radio', { name: new RegExp(`^${name}`) });
  const stored = () => win.evaluate(() => localStorage.getItem('metaide.theme.v2'));
  await expect(group.getByRole('radio')).toHaveCount(3);

  const expectChecked = async (mode: 'system' | 'light' | 'dark') => {
    const name = ({ system: 'System', light: 'Light', dark: 'Dark' } as const)[mode];
    await expect(group.locator('[aria-checked="true"]')).toHaveCount(1);
    await expect(radio(name)).toHaveAttribute('aria-checked', 'true');
    await expect(radio(name)).toHaveAttribute('tabindex', '0');
    await expect(group.locator('[tabindex="-1"]')).toHaveCount(2);
    await expect(radio(name)).toBeFocused();
    expect(await stored()).toBe(mode);
  };

  await radio('Dark').click();
  await radio('Dark').focus();
  await expectChecked('dark');
  for (const [key, mode] of [
    ['ArrowRight', 'system'],
    ['ArrowLeft', 'dark'],
    ['ArrowDown', 'system'],
    ['ArrowUp', 'dark'],
    ['ArrowLeft', 'light'],
  ] as const) {
    await win.keyboard.press(key);
    await expectChecked(mode);
  }
  // Only the checked radio is a Tab stop: Tab leaves the group, Shift+Tab comes back to it.
  await win.keyboard.press('Tab');
  await expect(dialog().getByRole('slider', { name: 'Window opacity' })).toBeFocused();
  await win.keyboard.press('Shift+Tab');
  await expect(radio('Light')).toBeFocused();
  await applyAppearance('default', 'dark');
});

test('AC17: System segment names the effective theme; segment and tray sizes in every palette x theme', async () => {
  await forEachAppearance(async (palette, theme) => {
    const at = `${palette}/${theme}`;
    const group = dialog().getByRole('radiogroup', { name: 'Mode' });
    const system = group.getByRole('radio', { name: /^System/ });
    await expect(system).toHaveText(`System · ${theme}`);
    const suffix = system.locator('span');
    expect(await style(suffix, 'font-weight')).toBe('400');
    expect(await style(suffix, 'color'), `${at} suffix colour`).toBe(await style(system, 'color'));
    for (const r of await group.getByRole('radio').all()) {
      expectPx((await box(r)).height, 30, `${at} segment height`);
      expect(await style(r, 'border-top-left-radius')).toBe('8px');
    }
    for (const side of ['top', 'right', 'bottom', 'left']) expect(await style(group, `padding-${side}`)).toBe('3px');
    expect(await style(group, 'border-top-left-radius')).toBe('11px');
  });
});

test('AC18: opacity group is 260 wide with a 40px tabular percentage that updates live', async () => {
  await openGeneral();
  const slider = dialog().getByRole('slider', { name: 'Window opacity' });
  await expect(slider).toHaveAttribute('data-testid', 'window-opacity-slider');
  await expect(slider).toHaveAttribute('min', '30');
  await expect(slider).toHaveAttribute('max', '100');
  const group = slider.locator('xpath=..');
  expectPx((await box(group)).width, 260, 'opacity group width');
  const pct = group.locator(':scope > span');
  expectPx((await box(pct)).width, 40, 'percentage width');
  expect(await style(pct, 'text-align')).toBe('right');
  expect(await style(pct, 'font-variant-numeric')).toBe('tabular-nums');
  const before = await slider.inputValue();
  await slider.fill('70');
  await expect(pct).toHaveText('70%');
  await slider.fill(before);
  await expect(pct).toHaveText(`${before}%`);
});

test('AC19-AC24: font rows, option list and previews', async () => {
  await forEachAppearance(async (palette, theme) => {
    const at = `${palette}/${theme}`;
    for (const name of ['Interface', 'Terminal']) {
      const label = region('Fonts').getByText(name, { exact: true });
      const input = region('Fonts').getByRole('combobox', { name, exact: true });
      const [l, i] = [await box(label), await box(input)];
      expectPx(l.width, 110, `${at} ${name} label column`);
      expectPx(i.x - l.x, 126, `${at} ${name} column gap`);
      expect(await style(label, 'font-weight')).toBe('500');
      expectPx(i.height, 40, `${at} ${name} input height`);
      expect(await style(input, 'border-top-left-radius')).toBe('10px');
      expect(await style(input, 'font-size')).toBe('14px');
    }
    // AC22: the open list sits lighter than the dialog.
    const input = region('Fonts').getByRole('combobox', { name: 'Interface' });
    await input.click();
    const list = dialog().getByRole('listbox', { name: 'Interface options' });
    await expect(list).toBeVisible();
    await settle();
    const listLum = await backgroundLuminance(win, list, theme);
    const dialogLum = await backgroundLuminance(win, dialog(), theme);
    expect(listLum.lum, `${at} list ${listLum.hex} vs dialog ${dialogLum.hex}`).toBeGreaterThan(dialogLum.lum);
    await win.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
  });

  // AC19
  await expect(region('Fonts').getByRole('heading', { name: 'Fonts', level: 2 })).toBeVisible();
  await expect(region('Fonts').getByText(FONTS_HINT, { exact: true })).toBeVisible();

  // AC20: editable, focus ring visible on focus.
  const input = region('Fonts').getByRole('combobox', { name: 'Interface' });
  await expect(input).toBeEditable();
  expect(await input.getAttribute('readonly')).toBeNull();
  expect(await style(input, 'box-shadow'), 'no ring before focus').toBe('none');
  await input.focus();
  await expect.poll(() => style(input, 'box-shadow'), { message: 'focus ring' }).not.toBe('none');

  // AC21, AC23
  const list = dialog().getByRole('listbox', { name: 'Interface options' });
  await expect(list).toBeVisible();
  await expect(list.getByRole('option', { name: 'Menlo' })).toBeVisible();
  await settle();
  expect(await style(list, 'border-top-left-radius')).toBe('12px');
  for (const side of ['top', 'right', 'bottom', 'left']) expect(await style(list, `padding-${side}`)).toBe('5px');
  expect(await style(list, 'overflow-y')).toBe('auto');
  expect(await style(list, 'max-height')).not.toBe('none');
  await expect(list).toHaveClass(/\bpopover\b/);
  const options = list.getByRole('option');
  for (const o of await options.all()) {
    expectPx((await box(o)).height, 34, 'option row height');
    expect(await style(o, 'border-top-left-radius')).toBe('8px');
    expect(await style(o, 'font-size')).toBe('14px');
    expectPx((await box(o.locator(':scope > span').first())).width, 14, 'check slot width');
  }
  const selected = list.locator('[aria-selected="true"]');
  await expect(selected).toHaveCount(1);
  await expect(selected).toHaveText('System default');
  const check = selected.locator('svg');
  const k = await box(check);
  expectPx(k.width, 13, 'check width');
  expectPx(k.height, 13, 'check height');
  expect(await check.evaluate((e) => getComputedStyle(e).color)).toBe(await resolveIn(list, 'color', 'var(--accent)'));
  await expect(list.locator('[aria-selected="false"] svg')).toHaveCount(0);
  expect(await list.innerText()).not.toContain('✓');
  expect(await list.innerText()).not.toContain('SF Mono');
  const defaultLabel = selected.locator(':scope > span').nth(1);
  expect(await style(defaultLabel, 'color')).toBe(await resolveIn(list, 'color', 'var(--text-muted)'));
  const hover = await resolveIn(list, 'background-color', 'var(--surface-hover)');
  const menlo = list.getByRole('option', { name: 'Menlo' });
  // The first pointer sample only seeds the position (a list opening under a still pointer must not highlight); the second moves.
  await menlo.hover({ position: { x: 40, y: 10 } });
  await menlo.hover({ position: { x: 60, y: 14 } });
  await expect.poll(() => style(menlo, 'background-color'), { message: 'highlighted row fill' }).toBe(hover);
  expect(await style(list.getByRole('option', { name: 'Helvetica Neue' }), 'background-color'), 'non-highlighted row').toBe('rgba(0, 0, 0, 0)');
  // The list's mousedown handler keeps focus in the input.
  const lb = await box(list);
  // Top padding, mid-width: the rounded corners are not part of the hit area.
  await win.mouse.move(lb.x + lb.width / 2, lb.y + 2);
  expect(await win.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('role'), { x: lb.x + lb.width / 2, y: lb.y + 2 })).toBe('listbox');
  await win.mouse.down();
  await win.mouse.up();
  await expect(input).toBeFocused();
  await expect(list).toBeVisible();
  await win.keyboard.press('Escape');
  await expect(list).toHaveCount(0);

  // AC24
  await expect(dialog().getByLabel('Interface preview')).toHaveText('The quick brown fox jumps over the lazy dog.');
  const terminal = dialog().getByLabel('Terminal preview');
  expect(await terminal.textContent()).toMatch(/^Aa 0O 1l → ~\/project .$/u);
  await expect(terminal).not.toContainText('⎇ main');
  await expect(terminal.getByRole('img', { name: 'private-use glyph sample' })).toHaveCount(1);
  for (const name of ['Interface', 'Terminal']) {
    const family = await style(region('Fonts').getByRole('combobox', { name, exact: true }), 'font-family');
    expect(await style(dialog().getByLabel(`${name} preview`), 'font-family')).toBe(family);
  }
});

test('AC27: workspace numbers are 84x34, right-aligned, labelled and clamp as before', async () => {
  await openGeneral();
  for (const n of NUMBERS) {
    const input = region('Workspace').getByRole('spinbutton', { name: n.label, exact: true });
    await expect(input).toHaveAccessibleName(n.label);
    const b = await box(input);
    expectPx(b.width, 84, `${n.label} width`);
    expectPx(b.height, 34, `${n.label} height`);
    expect(await style(input, 'border-top-left-radius')).toBe('9px');
    expect(await style(input, 'text-align')).toBe('right');
    expect(await style(input, 'font-variant-numeric')).toBe('tabular-nums');
    await expect(input).toHaveAttribute('min', String(n.min));
    await expect(input).toHaveAttribute('max', String(n.max));
    await expect(input).toHaveAttribute('step', String(n.step));

    const original = await setting(n.key);
    await input.fill(String(n.over));
    await expect(input).toHaveValue(String(n.max));
    await expect.poll(() => setting(n.key)).toBe(n.max);
    await input.fill(String(n.under));
    await expect(input).toHaveValue(String(n.min));
    await expect.poll(() => setting(n.key)).toBe(n.min);
    await input.fill(String(original));
    await expect.poll(() => setting(n.key)).toBe(original);
  }
});

test('AC28, AC29: notification switches in every palette x theme', async () => {
  const track = (sw: Locator) => sw.locator('xpath=following-sibling::span[1]');
  const thumb = (sw: Locator) => sw.locator('xpath=following-sibling::span[2]');

  await forEachAppearance(async (palette, theme) => {
    const at = `${palette}/${theme}`;
    const accent = await resolveIn(dialog(), 'background-color', 'var(--accent)');
    const off = await resolveIn(dialog(), 'background-color', 'var(--switch-off)');
    await expectVisibleColour(off, `${at} --switch-off`);
    for (const s of SWITCHES) {
      const sw = win.getByTestId(s.testId);
      const t = await box(track(sw));
      expectPx(t.width, 38, `${at} ${s.label} track width`);
      expectPx(t.height, 22, `${at} ${s.label} track height`);
      expect(await style(track(sw), 'border-top-left-radius')).toBe('11px');
      const th = await box(thumb(sw));
      expectPx(th.width, 16, `${at} thumb width`);
      expectPx(th.height, 16, `${at} thumb height`);
      // Both defaults are on (AC30): accent track, thumb at the right.
      await expect(sw).toBeChecked();
      await expect.poll(() => style(track(sw), 'background-color'), { message: `${at} on track` }).toBe(accent);
      await expect.poll(async () => {
        const [tt, hh] = [await box(track(sw)), await box(thumb(sw))];
        return Math.round(tt.x + tt.width - (hh.x + hh.width));
      }, { message: `${at} ${s.label} thumb right when on` }).toBe(3);
      expect(off, `${at} off track differs from on`).not.toBe(accent);
    }
  });

  await openGeneral();
  const accent = await resolveIn(dialog(), 'background-color', 'var(--accent)');
  const off = await resolveIn(dialog(), 'background-color', 'var(--switch-off)');
  await expectVisibleColour(off, '--switch-off');
  for (const s of SWITCHES) {
    const sw = win.getByTestId(s.testId);
    await expect(sw).toHaveRole('switch');
    const name = (await sw.getAttribute('aria-label')) ?? '';
    expect(name.toLowerCase()).toContain(s.label.toLowerCase());
    await expect(sw).toHaveAccessibleName(name);
    const onX = (await box(thumb(sw))).x;

    // Clicking the row label toggles off; state shows by thumb position as well as colour.
    await region('Notifications').getByText(s.label, { exact: true }).click();
    await expect(sw).not.toBeChecked();
    await expect.poll(() => setting(s.key)).toBe(false);
    await expect.poll(() => style(track(sw), 'background-color')).toBe(off);
    await expect.poll(async () => Math.round((await box(thumb(sw))).x - (await box(track(sw))).x), {
      message: `${s.label} thumb left when off`,
    }).toBe(3);
    expect((await box(thumb(sw))).x, 'thumb moved').toBeLessThan(onX - 8);

    // Clicking the switch itself toggles back on.
    await sw.click();
    await expect(sw).toBeChecked();
    await expect.poll(() => setting(s.key)).toBe(true);
    await expect.poll(() => style(track(sw), 'background-color')).toBe(accent);
    await expect.poll(async () => (await box(thumb(sw))).x).toBeCloseTo(onX, 0);
  }

  // Keyboard focus shows a ring on the track; the sibling switch, unfocused, has none.
  const first = win.getByTestId(SWITCHES[0].testId);
  expect(await style(track(first), 'box-shadow')).toBe('none');
  await region('Workspace').getByRole('spinbutton', { name: 'Max watched paths' }).focus();
  await win.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await expect.poll(() => style(track(first), 'box-shadow'), { message: 'switch focus ring' }).not.toBe('none');
  expect(await style(track(win.getByTestId(SWITCHES[1].testId)), 'box-shadow')).toBe('none');
});

test('AC32: text contrast on the effective background in every palette x theme', async () => {
  const primary = (): [string, Locator][] => [
    ...['Theme', 'Mode', 'Window opacity', 'Interface', 'Terminal', ...NUMBERS.map((n) => n.label), ...SWITCHES.map((s) => s.label)].map(
      (t): [string, Locator] => [`label ${t}`, scroller().getByText(t, { exact: true })],
    ),
    ['opacity value', dialog().getByRole('slider', { name: 'Window opacity' }).locator('xpath=../span')],
    ...NUMBERS.map((n): [string, Locator] => [`value ${n.label}`, dialog().getByRole('spinbutton', { name: n.label, exact: true })]),
  ];
  const secondary = (): [string, Locator][] => [
    ...SECTIONS.map((s): [string, Locator] => [`heading ${s}`, region(s).getByRole('heading', { level: 2 })]),
    ...[...Object.values(ROW_HINTS), FONTS_HINT].map((h): [string, Locator] => [`hint ${h}`, scroller().getByText(h, { exact: true })]),
    ['selected card label', cards().and(win.locator('[aria-pressed="true"]')).locator(':scope > span').nth(1)],
    ['checked Mode segment', dialog().getByRole('radio', { checked: true })],
  ];
  const check = async (at: string, theme: Theme, items: [string, Locator][], floor: number) => {
    for (const [what, el] of items) {
      await expect(el, `${at} ${what}`).toHaveCount(1);
      const { ratio, detail } = await textContrast(win, el, theme);
      expect(ratio, `${at} ${what}: ${detail}`).toBeGreaterThanOrEqual(floor);
    }
  };

  await forEachAppearance(async (palette, theme) => {
    const at = `${palette}/${theme}`;
    // Unselected cards and Mode segments carry primary text on their own fills.
    const unselected: [string, Locator][] = [
      ...(await cards().and(win.locator('[aria-pressed="false"]')).all()).map((c, i): [string, Locator] => [`unselected card ${i}`, c.locator(':scope > span').nth(1)]),
      ...(await dialog().getByRole('radio', { checked: false }).all()).map((r, i): [string, Locator] => [`unchecked segment ${i}`, r]),
    ];
    await check(at, theme, [...primary(), ...unselected], 4.5);
    await check(at, theme, secondary(), 3);

    // The active System segment with its "· <effective>" suffix, reached through System + the OS scheme.
    await win.emulateMedia({ colorScheme: theme });
    await dialog().getByRole('radio', { name: /^System/ }).click();
    await expect(win.locator('html')).not.toHaveAttribute('data-theme', /.+/);
    await win.mouse.move(2, 2);
    await settle();
    const system = dialog().getByRole('radio', { name: /^System/ });
    await expect(system).toHaveAttribute('aria-checked', 'true');
    const suffix = system.locator('span');
    await expect(suffix).toHaveText(` · ${theme}`);
    expect(await style(suffix, 'color'), `${at} suffix inherits the label colour`).toBe(await style(system, 'color'));
    await check(`${at} system`, theme, [['System segment', system], ['System suffix', suffix]], 3);
    // Positive control: the effective background under the active segment includes the accent-soft fill.
    const e = await effectiveColours(win, system, theme);
    expect(e.layers.at(-1), `${at} segment fill`).toBe(await resolveIn(dialog(), 'background-color', 'var(--accent-soft)'));
    await check(`${at} system`, theme, primary(), 4.5);
  });
  await win.emulateMedia({ colorScheme: null });
});

test('AC7: footer falls back to the wordmark when app:get-version rejects', async () => {
  await closeSettings();
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as IpcMainWithHandlers)._invokeHandlers;
    if (!handlers?.get('app:get-version')) throw new Error('app:get-version handler unavailable');
    const g = globalThis as typeof globalThis & { __versionCalls?: number };
    g.__versionCalls = 0;
    ipcMain.removeHandler('app:get-version');
    ipcMain.handle('app:get-version', () => {
      g.__versionCalls = (g.__versionCalls ?? 0) + 1;
      throw new Error('injected version failure');
    });
  });
  const versionCalls = () =>
    app.evaluate(() => (globalThis as typeof globalThis & { __versionCalls?: number }).__versionCalls ?? 0);
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(e.message));
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await mockLocalFonts();
  await openGeneral();
  // Positive sentinel: the rejecting handler has actually answered every mounted caller
  // (Settings' useAppVersion, plus the status bar's own fetch when it is mounted), then a
  // render tick, so the wordmark below is the post-rejection render, not the pre-fetch one.
  const callers = 1 + (await win.getByTestId('status-bar').count());
  await expect.poll(versionCalls, { message: 'injected app:get-version invoked' }).toBeGreaterThanOrEqual(callers);
  await win.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  const nav = dialog().getByRole('navigation', { name: 'Settings sections' });
  await expect(nav.getByText(/^MetaLogix IDE/)).toHaveText('MetaLogix IDE');
  await expect(win.getByTestId('settings-modal').getByRole('alert')).toHaveCount(0);
  // Positive control: the rest of the dialog rendered normally in the same pass.
  await expect(region('Appearance')).toBeVisible();
  expect(errors).toEqual([]);
});
