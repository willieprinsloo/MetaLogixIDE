import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * A window created after the Window opacity setting changes (a shell
 * popout, or a main window recreated on macOS `activate`) must start at the
 * current opacity, not the opacity that was persisted at boot.
 */
test('popout opened after an opacity change starts at the new opacity', async () => {
  const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
  const isolatedHome = mkdtempSync(join(tmpdir(), 'metaide-opacity-home-'));
  const demoRoot     = mkdtempSync(join(tmpdir(), 'metaide-opacity-root-'));
  const proj         = join(demoRoot, 'translucent');
  mkdirSync(proj); mkdirSync(join(proj, '.git'));

  const app = await electron.launch({
    // Own user-data dir: HOME alone does not isolate Electron's userData
    // (see ui-polish.spec.ts), and the persisted opacity lives there.
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
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await win.evaluate(async (path: string) => {
      const api = (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } }).api;
      await api.invoke('roots:add', { path });
    }, demoRoot);
    const projRow = win.locator('[data-testid="project-row"]', { hasText: 'translucent' }).first();
    await expect(projRow).toBeVisible({ timeout: 5000 });
    await projRow.click();
    await expect(win.locator('[data-testid="shell-tab"]')).toBeVisible({ timeout: 5000 });

    // Positive control: a fresh profile boots fully opaque.
    const allOpacities = () => app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => w.getOpacity()));
    expect(await allOpacities()).toEqual([1]);

    // Change the opacity through the Settings UI.
    await win.getByTestId('settings-open').click();
    await win.getByTestId('window-opacity-slider').fill('50');
    await win.getByTestId('settings-done').click();
    await expect(win.getByTestId('settings-modal')).toHaveCount(0);

    const mainHandle = await app.browserWindow(win);
    await expect.poll(() => mainHandle.evaluate((w) => w.getOpacity()), { timeout: 3000 }).toBeCloseTo(0.5, 2);

    // Pops the shell out, asserts the new window opened (its shell tab
    // renders) and returns its opacity, then closes it so the shell returns.
    const popOutOpacity = async (): Promise<number> => {
      const [popout] = await Promise.all([
        app.waitForEvent('window'),
        win.getByTestId('popout-shell').click(),
      ]);
      await popout.waitForLoadState('domcontentloaded');
      await expect(popout.locator('[data-testid="shell-tab"]')).toBeVisible({ timeout: 8000 });
      const handle = await app.browserWindow(popout);
      const opacity = await handle.evaluate((w) => w.getOpacity());
      await Promise.all([popout.waitForEvent('close'), handle.evaluate((w) => w.close())]);
      await expect.poll(async () => (await allOpacities()).length, { timeout: 5000 }).toBe(1);
      return opacity;
    };

    // Pop the shell out into a new window: it must pick up the new opacity.
    expect(await popOutOpacity()).toBeCloseTo(0.5, 2);

    // A stored value written without touching live windows is only seen by
    // a newly created one: out-of-range values clamp to 30..100, and a
    // missing or non-numeric value falls back to fully opaque.
    const cases: Array<{ stored: unknown; expected: number }> = [
      { stored: 10,   expected: 0.3 },
      { stored: 150,  expected: 1 },
      { stored: null, expected: 1 },
      { stored: '50', expected: 1 },
    ];
    for (const { stored, expected } of cases) {
      await win.evaluate(async (value: unknown) => {
        const api = (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } }).api;
        await api.invoke('settings:set', { key: 'window_opacity', value });
      }, stored);
      expect(await popOutOpacity(), `stored ${JSON.stringify(stored)}`).toBeCloseTo(expected, 2);
    }
  } finally {
    await app.close();
    rmSync(isolatedHome, { recursive: true, force: true });
    rmSync(demoRoot, { recursive: true, force: true });
  }
});
