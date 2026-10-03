/**
 * Split shell and sidebar motion.
 *
 * - Opening/closing the split animates the right pane (clip-path reveal via
 *   WAAPI) and never remounts the left terminal — the left pane used to be a
 *   different element in single vs split view, so its xterm was torn down
 *   and replayed on every toggle.
 * - The right pane is fully removed after the exit, and the left pane takes
 *   the full width again.
 * - The sidebar animates when toggled with the mouse, but ⌘B stays instant.
 *
 * Animations are observed by recording Element.prototype.animate calls, so
 * the assertions don't race the 160–220 ms durations.
 */

import { test, expect, _electron as electron, type Page, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Api = { invoke: (c: string, r: unknown) => Promise<never> };
type Recorded = { testid: string | null; clip: boolean };

async function launch(): Promise<{ app: ElectronApplication; win: Page; cleanup: () => void }> {
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
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1400, 900); });
  await win.evaluate(async (path: string) => {
    await (window as unknown as { api: Api }).api.invoke('roots:add', { path });
  }, demoRoot);
  await win.getByRole('button', { name: 'demo', exact: true }).click();
  await expect(win.locator('[data-testid="shell-tab"] .xterm-screen')).toBeVisible({ timeout: 10000 });
  return {
    app, win,
    cleanup: () => {
      rmSync(isolatedHome, { recursive: true, force: true });
      rmSync(demoRoot, { recursive: true, force: true });
    },
  };
}

/** Starts recording WAAPI calls: which element (by its first descendant testid) and whether it clips. */
async function recordAnimations(win: Page): Promise<void> {
  await win.evaluate(() => {
    const w = window as unknown as { __anims: Recorded[]; __origAnimate?: typeof Element.prototype.animate };
    w.__anims = [];
    if (!w.__origAnimate) {
      w.__origAnimate = Element.prototype.animate;
      Element.prototype.animate = function (this: Element, frames, opts) {
        const list = Array.isArray(frames) ? frames : [];
        w.__anims.push({
          testid: this.querySelector('[data-testid]')?.getAttribute('data-testid') ?? null,
          clip: list.some((f) => 'clipPath' in (f as object)),
        });
        return w.__origAnimate!.call(this, frames, opts);
      };
    }
  });
}

async function recorded(win: Page): Promise<Recorded[]> {
  return win.evaluate(() => (window as unknown as { __anims: Recorded[] }).__anims);
}

test('split open/close animates the right pane and keeps the left terminal mounted', async () => {
  const { app, win, cleanup } = await launch();
  try {
    const shellTabs = win.locator('[data-testid="shell-tab"]');
    await expect(shellTabs).toHaveCount(1);
    // Tag the left terminal element; a remount would drop the tag.
    await win.evaluate(() => {
      (document.querySelector('[data-testid="shell-tab"] .xterm') as HTMLElement & { __leftTag?: boolean }).__leftTag = true;
    });

    await recordAnimations(win);
    await win.getByTestId('tabbar-split').click();
    await expect(win.getByTestId('split-right')).toBeVisible();
    await expect(shellTabs).toHaveCount(2);
    expect(await recorded(win), 'split open animates with a clip-path reveal').toContainEqual({ testid: 'split-right', clip: true });

    const leftKept = () => win.evaluate(() =>
      (document.querySelector('[data-testid="shell-tab"] .xterm') as HTMLElement & { __leftTag?: boolean } | null)?.__leftTag === true);
    expect(await leftKept(), 'left terminal survives opening the split').toBe(true);

    await recordAnimations(win);
    await win.getByTestId('tabbar-split').click();
    await expect(win.getByTestId('split-right')).toHaveCount(0);
    await expect(shellTabs).toHaveCount(1);
    expect(await recorded(win), 'split close animates the right pane out').toContainEqual({ testid: 'split-right', clip: true });
    expect(await leftKept(), 'left terminal survives closing the split').toBe(true);

    // Left pane fills the row again once the right pane is gone.
    const widths = await win.evaluate(() => {
      const left = document.querySelector('.split-left')!.getBoundingClientRect().width;
      const row = document.querySelector('.split-left')!.parentElement!.getBoundingClientRect().width;
      return { left, row };
    });
    expect(Math.abs(widths.left - widths.row)).toBeLessThan(1);
  } finally {
    await app.close();
    cleanup();
  }
});

test('sidebar animates on click but toggles instantly from the keyboard', async () => {
  const { app, win, cleanup } = await launch();
  try {
    const sidebar = win.getByTestId('new-project-btn');
    await expect(sidebar).toBeVisible();

    await recordAnimations(win);
    await win.getByTestId('ab-toggle-sidebar').click();
    await expect(sidebar).toHaveCount(0);
    await win.getByTestId('ab-toggle-sidebar').click();
    await expect(sidebar).toBeVisible();
    const clicks = (await recorded(win)).filter((a) => a.clip);
    expect(clicks.length, 'click hide + click show both animate').toBeGreaterThanOrEqual(2);

    await recordAnimations(win);
    await win.getByTestId('activity-bar').click({ position: { x: 20, y: 400 } }); // move focus out of the terminal
    await win.keyboard.press('ControlOrMeta+b');
    await expect(sidebar).toHaveCount(0);
    await win.keyboard.press('ControlOrMeta+b');
    await expect(sidebar).toBeVisible();
    expect((await recorded(win)).filter((a) => a.clip), '⌘B never animates').toEqual([]);
  } finally {
    await app.close();
    cleanup();
  }
});
