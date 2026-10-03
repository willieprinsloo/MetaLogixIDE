/**
 * Claude tab full width — the Claude PTY must start at the size of the
 * xterm terminal in its tab, not PtyManager's 100x30 spawn default.
 *
 * Regression: ShellTab sends `shells:resize` when it fits, then caches the
 * cols/rows and never resends them. PtyManager used to drop a resize for a
 * PTY that did not exist, and spawn at 100x30 regardless, so a Claude PTY
 * spawned into an already-fitted tab ran at 100 columns in a wider tab.
 * User repro: close the Claude tab (unload shell 0), then open Claude again
 * from "+ new shell" — it reuses index 0, the mounted ShellTab never remounts
 * or resends its size, and the new PTY stays at 100 columns.
 *
 * xterm's cols are not reachable from outside the renderer (the Terminal
 * instance is private to ShellTab and `window.api` is a frozen contextBridge
 * object), so the tests get the tab's real column count through the app's
 * own resize path: shrink the window, then restore it. The restore makes
 * ShellTab refit and send `shells:resize` with the xterm's cols for the
 * original width, and mock-claude's `/size` reports what the PTY actually
 * has. The size the PTY had at launch must equal that.
 */

import { test, expect, _electron as electron, type Page, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WIDE = { width: 1600, height: 1000 };
const NARROW = { width: 900, height: 1000 };
const SIZE_RE = /size: (\d+)x(\d+)/g;

type Size = { cols: number; rows: number };
type Api = { invoke: (c: string, r: unknown) => Promise<never> };
type AliveShell = { projectId: number; projectName: string; shellIndex: number };

/** Serialized terminal state (screen + scrollback, not raw PTY bytes) of the project's live primary shell (see project-lifecycle.spec.ts). */
async function shellOutput(win: Page, projectName: string): Promise<string> {
  return win.evaluate(async (name: string) => {
    const api = (window as unknown as { api: Api }).api;
    const { shells } = (await api.invoke('shells:alive-list', undefined)) as { shells: AliveShell[] };
    const shell = shells.find((s) => s.projectName === name && s.shellIndex === 0);
    if (!shell) return '';
    const snap = (await api.invoke('shells:snapshot', { projectId: shell.projectId, shellIndex: shell.shellIndex })) as { output: string };
    return snap.output;
  }, projectName);
}

async function isAlive(win: Page, projectName: string): Promise<boolean> {
  return win.evaluate(async (name: string) => {
    const api = (window as unknown as { api: Api }).api;
    const { shells } = (await api.invoke('shells:alive-list', undefined)) as { shells: AliveShell[] };
    return shells.some((s) => s.projectName === name && s.shellIndex === 0);
  }, projectName);
}

/** Writes to the project's primary shell over the same channel xterm's onData uses. */
async function writeToShell(win: Page, projectName: string, data: string): Promise<void> {
  await win.evaluate(async ({ name, data }: { name: string; data: string }) => {
    const api = (window as unknown as { api: Api }).api;
    const { shells } = (await api.invoke('shells:alive-list', undefined)) as { shells: AliveShell[] };
    const shell = shells.find((s) => s.projectName === name && s.shellIndex === 0);
    if (!shell) throw new Error(`no live shell for ${name}`);
    await api.invoke('shells:write', { projectId: shell.projectId, shellIndex: shell.shellIndex, data });
  }, { name: projectName, data });
}

function sizeReports(output: string): Size[] {
  return [...output.matchAll(SIZE_RE)].map((m) => ({ cols: Number(m[1]), rows: Number(m[2]) }));
}

/** Sends `/size` to the project's Claude PTY and returns the size mock-claude reports. */
async function ptySize(win: Page, projectName: string): Promise<Size> {
  const before = sizeReports(await shellOutput(win, projectName)).length;
  await writeToShell(win, projectName, '/size\r');
  let reports: Size[] = [];
  await expect.poll(async () => {
    reports = sizeReports(await shellOutput(win, projectName));
    return reports.length;
  }, { timeout: 10000 }).toBeGreaterThan(before);
  return reports[reports.length - 1];
}

/**
 * Polls `/size` until the PTY's cols differ from `from` — the viewport's
 * resize reached it — then until two consecutive reports agree, because a
 * window resize can reach the PTY in more than one step while layout settles.
 */
async function ptySizeAfterChange(win: Page, projectName: string, from: Size): Promise<Size> {
  let previous = from;
  await expect.poll(async () => {
    previous = await ptySize(win, projectName);
    return previous.cols;
  }, { timeout: 15000, intervals: [250, 500, 1000] }).not.toBe(from.cols);
  await expect.poll(async () => {
    const current = await ptySize(win, projectName);
    const stable = current.cols === previous.cols && current.rows === previous.rows;
    previous = current;
    return stable;
  }, { timeout: 15000, intervals: [500] }).toBe(true);
  return previous;
}

async function setWindowSize(app: ElectronApplication, size: { width: number; height: number }): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()[0].setSize(s.width, s.height);
  }, size);
}

/**
 * The tab's xterm size at WIDE, obtained through the app's own resize path:
 * shrink then restore the window. Each step makes ShellTab refit and send a
 * real `shells:resize`, so the restored value is by construction the xterm's
 * cols/rows at WIDE. Leaves the window at WIDE.
 */
async function tabXtermSize(app: ElectronApplication, win: Page, projectName: string, current: Size): Promise<{ tab: Size; narrow: Size }> {
  await setWindowSize(app, NARROW);
  const narrow = await ptySizeAfterChange(win, projectName, current);
  await setWindowSize(app, WIDE);
  const tab = await ptySizeAfterChange(win, projectName, narrow);
  // Positive control: the window really is wide enough that the correct
  // answer is not the 100-col default, and the resize path reaches the PTY.
  expect(tab.cols, 'xterm cols at the wide window').toBeGreaterThan(100);
  expect(narrow.cols, 'shrinking the window must shrink the PTY').toBeLessThan(tab.cols);
  return { tab, narrow };
}

