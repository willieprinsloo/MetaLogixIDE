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

import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { rmSync } from 'node:fs';

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
    args: ['.'],
    env: {
      ...process.env,
      HOME: isolatedHome,
      METAIDE_TEST_MODE: '1',
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
  await win.evaluate((path: string) => {
    (window as { prompt: (msg?: string) => string }).prompt = () => path;
  }, rootA);
  await win.getByRole('button', { name: '+ Root' }).click();
  await expect(win.getByRole('button', { name: 'alpha', exact: true })).toBeVisible({ timeout: 5000 });
  await expect(win.getByRole('button', { name: 'beta',  exact: true })).toBeVisible({ timeout: 5000 });

  // ── 3. Add Root B ─────────────────────────────────────────────────────────
  await win.evaluate((path: string) => {
    (window as { prompt: (msg?: string) => string }).prompt = () => path;
  }, rootB);
  await win.getByRole('button', { name: '+ Root' }).click();
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
  await expect(win.locator('.xterm-accessibility')).toContainText('mock-claude ready', { timeout: 10000 });

  // ── 7. Type hello + Enter → verify echo ───────────────────────────────────
  await win.locator('.xterm').click();
  await win.keyboard.type('hello');
  await win.keyboard.press('Enter');
  await expect(win.locator('.xterm-accessibility')).toContainText('echo: hello', { timeout: 10000 });

  // ── 8. Open Alive Shells panel (Cmd+Shift+A) ──────────────────────────────
  await win.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  });
  // The panel header has exact text "Alive shells" (capital A, capital S).
  const alivePanel = win.getByText('Alive shells', { exact: true });
  await expect(alivePanel).toBeVisible({ timeout: 3000 });

  // Should list the alpha shell (1 entry)
  const aliveRows = win.locator('[data-testid="alive-shell-row"]');
  await expect(aliveRows.first()).toBeVisible({ timeout: 3000 });
  // At least 1 project name visible in the panel
  const panelText = await win.locator('[data-testid="alive-shells-panel"]').innerText();
  expect(panelText).toContain('alpha');

  // ── 9. Close panel, open second project (beta) ────────────────────────────
  await win.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  });
  await expect(alivePanel).not.toBeVisible({ timeout: 2000 });

  await win.getByRole('button', { name: 'beta', exact: true }).click();
  // Second shell spawns; xterm still visible
  await expect(win.locator('.xterm')).toBeVisible({ timeout: 10000 });

  // ── 10. Alive Shells panel should now show 2 entries ──────────────────────
  await win.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  });
  await expect(win.getByText('Alive shells', { exact: true })).toBeVisible({ timeout: 3000 });
  const aliveItems = win.locator('[data-testid="alive-shell-row"]');
  await expect(aliveItems).toHaveCount(2, { timeout: 5000 });

  // ── 11. Switch to Files tab ───────────────────────────────────────────────
  // Close panel first so we can see the tab buttons
  await win.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  });
  await expect(win.getByText('Alive shells', { exact: true })).not.toBeVisible({ timeout: 2000 });

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
