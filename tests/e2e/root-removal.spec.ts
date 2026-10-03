import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('removing a root in Settings drops it from the sidebar "All projects" list', async () => {
  const isolatedHome = mkdtempSync(join(tmpdir(), 'metaide-rootrm-home-'));
  const keptRoot     = mkdtempSync(join(tmpdir(), 'metaide-rootrm-kept-'));
  const goneRoot     = mkdtempSync(join(tmpdir(), 'metaide-rootrm-gone-'));
  for (const [root, name] of [[keptRoot, 'kept-proj'], [goneRoot, 'gone-proj']] as const) {
    mkdirSync(join(root, name)); mkdirSync(join(root, name, '.git'));
  }

  const app = await electron.launch({
    // Own user-data dir: the single-instance lock is keyed on it, so a
    // running dev copy of the app would otherwise make this launch quit.
    args: ['.', `--user-data-dir=${join(isolatedHome, 'userData')}`],
    env: { ...process.env, HOME: isolatedHome, METAIDE_TEST_MODE: '1', METAIDE_CLAUDE_PERMISSION_MODE: 'bypass' },
  });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // Seed both roots through the IPC surface, then reload so every hook
    // mounts against the seeded state — the bug under test is in what
    // happens *after* mount.
    await win.evaluate(async (paths: string[]) => {
      const api = (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } }).api;
      for (const path of paths) await api.invoke('roots:add', { path });
    }, [keptRoot, goneRoot]);
    await win.reload();
    await win.waitForLoadState('domcontentloaded');

    const allSection = win.getByTestId('section-all');
    await expect(allSection.locator(`[title="${keptRoot}"]`)).toBeVisible({ timeout: 5000 });
    await expect(allSection.locator(`[title="${goneRoot}"]`)).toBeVisible();

    win.on('dialog', (d) => { void d.accept(); });
    await win.getByTestId('settings-open').click();
    const modal = win.getByTestId('settings-modal');
    await modal.getByRole('button', { name: 'Root directories' }).click();
    const goneRow = modal.locator('li', { has: win.locator(`[title="${goneRoot}"]`) });
    await goneRow.getByRole('button', { name: 'Remove' }).click();
    await expect(goneRow).toHaveCount(0);
    await win.getByTestId('settings-done').click();

    // Positive control: the sidebar list still renders the surviving root.
    await expect(allSection.locator(`[title="${keptRoot}"]`)).toBeVisible();
    await expect(allSection.locator(`[title="${goneRoot}"]`)).toHaveCount(0, { timeout: 5000 });
  } finally {
    await app.close();
    for (const dir of [isolatedHome, keptRoot, goneRoot]) rmSync(dir, { recursive: true, force: true });
  }
});
