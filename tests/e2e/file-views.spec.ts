/**
 * End-to-end smoke of the 2026-11-14 file-views work, in the built app:
 *
 *  1. Custom command with NO name + Save checked → derives `echo`, saves a
 *     project profile (the silent-drop regression), and shows it again in
 *     the New Shell menu.
 *  2. A seeded Edit entry in .metaide/activity.jsonl renders as a clickable
 *     target; clicking opens the file in the Files viewer.
 *  3. An .html file renders as a sandboxed metafile:// iframe; Edit shows
 *     source; Preview re-renders.
 */

import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeApp, guardedLaunch } from './helpers/claude-harness';

const PROJECT = 'viewsproj';
const ACTIVITY = JSON.stringify({
  id: 'e1', ts: '2026-11-14T09:00:00.000Z', agent: 'claude', shellIndex: 0,
  kind: 'tool', tool: 'Edit', target: 'index.html', ok: true,
});

/** A long-lived no-op "claude" so the project's auto-launch shell stays alive. */
function idleShim(home: string): string {
  const dir = join(home, 'bin');
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, 'claude');
  writeFileSync(shim, '#!/bin/bash\nwhile true; do sleep 5; done\n');
  chmodSync(shim, 0o755);
  return shim;
}

interface Ide { app: ElectronApplication; win: Page; root: string }

let ide: Ide;

test.beforeAll(async () => {
  void ide;
  const launched = await guardedLaunch(async (scope) => {
    const home = scope.tempDir('views-home-');
    const root = scope.tempDir('views-root-');
    const proj = join(root, PROJECT);
    mkdirSync(join(proj, '.metaide'), { recursive: true });
    writeFileSync(join(proj, 'index.html'),
      '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head>' +
      '<body><p class="marker">views-marker-text</p></body></html>');
    writeFileSync(join(proj, 'styles.css'), '.marker { color: red; }\n');
    writeFileSync(join(proj, '.metaide', 'activity.jsonl'), ACTIVITY + '\n');
    const shim = idleShim(home);
    const app = scope.own(await electron.launch({
      args: ['.', `--user-data-dir=${join(home, 'userData')}`],
      env: {
        ...process.env,
        HOME: home,
        METAIDE_TEST_MODE: '1',
        METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
        METAIDE_DEFAULT_LAUNCH_FIRST: JSON.stringify({ argv: [shim], env: {} }),
        METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: [shim, '--continue'], env: {} }),
      },
    }));
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1400, 900); });
    await win.evaluate(async (path: string) => {
      await (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } })
        .api.invoke('roots:add', { path });
    }, root);
    const projectButton = win.getByRole('button', { name: PROJECT, exact: true });
    await expect(projectButton).toBeVisible({ timeout: 10_000 });
    await projectButton.click();
    return { app, win, root } satisfies Ide;
  });
  ide = launched;
});

test.afterAll(async () => { if (ide) await closeApp(ide.app); });

/** Invokes an IPC channel in the app for assertions the DOM can't make. */
async function invoke<T>(win: Page, channel: string, payload: unknown): Promise<T> {
  return win.evaluate(async ({ channel, payload }) => {
    return (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } })
      .api.invoke(channel, payload) as Promise<T>;
  }, { channel, payload });
}

test('custom command with no name is saved under a derived profile name', async () => {
  const { win } = ide;
  await win.getByTestId('tabbar-new-shell').click();
  await win.getByText('Add a custom command…').click();
  await win.getByPlaceholder(/Command, e\.g\. `llama chat/).fill('echo hello-views');
  // Name stays blank — the auto-name path under test.
  await win.getByRole('button', { name: 'Run', exact: true }).click();

  // The profile persisted with a derived name (main-process truth).
  const { profiles } = await invoke<{ profiles: Array<{ name: string; argv: string[]; scope: string }> }>(
    win, 'shells:cli-profiles-list', { projectId: await currentProjectId(win) },
  );
  const saved = profiles.find((p) => p.name === 'echo');
  expect(saved, JSON.stringify(profiles)).toBeTruthy();
  expect(saved!.argv).toEqual(['echo', 'hello-views']);
  expect(saved!.scope).toBe('project');

  // …and the menu shows it again, badged saved. Wait for the exit
  // animation to finish first — AnimatePresence re-promotes a still-exiting
  // child (same key), which would restore the custom-command form instead
  // of mounting a fresh profile list.
  const menu = win.locator('[data-new-shell-menu="1"]');
  await expect(menu).toHaveCount(0, { timeout: 10_000 });
  await win.getByTestId('tabbar-new-shell').click();
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await expect(menu.getByRole('button', { name: /^echo/ })).toBeVisible({ timeout: 10_000 });
  await expect(menu.getByText('saved', { exact: true })).toBeVisible();
  await win.keyboard.press('Escape');
});

async function currentProjectId(win: Page): Promise<number> {
  const { projects } = await invoke<{ projects: Array<{ id: number; name: string }> }>(
    win, 'projects:list', {},
  );
  const hit = projects.find((p) => p.name === PROJECT);
  expect(hit).toBeTruthy();
  return hit!.id;
}

test('clicking an Edit target in the Activity tab opens the file in the viewer', async () => {
  const { win } = ide;
  await win.getByRole('button', { name: 'Activity', exact: true }).click();
  const row = win.locator('[data-testid="activity-tab"] button', { hasText: 'index.html' });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();

  // App switched to the Files tab and opened the file.
  await expect(win.getByTestId('file-preview')).toBeVisible({ timeout: 10_000 });
  await expect(win.getByTestId('html-preview')).toBeVisible();
});

test('html renders in a sandboxed metafile iframe; Edit shows source; Preview re-renders', async () => {
  const { win } = ide;
  await win.getByRole('button', { name: 'Files', exact: true }).click();
  const entry = win.getByTestId('file-entry').filter({ hasText: 'index.html' });
  await expect(entry).toBeVisible({ timeout: 10_000 });
  await entry.click();

  const frameBox = win.getByTestId('html-preview');
  await expect(frameBox).toBeVisible({ timeout: 10_000 });
  const iframe = frameBox.locator('iframe');
  await expect(iframe).toHaveAttribute('sandbox', '');
  const src = await iframe.getAttribute('src');
  expect(src).toMatch(/^metafile:\/\/p\/\d+\/index\.html$/);



  // The protocol actually served the page (and its relative asset resolved
  // the same way) — the frame's document contains our marker text.
  const markerFrame = () => win.frames().find((f) => f.url().startsWith('metafile://'));
  await expect(async () => {
    expect(markerFrame()).toBeTruthy();
    await expect(markerFrame()!.getByText('views-marker-text')).toBeVisible();
  }).toPass({ timeout: 10_000 });

  // Edit → source view (no iframe); Preview → back to rendered.
  await win.getByTestId('file-edit-toggle').click();
  await expect(win.getByTestId('file-edit-toggle')).toHaveText('Preview');
  await expect(frameBox).toHaveCount(0);
  await expect(win.getByTestId('file-preview')).toBeVisible();
  await win.getByTestId('file-edit-toggle').click();
  await expect(frameBox).toBeVisible({ timeout: 10_000 });
});
