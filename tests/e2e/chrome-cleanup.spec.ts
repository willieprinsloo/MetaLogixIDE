import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PROJECT_SETTINGS_COPY, PROJECT_SETTINGS_TESTIDS } from '../../src/renderer/project-settings-contract';
import { closeApp, guardedLaunch } from './helpers/claude-harness';

/**
 * Chrome cleanup: the frame around the terminal separates panes by tone and
 * spacing instead of borders, the active main tab wears the accent tint, and
 * the chrome tokens resolve in every palette and theme.
 */

let app: ElectronApplication;
let win: Page;
let isolatedHome: string;
let demoRoot: string;

test.beforeAll(async () => {
  await guardedLaunch(async (scope) => {
    const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
    isolatedHome = scope.tempDir('metaide-chrome-home-');
    demoRoot = scope.tempDir('metaide-chrome-root-');
    const proj = join(demoRoot, 'chromed');
    mkdirSync(proj); mkdirSync(join(proj, '.git'));

    app = scope.own(await electron.launch({
      args: ['.', `--user-data-dir=${join(isolatedHome, 'userData')}`],
      env: {
        ...process.env,
        HOME: isolatedHome,
        METAIDE_TEST_MODE: '1',
        METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
        METAIDE_DEFAULT_LAUNCH_FIRST:      JSON.stringify({ argv: ['node', mockClaude],              env: {} }),
        METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: ['node', mockClaude, '--continue'], env: {} }),
      },
    }));
    win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.evaluate(async (path: string) => {
      const api = (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } }).api;
      await api.invoke('roots:add', { path });
    }, demoRoot);
    const row = win.locator('[data-testid="project-row"]', { hasText: 'chromed' }).first();
    await expect(row).toBeVisible({ timeout: 5000 });
    await row.click();
    await expect(win.locator('[data-testid="shell-tab"]')).toBeVisible({ timeout: 5000 });
  });
});

test.afterAll(async () => {
  if (app) await closeApp(app);
  rmSync(isolatedHome, { recursive: true, force: true });
  rmSync(demoRoot, { recursive: true, force: true });
});

/** Sum of the four computed border widths, in px. */
function borderWidth(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return ['Top', 'Right', 'Bottom', 'Left']
      .map((side) => parseFloat(cs.getPropertyValue(`border-${side.toLowerCase()}-width`)) || 0)
      .reduce((a, b) => a + b, 0);
  });
}

test('chrome regions draw no borders', async () => {
  for (const [name, selector] of [
    ['title bar', '.drag'],
    ['activity bar', '[data-testid="activity-bar"]'],
    ['sidebar', 'aside[data-view="projects"]'],
    ['main tab bar', '[data-testid="main-tab-bar"]'],
  ] as const) {
    expect(await borderWidth(win, selector), `${name} border width`).toBe(0);
  }
  // The status bar sits inside the main sheet and keeps a deliberate 1px hairline on its top edge only.
  const status = win.getByTestId('status-bar');
  const sides = await status.evaluate((el) => {
    const cs = getComputedStyle(el);
    return ['top', 'right', 'bottom', 'left'].map((s) => parseFloat(cs.getPropertyValue(`border-${s}-width`)) || 0);
  });
  expect(sides, 'status bar border widths (top, right, bottom, left)').toEqual([1, 0, 0, 0]);
});

test('active main tab wears the accent tint; inactive tabs are clear', async () => {
  const bar = win.getByTestId('main-tab-bar');
  const fill = (name: string) => bar.getByRole('button', { name, exact: true })
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  await expect.poll(() => fill('Shell')).not.toBe('rgba(0, 0, 0, 0)');
  expect(await fill('Files')).toBe('rgba(0, 0, 0, 0)');
  expect(await fill(PROJECT_SETTINGS_COPY.tab)).toBe('rgba(0, 0, 0, 0)');
  const settings = win.getByRole('button', { name: PROJECT_SETTINGS_COPY.tab, exact: true });
  await settings.click();
  await expect(win.getByTestId(PROJECT_SETTINGS_TESTIDS.view)).toBeVisible();
  await expect(win.getByTestId('shell-tab')).toHaveCount(0);
  await expect.poll(() => fill(PROJECT_SETTINGS_COPY.tab)).not.toBe('rgba(0, 0, 0, 0)');
  await expect.poll(() => fill('Shell')).toBe('rgba(0, 0, 0, 0)');
  await bar.getByRole('button', { name: 'Shell', exact: true }).click();
  await expect(win.getByTestId('shell-tab')).toBeVisible();
  await expect.poll(() => fill(PROJECT_SETTINGS_COPY.tab)).toBe('rgba(0, 0, 0, 0)');
});

test('root folders carry a hue glyph', async () => {
  const glyph = win.locator('[data-testid="root-hue"]').first();
  await expect(glyph).toBeVisible();
  const stroke = await glyph.evaluate((el) => getComputedStyle(el).stroke);
  expect(stroke).not.toBe('none');
});

test('chrome tokens resolve in every palette and theme', async () => {
  const tokens = ['--surface-chrome', '--surface-sheet', '--accent-soft', '--hue-yellow', '--hue-purple', '--hue-cyan', '--hue-pink', '--hue-orange', '--hue-orange-soft', '--hue-orange-soft-text', '--badge-accent-text', '--badge-ink', '--surface-raised', '--switch-off'];
  for (const palette of ['default', 'catppuccin', 'rose-pine']) {
    for (const theme of ['dark', 'light']) {
      const resolved = await win.evaluate(({ palette, theme, tokens }) => {
        const root = document.documentElement;
        root.setAttribute('data-palette', palette);
        root.setAttribute('data-theme', theme);
        // Resolve each token through a probe so var() chains are followed.
        const probe = document.createElement('div');
        document.body.appendChild(probe);
        const out: Record<string, string> = {};
        for (const t of tokens) {
          probe.style.color = `var(${t})`;
          out[t] = getComputedStyle(probe).color;
        }
        probe.remove();
        return out;
      }, { palette, theme, tokens });
      for (const t of tokens) {
        expect(resolved[t], `${t} in ${palette}/${theme}`).toMatch(/^(rgb|rgba|color|oklab|oklch)\(/);
      }
    }
  }
});
