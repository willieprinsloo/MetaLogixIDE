import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Reads the shell's terminal state via `shells:snapshot` (main's headless
 * xterm, serialized: screen plus scrollback, with SGR and cursor moves —
 * not raw PTY bytes) for the given project's primary (shellIndex 0)
 * shell. xterm renders via the WebGL
 * addon (ShellTab.tsx) with screenReaderMode intentionally off (see
 * b169fd8), so there is no DOM text to assert against — `shells:snapshot`
 * is the only way to read terminal output from the outside. The popout
 * window shares the same backend PTY, so this can be called against
 * either Electron window.
 */
async function shellOutput(win: Page, projectName: string): Promise<string> {
  return win.evaluate(async (name: string) => {
    const api = (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<never> } }).api;
    const { shells } = (await api.invoke('shells:alive-list', undefined)) as { shells: Array<{ projectId: number; projectName: string; shellIndex: number }> };
    const shell = shells.find((s) => s.projectName === name && s.shellIndex === 0);
    if (!shell) return '';
    const snap = (await api.invoke('shells:snapshot', { projectId: shell.projectId, shellIndex: shell.shellIndex })) as { output: string };
    return snap.output;
  }, projectName);
}

test('UI polish: sidebar toggle, in-use section, live indicator, popout window', async () => {
  const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
  const isolatedHome = mkdtempSync(join(tmpdir(), 'metaide-polish-home-'));
  const demoRoot     = mkdtempSync(join(tmpdir(), 'metaide-polish-root-'));
  const proj         = join(demoRoot, 'polished');
  mkdirSync(proj); mkdirSync(join(proj, '.git'));

  const app = await electron.launch({
    // Own user-data dir: Electron's default userData path is not reliably
    // isolated by HOME alone (see root-removal.spec.ts), so persisted
    // renderer state (localStorage — e.g. the mainTab toggle) and the
    // single-instance lock can leak across launches without this.
    args: ['.', `--user-data-dir=${join(isolatedHome, 'userData')}`],
    env: {
      ...process.env,
      HOME: isolatedHome,
      METAIDE_TEST_MODE: '1',
      METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
      METAIDE_DEFAULT_LAUNCH_FIRST:      JSON.stringify({ argv: ['node', mockClaude],              env: {} }),
      METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: ['node', mockClaude, '--continue'],env: {} }),
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  // Add root via IPC directly. `dialogs:pick-directory` always resolves
  // `{ path: null }` under METAIDE_TEST_MODE=1 (register.ts), so clicking
  // "+ Root" is a no-op there; `roots:add` broadcasts `projects:changed`,
  // which useRoots listens for, so the sidebar picks it up without a reload.
  await win.evaluate(async (path: string) => {
    const api = (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } }).api;
    await api.invoke('roots:add', { path });
  }, demoRoot);
  const projRow = win.locator('[data-testid="project-row"]', { hasText: 'polished' }).first();
  await expect(projRow).toBeVisible({ timeout: 5000 });
  await projRow.click();

  // Shell tab renders and mock-claude banner appears
  await expect(win.locator('[data-testid="shell-tab"]')).toBeVisible({ timeout: 5000 });
  await expect.poll(() => shellOutput(win, 'polished'), { timeout: 8000 }).toContain('mock-claude ready');

  // "In use" section appears with the polished project
  const inUseSection = win.locator('[data-testid="section-in-use"]');
  await expect(inUseSection).toBeVisible({ timeout: 5000 });
  await expect(inUseSection.locator('[data-testid="project-row"][data-alive="1"]', { hasText: 'polished' })).toBeVisible();

  // Sidebar toggle hides then shows the sidebar
  await win.getByTestId('ab-toggle-sidebar').click();
  await expect(win.locator('aside')).toHaveCount(0, { timeout: 2000 });
  await win.getByTestId('ab-toggle-sidebar').click();
  await expect(win.locator('aside')).toBeVisible({ timeout: 2000 });

  // Popout the shell into a new window
  const [popout] = await Promise.all([
    app.waitForEvent('window'),
    win.getByTestId('popout-shell').click(),
  ]);
  await popout.waitForLoadState('domcontentloaded');
  await expect(popout.locator('[data-testid="shell-tab"]')).toBeVisible({ timeout: 8000 });
  await expect(popout.locator('.xterm')).toBeVisible({ timeout: 8000 });
  // Type into the popout terminal — the PTY is shared, so this echoes back.
  await popout.locator('.xterm').click();
  await popout.keyboard.type('popout');
  await popout.keyboard.press('Enter');
  // Both main and popout attach to the same PTY — read the shared scrollback.
  await expect.poll(() => shellOutput(win, 'polished'), { timeout: 10000 }).toContain('echo: popout');

  // Theme toggle: single-click flip between light and dark. Set explicit
  // light first so the first click has a deterministic result.
  const themeBtn = win.getByTestId('theme-toggle');
  await win.evaluate(() => {
    localStorage.setItem('metaide.theme.v2', 'light');
    document.documentElement.setAttribute('data-theme', 'light');
  });
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await expect(win.locator('html')).toHaveAttribute('data-theme', 'light', { timeout: 2000 });
  await themeBtn.click(); // light → dark
  await expect(win.locator('html')).toHaveAttribute('data-theme', 'dark', { timeout: 2000 });
  await themeBtn.click(); // dark → light
  await expect(win.locator('html')).toHaveAttribute('data-theme', 'light', { timeout: 2000 });

  await app.close();
  rmSync(isolatedHome, { recursive: true, force: true });
  rmSync(demoRoot, { recursive: true, force: true });
});
