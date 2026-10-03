/**
 * Shell tab height — shrinking the window must shrink the shell tab to the
 * space left under the shell tab strip, so the terminal's last rows (where
 * Claude's prompt sits) stay above the status bar.
 *
 * Regression: the ShellTab root is `h-full` in a flex column beside
 * ShellTabsBar. Without `min-h-0` its automatic minimum height is its
 * content, so once the terminal had been fitted to a taller window the tab
 * could not shrink below the full column height and overflowed `<main>` by
 * the tab strip's height — the bottom rows landed under the status bar.
 * Growing the window was unaffected, which is why it only happened
 * "sometimes".
 */

import { test, expect, _electron as electron, type Page, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WIDTH = 1400;
const TALL = 1000;
const SHORT_HEIGHTS = [800, 600];

type Api = { invoke: (c: string, r: unknown) => Promise<never> };
type Geometry = { mainBottom: number; tabBottom: number; screenBottom: number; screenHeight: number };

async function setWindowSize(app: ElectronApplication, size: { width: number; height: number }): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()[0].setSize(s.width, s.height);
  }, size);
}

async function geometry(win: Page): Promise<Geometry> {
  return win.evaluate(() => {
    const rect = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`missing ${sel}`);
      return el.getBoundingClientRect();
    };
    const screen = rect('[data-testid="shell-tab"] .xterm-screen');
    return {
      mainBottom: rect('main').bottom,
      tabBottom: rect('[data-testid="shell-tab"]').bottom,
      screenBottom: screen.bottom,
      screenHeight: screen.height,
    };
  });
}

/** Waits until the terminal's height has changed from `from` and then held for two reads. */
async function settledGeometry(win: Page, from: number): Promise<Geometry> {
  let previous = await geometry(win);
  await expect.poll(async () => (previous = await geometry(win)).screenHeight, { timeout: 10000 }).not.toBe(from);
  await expect.poll(async () => {
    const current = await geometry(win);
    const stable = current.screenHeight === previous.screenHeight && current.tabBottom === previous.tabBottom;
    previous = current;
    return stable;
  }, { timeout: 10000, intervals: [300] }).toBe(true);
  return previous;
}

test('shrinking the window keeps the shell tab and its last terminal row above the status bar', async () => {
  const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
  const isolatedHome = mkdtempSync(join(tmpdir(), 'metaide-home-'));
  const demoRoot = mkdtempSync(join(tmpdir(), 'metaide-demo-'));
  mkdirSync(join(demoRoot, 'demo'));
  mkdirSync(join(demoRoot, 'demo', '.git'));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${join(isolatedHome, 'userData')}`],
    env: {
      ...process.env,
      HOME: isolatedHome,
      METAIDE_TEST_MODE: '1',
      METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
      METAIDE_DEFAULT_LAUNCH_FIRST:      JSON.stringify({ argv: ['node', mockClaude],               env: {} }),
      METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: ['node', mockClaude, '--continue'], env: {} }),
    },
  });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await setWindowSize(app, { width: WIDTH, height: TALL });
    await win.evaluate(async (path: string) => {
      await (window as unknown as { api: Api }).api.invoke('roots:add', { path });
    }, demoRoot);
    await win.getByRole('button', { name: 'demo', exact: true }).click();
    await expect(win.locator('[data-testid="shell-tab"] .xterm-screen')).toBeVisible({ timeout: 10000 });

    let last = await settledGeometry(win, -1);
    expect(last.tabBottom, 'shell tab at the tall window').toBeLessThanOrEqual(last.mainBottom + 0.5);

    for (const height of SHORT_HEIGHTS) {
      await setWindowSize(app, { width: WIDTH, height });
      const g = await settledGeometry(win, last.screenHeight);
      test.info().annotations.push({ type: `geometry@${height}`, description: JSON.stringify(g) });
      // Positive control: the resize reached the terminal and it shrank.
      expect(g.screenHeight, `terminal shrinks at height ${height}`).toBeLessThan(last.screenHeight);
      expect(g.tabBottom, `shell tab bottom vs main bottom at height ${height}`).toBeLessThanOrEqual(g.mainBottom + 0.5);
      expect(g.screenBottom, `last terminal row vs main bottom at height ${height}`).toBeLessThanOrEqual(g.mainBottom + 0.5);
      last = g;
    }
  } finally {
    await app.close();
    rmSync(isolatedHome, { recursive: true, force: true });
    rmSync(demoRoot, { recursive: true, force: true });
  }
});
