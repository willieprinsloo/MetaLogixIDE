import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { rmSync } from 'node:fs';

test('full lifecycle: add root → discover → launch shell → echo', async () => {
  const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
  const isolatedHome = mkdtempSync(join(tmpdir(), 'metaide-home-'));
  const demoRoot     = mkdtempSync(join(tmpdir(), 'metaide-demo-'));
  const proj         = join(demoRoot, 'demo');
  mkdirSync(proj); mkdirSync(join(proj, '.git'));

  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      HOME: isolatedHome,               // isolate SQLite path
      METAIDE_DEFAULT_LAUNCH_FIRST:      JSON.stringify({ argv: ['node', mockClaude],              env: {} }),
      METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: ['node', mockClaude, '--continue'],env: {} }),
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  // Add root — the prompt() dialog is intercepted.
  await win.evaluate((path: string) => { (window as any).prompt = () => path; }, demoRoot);
  await win.getByRole('button', { name: '+ Add root' }).click();

  // Wait for demo to appear (exact match avoids matching the root path button).
  await expect(win.getByRole('button', { name: 'demo', exact: true })).toBeVisible({ timeout: 5000 });

  // Click project → launches shell.
  await win.getByRole('button', { name: 'demo', exact: true }).click();

  // xterm renders text into canvas / DOM. The banner text is written to
  // hidden accessibility layer (`.xterm-accessibility` div).
  await expect(win.locator('.xterm')).toBeVisible({ timeout: 10000 });

  // Type "hello" then Enter — xterm captures via focused terminal.
  await win.locator('.xterm').click();
  await win.keyboard.type('hello');
  await win.keyboard.press('Enter');

  // Assert echo appears in the accessibility text (xterm mirrors output there).
  await expect(win.locator('.xterm-accessibility')).toContainText('echo: hello', { timeout: 10000 });

  await app.close();
  rmSync(isolatedHome, { recursive: true, force: true });
  rmSync(demoRoot, { recursive: true, force: true });
});
