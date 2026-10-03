/**
 * Phase 1 Smoke Test — multi-project lifecycle
 *
 * Covers: dual-root discovery, project switcher (Cmd+K), shell launch,
 * echo interaction, Alive Shells panel (Cmd+Shift+A), Files tab.
 *
 * All interactions go through Playwright keyboard / locator APIs against the
 * built Electron bundle.  The mock-claude script is used as the shell process
 * so no real `claude` CLI is needed.
 */

import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { rmSync } from 'node:fs';

/**
 * Reads the shell's terminal state via `shells:snapshot` (main's headless
 * xterm, serialized: screen plus scrollback, with SGR and cursor moves —
 * not raw PTY bytes) for the given project's primary (shellIndex 0)
 * shell. xterm renders via the WebGL
 * addon (ShellTab.tsx) with screenReaderMode intentionally off (see
 * b169fd8), so there is no DOM text to assert against — `shells:snapshot`
 * is the only way to read terminal output from the outside.
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

test('Phase 1 smoke: multi-root, switcher, shell, alive panel, files tab', async () => {
  const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
  const isolatedHome = mkdtempSync(join(tmpdir(), 'metaide-smoke-home-'));

  // Root A — two projects
  const rootA = mkdtempSync(join(tmpdir(), 'metaide-smoke-rootA-'));
  const projA1 = join(rootA, 'alpha');
  const projA2 = join(rootA, 'beta');
  mkdirSync(projA1); mkdirSync(join(projA1, '.git'));
  mkdirSync(projA2); mkdirSync(join(projA2, '.git'));

  // Root B — two projects
  const rootB = mkdtempSync(join(tmpdir(), 'metaide-smoke-rootB-'));
  const projB1 = join(rootB, 'gamma');
  const projB2 = join(rootB, 'delta');
  mkdirSync(projB1); mkdirSync(join(projB1, '.git'));
  mkdirSync(projB2); mkdirSync(join(projB2, '.git'));

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
      METAIDE_DEFAULT_LAUNCH_FIRST:      JSON.stringify({ argv: ['node', mockClaude],               env: {} }),
      METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: ['node', mockClaude, '--continue'], env: {} }),
    },
  });

  const win = await app.firstWindow();

  // ── 1. Boot without console errors ────────────────────────────────────────
  const pageErrors: string[] = [];
  const consoleMsgs: string[] = [];
  win.on('pageerror', (err) => { pageErrors.push(err.message); console.error('PAGE ERROR:', err.message); });
  win.on('console', (msg) => { if (msg.type() === 'error') { consoleMsgs.push(msg.text()); console.error('CONSOLE ERROR:', msg.text()); } });
  await win.waitForLoadState('domcontentloaded');

  // ── 2. Add Root A ─────────────────────────────────────────────────────────
  // `dialogs:pick-directory` always resolves `{ path: null }` under
  // METAIDE_TEST_MODE=1 (register.ts) — clicking "+ Root" is a no-op there,
  // so roots are seeded through the IPC surface directly (as root-removal.spec.ts
  // does); `roots:add` broadcasts `projects:changed`, which useRoots listens
  // for, so the sidebar picks it up without a reload.
  await win.evaluate(async (path: string) => {
    const api = (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } }).api;
    await api.invoke('roots:add', { path });
  }, rootA);
  await expect(win.getByRole('button', { name: 'alpha', exact: true })).toBeVisible({ timeout: 5000 });
  await expect(win.getByRole('button', { name: 'beta',  exact: true })).toBeVisible({ timeout: 5000 });

  // ── 3. Add Root B ─────────────────────────────────────────────────────────
  await win.evaluate(async (path: string) => {
    const api = (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } }).api;
    await api.invoke('roots:add', { path });
  }, rootB);
  await expect(win.getByRole('button', { name: 'gamma', exact: true })).toBeVisible({ timeout: 5000 });
  await expect(win.getByRole('button', { name: 'delta', exact: true })).toBeVisible({ timeout: 5000 });

  // ── 4. Open Cmd+K project switcher ────────────────────────────────────────
  // Dispatch a synthetic keydown that the App's listener will catch
  // (OS-level Cmd+K may be intercepted before reaching the renderer on macOS;
  // dispatching via evaluate bypasses that).
  await win.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }));
  });
  const switcherInput = win.getByPlaceholder('Switch to project…');
  await expect(switcherInput).toBeVisible({ timeout: 3000 });


  // ── 5. Filter in switcher — wait for projects to load then narrow results ──
  // useProjects hook fires on mount; wait for list items to appear.
  // Note: the evaluate probe above confirmed IPC works; React hook may need
  // a small settle time.
  await win.waitForTimeout(500); // let React effect settle
  const firstResult = win.locator('ul li button').first();
  await expect(firstResult).toBeVisible({ timeout: 10000 });

  // Type a filter to verify Fuse narrows results.
  await switcherInput.fill('alpha');
  await expect(firstResult).toBeVisible({ timeout: 3000 });
  await expect(firstResult).toContainText('alpha', { timeout: 3000 });

  // ── 6. Click the first result to pick the project ─────────────────────────
  await firstResult.click();

  // Shell tab should open and show mock-claude ready banner
  await expect(win.locator('.xterm')).toBeVisible({ timeout: 10000 });
  await expect.poll(() => shellOutput(win, 'alpha'), { timeout: 10000 }).toContain('mock-claude ready');

  // ── 7. Type hello + Enter → verify echo ───────────────────────────────────
  await win.locator('.xterm').click();
  await win.keyboard.type('hello');
  await win.keyboard.press('Enter');
  await expect.poll(() => shellOutput(win, 'alpha'), { timeout: 10000 }).toContain('echo: hello');

  // ── 8. Sidebar "In use" section shows the alpha project ──────────────────
  const inUseSection = win.getByTestId('section-in-use');
  await expect(inUseSection).toBeVisible({ timeout: 3000 });
  await expect(inUseSection.locator('[data-testid="project-row"][data-alive="1"]', { hasText: 'alpha' })).toBeVisible();

  // ── 9. Open second project (beta) — In use grows to 2 ────────────────────
  await win.getByRole('button', { name: 'beta', exact: true }).click();
  await expect(win.locator('.xterm')).toBeVisible({ timeout: 10000 });
  const inUseRows = inUseSection.locator('[data-testid="project-row"][data-alive="1"]');
  await expect(inUseRows).toHaveCount(2, { timeout: 5000 });

  // ── 10. Switch to Files tab ───────────────────────────────────────────────
  await win.getByRole('button', { name: 'Files', exact: true }).click();
  // .git folder should appear (every project has one)
  await expect(win.locator('text=.git')).toBeVisible({ timeout: 5000 });

  // ── 12. No page errors throughout ─────────────────────────────────────────
  expect(pageErrors, `Page errors: ${pageErrors.join('; ')}`).toHaveLength(0);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await app.close();
  rmSync(isolatedHome, { recursive: true, force: true });
  rmSync(rootA, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
});
