import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { closeApp, guardedLaunch } from './helpers/claude-harness';
import { terminalProbes } from './helpers/terminal-probe';

/**
 * Italic, dim and bold-italic text on the default background must not get a background of its
 * own. The terminal theme background is transparent, and the WebGL renderer used to fill such
 * cells with it at full opacity: opaque black boxes (see patches/README.md).
 */

// Each row: 30 spaces in one style, then a marker. Spaces draw no glyph, so the row shows only background.
const STYLES = ['0', '3', '2', '1;3'];
/** Last row: italic on an explicit blue background, which must still be filled. */
const FILLED = '3;44';
const SCRIPT = [
  `const rows = ${JSON.stringify([...STYLES, FILLED])}.map((s) => '\\x1b[' + s + 'm' + ' '.repeat(30) + '\\x1b[0m|');`,
  "process.stdout.write('\\x1b[?25l\\x1b[2J\\x1b[H' + rows.join('\\r\\n'));",
  'setInterval(() => {}, 1000);',
].join(' ');

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  await guardedLaunch(async (scope) => {
    const home = scope.tempDir('metaide-styled-home-');
    const root = scope.tempDir('metaide-styled-root-');
    mkdirSync(join(root, 'styled')); mkdirSync(join(root, 'styled', '.git'));
    const launch = JSON.stringify({ argv: ['node', '-e', SCRIPT], env: {} });
    app = scope.own(await electron.launch({
      args: ['.', `--user-data-dir=${join(home, 'userData')}`],
      env: { ...process.env, HOME: home, METAIDE_TEST_MODE: '1', METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
        METAIDE_DEFAULT_LAUNCH_FIRST: launch, METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: launch },
    }));
    win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.evaluate(async (path: string) => {
      await (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } }).api.invoke('roots:add', { path });
    }, root);
    await win.locator('[data-testid="project-row"]', { hasText: 'styled' }).first().click();
  });
});

test.afterAll(async () => {
  if (app) await closeApp(app);
});

/** Distinct colours in a CSS-pixel rectangle of the window, read from a screenshot. */
async function coloursIn(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<string[]> {
  const png = (await page.screenshot({ clip })).toString('base64');
  return page.evaluate(async (b64: string) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return [];
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const seen = new Set<string>();
    for (let i = 0; i < data.length; i += 4) seen.add(`#${[data[i], data[i + 1], data[i + 2]].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('')}`);
    return [...seen];
  }, png);
}

test('styled text on the default background shows the same backdrop as plain text', async () => {
  const tab = win.getByTestId('shell-tab').first();
  // The WebGL renderer is the one under test; the DOM fallback has no canvas and never had the bug.
  await expect(tab.locator('.xterm-screen canvas').first()).toBeVisible({ timeout: 10_000 });
  const cell = async () => {
    const [probe] = await terminalProbes(win);
    const box = await tab.locator('.xterm-screen').boundingBox();
    if (!probe || !box || probe.cols < 40 || box.width === 0) return null;
    return { x: box.x, y: box.y, width: box.width / probe.cols, height: box.height / probe.rows };
  };
  await expect.poll(cell, { message: 'terminal is laid out', timeout: 10_000 }).not.toBeNull();
  const g = await cell();
  if (!g) throw new Error('terminal geometry unavailable');
  // The rows are painted once the '|' marker in column 30 shows ink.
  const rowsBox = { y: g.y + 2, height: g.height * (STYLES.length - 0.5) };
  await expect.poll(async () => (await coloursIn(win, { x: g.x + g.width * 30, width: g.width, ...rowsBox })).length,
    { message: 'marker column is painted', timeout: 10_000 }).toBeGreaterThan(1);

  // Columns 2-28 hold only spaces: plain, italic, dim and bold-italic, top to bottom.
  const colours = await coloursIn(win, { x: g.x + g.width * 2, width: g.width * 26, ...rowsBox });
  expect(colours, 'one backdrop colour behind every style').toHaveLength(1);

  const filled = await coloursIn(win, { x: g.x + g.width * 2, width: g.width * 26, y: g.y + g.height * (STYLES.length + 0.25), height: g.height * 0.5 });
  expect(filled, 'an explicit background is one solid colour').toHaveLength(1);
  expect(filled[0], 'an explicit background is still painted').not.toBe(colours[0]);
});
