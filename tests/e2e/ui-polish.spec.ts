import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('UI polish: sidebar toggle, in-use section, live indicator, popout window', async () => {
  const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
  const isolatedHome = mkdtempSync(join(tmpdir(), 'metaide-polish-home-'));
  const demoRoot     = mkdtempSync(join(tmpdir(), 'metaide-polish-root-'));
  const proj         = join(demoRoot, 'polished');
  mkdirSync(proj); mkdirSync(join(proj, '.git'));

  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      HOME: isolatedHome,
      METAIDE_TEST_MODE: '1',
      METAIDE_DEFAULT_LAUNCH_FIRST:      JSON.stringify({ argv: ['node', mockClaude],              env: {} }),
      METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: ['node', mockClaude, '--continue'],env: {} }),
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  // Add root and pick project
  await win.evaluate((path: string) => { (window as { prompt: (msg?: string) => string }).prompt = () => path; }, demoRoot);
  await win.getByRole('button', { name: '+ Add root' }).click();
  const projRow = win.locator('[data-testid="project-row"]', { hasText: 'polished' }).first();
  await expect(projRow).toBeVisible({ timeout: 5000 });
  await projRow.click();

  // Shell tab renders and mock-claude banner appears
  await expect(win.locator('[data-testid="shell-tab"]')).toBeVisible({ timeout: 5000 });
  await expect(win.locator('.xterm-accessibility')).toContainText('mock-claude ready', { timeout: 8000 });

  // "In use" section appears with the polished project
  const inUseSection = win.locator('[data-testid="section-in-use"]');
  await expect(inUseSection).toBeVisible({ timeout: 5000 });
  await expect(inUseSection.locator('[data-testid="project-row"][data-alive="1"]', { hasText: 'polished' })).toBeVisible();

  // Sidebar toggle hides then shows the sidebar
  await win.getByTestId('toggle-sidebar').click();
  await expect(win.locator('aside')).toHaveCount(0, { timeout: 2000 });
  await win.getByTestId('toggle-sidebar').click();
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
  // The echo will appear in whichever viewport is receiving fresh output —
  // both main and popout attach to the same PTY. Wait for it in the popout.
  await expect(popout.locator('.xterm-accessibility')).toContainText('echo: popout', { timeout: 10000 });

  await app.close();
  rmSync(isolatedHome, { recursive: true, force: true });
  rmSync(demoRoot, { recursive: true, force: true });
});