async function openDemoProject(): Promise<{ app: ElectronApplication; win: Page; cleanup: () => void }> {
  const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
  const isolatedHome = mkdtempSync(join(tmpdir(), 'metaide-home-'));
  const demoRoot     = mkdtempSync(join(tmpdir(), 'metaide-demo-'));
  const proj         = join(demoRoot, 'demo');
  mkdirSync(proj); mkdirSync(join(proj, '.git'));
  // The "Claude" CLI profile in "+ new shell" runs this shim, named `claude`
  // like the real binary, which execs mock-claude.
  const claudeShim = join(isolatedHome, 'bin', 'claude');
  mkdirSync(join(isolatedHome, 'bin'));
  writeFileSync(claudeShim, `#!/bin/sh\nexec node ${JSON.stringify(mockClaude)} "$@"\n`);
  chmodSync(claudeShim, 0o755);

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
  const cleanup = () => {
    rmSync(isolatedHome, { recursive: true, force: true });
    rmSync(demoRoot, { recursive: true, force: true });
  };
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  // Wide enough that the tab's xterm is well over 100 columns.
  await setWindowSize(app, WIDE);

  // `dialogs:pick-directory` is a no-op under METAIDE_TEST_MODE, so add the
  // root over IPC (as project-lifecycle.spec.ts does); the project itself is
  // opened through the real UI path — a sidebar click → App.tsx pick().
  await win.evaluate(async ({ path, claudeShim }: { path: string; claudeShim: string }) => {
    const api = (window as unknown as { api: Api }).api;
    await api.invoke('settings:set', { key: 'default_cli_profiles', value: [{ name: 'Claude', argv: [claudeShim] }] });
    await api.invoke('roots:add', { path });
  }, { path: demoRoot, claudeShim });
  const projectButton = win.getByRole('button', { name: 'demo', exact: true });
  await expect(projectButton).toBeVisible({ timeout: 5000 });
  await projectButton.click();

  await expect(win.locator('.xterm').first()).toBeVisible({ timeout: 10000 });
  await expect.poll(() => shellOutput(win, 'demo'), { timeout: 10000 }).toContain('mock-claude ready');
  return { app, win, cleanup };
}

test('Claude reopened from "+ new shell" after closing its tab starts at the tab xterm width, not 100 cols', async () => {
  const { app, win, cleanup } = await openDemoProject();
  try {
    // First open (sidebar click → pick()) — the tab's size must reach Claude too.
    const atFirstOpen = await ptySize(win, 'demo');

    // Close the Claude tab: the toolbar's unload control (the X beside the
    // project name — shell 0 has no X in the tab strip) kills shell 0. The
    // active tab stays index 0, so its ShellTab stays mounted, size cached.
    await win.getByTestId('unload-current').click();
    await expect.poll(() => isAlive(win, 'demo'), { timeout: 10000 }).toBe(false);

    // Open Claude again from the "+ new shell" menu. shells:launch-cli takes
    // the smallest free index — 0 again — and setActiveShellIndex(0) is a
    // no-op, so ShellTab neither remounts nor resends its size.
    await win.getByTestId('tabbar-new-shell').click();
    await win.locator('[data-new-shell-menu]').locator('button', { hasText: 'Claude' }).first().click();
    await expect.poll(() => shellOutput(win, 'demo'), { timeout: 10000 }).toContain('mock-claude ready');

    const atReopen = await ptySize(win, 'demo');
    const { tab, narrow } = await tabXtermSize(app, win, 'demo', atReopen);
    test.info().annotations.push({ type: 'pty-sizes', description: `firstOpen=${atFirstOpen.cols}x${atFirstOpen.rows} reopen=${atReopen.cols}x${atReopen.rows} narrow=${narrow.cols}x${narrow.rows} tab=${tab.cols}x${tab.rows}` });

    expect(atFirstOpen, 'Claude PTY size at first open vs the tab xterm size').toEqual(tab);
    expect(atReopen, 'Claude PTY size after reopening from + new shell vs the tab xterm size').toEqual(tab);
  } finally {
    await app.close();
    cleanup();
  }
});

test('Claude relaunched from the sidebar into its still-open tab starts at the tab xterm width, not 100 cols', async () => {
  const { app, win, cleanup } = await openDemoProject();
  try {
    // Claude exits; its tab stays mounted (ShellTab prints "[shell exited]")
    // with its fitted size already sent and cached, so it will not resend it.
    await writeToShell(win, 'demo', 'exit\r');
    await expect.poll(() => isAlive(win, 'demo'), { timeout: 10000 }).toBe(false);

    // Reopen the project the normal way — a sidebar click → pick() →
    // shells:launch (the --continue variant, as the project has launched before).
    // After the first open the project is listed under Recents too; click the All entry.
    await win.getByTestId('section-all').getByRole('button', { name: 'demo', exact: true }).click();
    await expect.poll(() => shellOutput(win, 'demo'), { timeout: 10000 }).toContain('mock-claude resumed');

    const atRelaunch = await ptySize(win, 'demo');
    const { tab, narrow } = await tabXtermSize(app, win, 'demo', atRelaunch);
    test.info().annotations.push({ type: 'pty-sizes', description: `relaunch=${atRelaunch.cols}x${atRelaunch.rows} narrow=${narrow.cols}x${narrow.rows} tab=${tab.cols}x${tab.rows}` });

    expect(atRelaunch, 'Claude PTY size at relaunch vs the tab xterm size').toEqual(tab);
  } finally {
    await app.close();
    cleanup();
  }
});
