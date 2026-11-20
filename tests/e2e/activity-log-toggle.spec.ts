/**
 * Activity log on/off setting (`activity_log_enabled`), end to end.
 *
 * Spec: docs/specs/activity-log-toggle.md (AC2-AC4, AC8-AC12, AC15-AC17).
 * Plan: docs/plan/activity-log-toggle.md §8 "Agent 2".
 *
 * Home considered: this file lives in the real-Electron suite and drives the
 * real main process: real hook receiver (hooks are POSTed with the shell's
 * real credentials via `postRawHook`), real settings repo, real
 * `.metaide/activity.jsonl` on disk. Unlike a stubbed harness it can observe
 * both the file and the `activity:changed` broadcast, so every negative below
 * could fail on a regression.
 *
 * The strings below (key, test ids, copy) are literals on purpose, mirroring
 * `src/renderer/activity-log-contract.ts` without importing it, so a drift in
 * the contract fails here instead of passing silently.
 *
 * AC3 (full hook-kind matrix) and AC4 are unit-covered too; here they run
 * over the wire. AC5/AC6/AC13/AC14 are covered by Agent 1's unit tests.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  baseEnv, closeApp, guardedLaunch, hookCredentials, installNotificationSpy, makeClaudeShim,
  notifications, openProject, postRawHook, projectId, waitForShell, type Api,
} from './helpers/claude-harness';

const KEY = 'activity_log_enabled';
const TOGGLE = 'activity-log-toggle';
const TAB_BUTTON = 'activity-tab-button';
const LABEL = 'Record agent activity';
const HINT = 'Off stops writing .metaide/activity.jsonl in your projects and hides the Activity tab. Existing logs are kept.';

const SEED_ENTRY = JSON.stringify({
  id: 'seed1', ts: '2026-11-14T09:00:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Edit', target: 'seed.txt', ok: true,
});

interface Ide { app: ElectronApplication; win: Page; home: string; root: string }

/**
 * Launches the app against an existing home/root so a second launch sees the
 * first one's settings DB and localStorage. `claude` shim (mock-claude) is the
 * default launch, like the notification suite.
 */
async function launchIde(home: string, root: string, firstLaunch: boolean): Promise<Ide> {
  return guardedLaunch(async (scope) => {
    const shim = makeClaudeShim(home);
    const app = scope.own(await electron.launch({
      args: ['.', `--user-data-dir=${join(home, 'userData')}`],
      env: {
        ...baseEnv(),
        HOME: home,
        ...(process.platform === 'win32' ? { USERPROFILE: home } : { SHELL: '/bin/bash' }),
        PATH: `${join(home, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
        METAIDE_TEST_MODE: '1',
        METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
        METAIDE_DEFAULT_LAUNCH_FIRST: JSON.stringify({ argv: [shim], env: {} }),
        METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: [shim, '--continue'], env: {} }),
      },
    }));
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1400, 900); });
    if (firstLaunch) {
      await win.evaluate(async (path: string) => {
        await (window as unknown as { api: Api }).api.invoke('roots:add', { path });
      }, root);
    }
    return { app, win, home, root };
  });
}

/** Fresh home + root with the named projects (each a `.git` dir so it is discovered). `seeded` get an existing activity log. */
function makeWorld(projects: string[], seeded: string[] = []): { home: string; root: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'metaide-alog-home-'));
  const root = mkdtempSync(join(tmpdir(), 'metaide-alog-root-'));
  for (const name of projects) {
    const proj = join(root, name);
    mkdirSync(join(proj, '.git'), { recursive: true });
    writeFileSync(join(proj, 'notes.txt'), 'notes\n');
    if (seeded.includes(name)) {
      mkdirSync(join(proj, '.metaide'));
      writeFileSync(join(proj, '.metaide', 'activity.jsonl'), SEED_ENTRY + '\n');
    }
  }
  return { home, root, cleanup: () => { rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); } };
}

async function setSetting(win: Page, value: boolean): Promise<void> {
  await win.evaluate(async (v: boolean) => {
    await (window as unknown as { api: Api }).api.invoke('settings:set', { key: 'activity_log_enabled', value: v });
  }, value);
}

async function getSetting(win: Page): Promise<unknown> {
  return win.evaluate(async () => {
    const r = await (window as unknown as { api: Api }).api.invoke('settings:get', { key: 'activity_log_enabled' }) as unknown as { value: unknown };
    return r.value;
  });
}

const storedMainTab = (win: Page): Promise<string | null> => win.evaluate(() => localStorage.getItem('metaide.mainTab'));

/** Counts `activity:changed` events delivered to this window from now on. */
async function countActivityEvents(win: Page): Promise<() => Promise<number>> {
  await win.evaluate(() => {
    const w = window as unknown as { __activityEvents?: number; api: { on: (c: string, cb: () => void) => () => void } };
    w.__activityEvents = 0;
    w.api.on('activity:changed', () => { w.__activityEvents = (w.__activityEvents ?? 0) + 1; });
  });
  return () => win.evaluate(() => (window as unknown as { __activityEvents?: number }).__activityEvents ?? 0);
}

async function openSettingsGeneral(win: Page): Promise<void> {
  await win.getByTestId('settings-open').click();
  const dialog = win.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'General', exact: true }).click();
  await expect(dialog.getByRole('region', { name: 'Workspace' })).toBeVisible();
}

async function closeSettings(win: Page): Promise<void> {
  await win.getByTestId('settings-done').click();
  await expect(win.getByTestId('settings-modal')).toBeHidden();
}

const shellTabButton = (win: Page) => win.getByRole('button', { name: 'Shell', exact: true });

const pre = (file = 'notes.txt'): Record<string, unknown> => ({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file } });
const post = (file = 'notes.txt'): Record<string, unknown> => ({
  hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: file }, tool_response: { success: true },
});

test.describe('activity log on/off setting', () => {
  test('AC2/AC8: switch is on by default with the exact copy, saves through settings:set, survives relaunch, and shows/hides the Activity tab button', async () => {
    const world = makeWorld(['proja']);
    let ide: Ide | undefined;
    try {
      ide = await launchIde(world.home, world.root, true);
      let { win } = ide;
      await openProject(win, 'proja');

      // Default on: stored value true (AC1), tab button shown next to the Shell tab (AC8 on).
      expect(await getSetting(win), 'default is on').toBe(true);
      await expect(shellTabButton(win), 'positive control: tab bar rendered').toBeVisible();
      await expect(win.getByTestId(TAB_BUTTON)).toBeVisible();

      await openSettingsGeneral(win);
      const workspace = win.getByRole('dialog', { name: 'Settings' }).getByRole('region', { name: 'Workspace' });
      const sw = workspace.getByTestId(TOGGLE);
      await expect(sw).toHaveRole('switch');
      await expect(sw).toBeChecked();
      await expect(sw).toHaveAccessibleName(LABEL);
      await expect(workspace.getByText(LABEL, { exact: true })).toHaveCount(1);
      await expect(workspace.getByText(HINT, { exact: true })).toHaveCount(1);

      // Toggle off via the label (saves through settings:set).
      await workspace.getByText(LABEL, { exact: true }).click();
      await expect(sw).not.toBeChecked();
      await expect.poll(() => getSetting(win)).toBe(false);
      await closeSettings(win);
      await expect(win.getByTestId(TAB_BUTTON), 'AC8 off: no Activity tab button').toHaveCount(0);
      await expect(shellTabButton(win), 'positive control: tab bar still rendered').toBeVisible();

      // Survives a relaunch: stored false, switch off, button still gone.
      await closeApp(ide.app);
      ide = await launchIde(world.home, world.root, false);
      win = ide.win;
      await openProject(win, 'proja');
      expect(await getSetting(win)).toBe(false);
      await expect(shellTabButton(win), 'positive control: tab bar rendered after relaunch').toBeVisible();
      await expect(win.getByTestId(TAB_BUTTON)).toHaveCount(0);
      await openSettingsGeneral(win);
      const sw2 = win.getByRole('dialog', { name: 'Settings' }).getByTestId(TOGGLE);
      await expect(sw2, 'switch reflects the stored value').not.toBeChecked();

      // Back on with the switch itself: button returns without a reload.
      await sw2.click();
      await expect(sw2).toBeChecked();
      await expect.poll(() => getSetting(win)).toBe(true);
      await closeSettings(win);
      await expect(win.getByTestId(TAB_BUTTON)).toBeVisible();
    } finally {
      if (ide) await closeApp(ide.app);
      world.cleanup();
    }
  });

  test('AC9: turning it off while the Activity tab is active moves the view to Shell and rewrites metaide.mainTab', async () => {
    const world = makeWorld(['proja']);
    let ide: Ide | undefined;
    try {
      ide = await launchIde(world.home, world.root, true);
      const { win } = ide;
      await openProject(win, 'proja');
      await win.getByTestId(TAB_BUTTON).click();
      await expect(win.getByTestId('activity-tab')).toBeVisible();
      await expect.poll(() => storedMainTab(win)).toBe('"activity"');

      await setSetting(win, false);

      await expect(win.getByTestId('activity-tab')).toHaveCount(0);
      await expect(win.getByTestId('shell-tab').first(), 'positive control: Shell view is showing').toBeVisible();
      await expect(shellTabButton(win)).toHaveAttribute('aria-current', 'page');
      await expect(win.getByTestId(TAB_BUTTON)).toHaveCount(0);
      await expect.poll(() => storedMainTab(win)).toBe('"shell"');
    } finally {
      if (ide) await closeApp(ide.app);
      world.cleanup();
    }
  });

  test('AC10: relaunch with it off and a saved main tab of activity opens on Shell and rewrites the stored value', async () => {
    const world = makeWorld(['proja']);
    let ide: Ide | undefined;
    try {
      ide = await launchIde(world.home, world.root, true);
      await openProject(ide.win, 'proja');
      // Off first (nothing to fall back from: the view is on Shell), then plant the stale tab
      // directly in storage, as a previous session that ended on Activity would have left it.
      await setSetting(ide.win, false);
      await expect.poll(() => getSetting(ide!.win)).toBe(false);
      await ide.win.evaluate(() => localStorage.setItem('metaide.mainTab', '"activity"'));
      expect(await storedMainTab(ide.win), 'positive control: the stale tab is planted').toBe('"activity"');
      await closeApp(ide.app);

      ide = await launchIde(world.home, world.root, false);
      const { win } = ide;
      await openProject(win, 'proja');
      expect(await getSetting(win)).toBe(false);
      await expect(win.getByTestId('shell-tab').first(), 'positive control: Shell view is showing').toBeVisible();
      await expect(win.getByTestId('activity-tab')).toHaveCount(0);
      await expect(win.getByTestId(TAB_BUTTON)).toHaveCount(0);
      await expect.poll(() => storedMainTab(win)).toBe('"shell"');
    } finally {
      if (ide) await closeApp(ide.app);
      world.cleanup();
    }
  });

  test('AC3/AC4/AC11/AC16/AC17: off writes nothing and broadcasts nothing but still notifies; existing log untouched and still listed; on appends without back-fill', async () => {
    const world = makeWorld(['proja', 'projb'], ['projb']);
    let ide: Ide | undefined;
    try {
      ide = await launchIde(world.home, world.root, true);
      const { app, win } = ide;
      await installNotificationSpy(app);
      await openProject(win, 'proja');
      const idA = await projectId(win, 'proja');
      await waitForShell(win, idA, 0, 'mock-claude ready');
      const credsA = await hookCredentials(win, world.home, idA, 0);
      await openProject(win, 'projb');
      const idB = await projectId(win, 'projb');
      await waitForShell(win, idB, 0, 'mock-claude ready');
      const credsB = await hookCredentials(win, world.home, idB, 0);

      const logA = join(world.root, 'proja', '.metaide', 'activity.jsonl');
      const logB = join(world.root, 'projb', '.metaide', 'activity.jsonl');
      const seededBytes = readFileSync(logB);
      const seededStat = statSync(logB);
      const events = await countActivityEvents(win);

      // Leave the Shell view so the needs-input notification is not suppressed as "viewed".
      await win.getByRole('button', { name: 'Files', exact: true }).click();
      await expect(win.getByRole('button', { name: 'Files', exact: true })).toHaveAttribute('aria-current', 'page');
      await win.waitForTimeout(500); // viewed-shell report is async over IPC

      await setSetting(win, false);
      await expect.poll(() => getSetting(win)).toBe(false);

      const offStream = (marker: string): Array<Record<string, unknown>> => [
        { hook_event_name: 'UserPromptSubmit', message: `${marker} prompt` },
        pre(),
        post(),
        { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: `${marker} needs input` },
        { hook_event_name: 'Stop' },
      ];
      for (const body of offStream('OFF-A')) expect((await postRawHook(credsA, body)).status).toBe(204);
      for (const body of offStream('OFF-B')) expect((await postRawHook(credsB, body)).status).toBe(204);

      // Positive control that hooks were really received and processed while off: notifications still fire.
      await expect.poll(async () => (await notifications(app)).some((n) => n.body.includes('OFF-A needs input')), { timeout: 8000 }).toBe(true);
      await win.waitForTimeout(500);

      // AC3: no .metaide created for the project without one; the seeded log is byte- and mtime-identical.
      expect(existsSync(join(world.root, 'proja', '.metaide')), 'no .metaide dir created').toBe(false);
      expect(existsSync(logA)).toBe(false);
      expect(readFileSync(logB).equals(seededBytes), 'seeded log bytes unchanged').toBe(true);
      expect(statSync(logB).size).toBe(seededStat.size);
      expect(statSync(logB).mtimeMs).toBe(seededStat.mtimeMs);
      // AC4: nothing broadcast to the renderer.
      expect(await events(), 'no activity:changed while off').toBe(0);
      // AC17: the existing log is still listed while off.
      const listed = await win.evaluate(async (projectId: number) => {
        const r = await (window as unknown as { api: Api }).api.invoke('activity:list', { projectId }) as unknown as { entries: Array<{ id: string }> };
        return r.entries.map((e) => e.id);
      }, idB);
      expect(listed, 'activity:list still reads the existing log while off').toEqual(['seed1']);

      // AC16: back on. The next hook appends (no back-fill) and broadcasts once.
      await setSetting(win, true);
      await expect.poll(() => getSetting(win)).toBe(true);
      expect((await postRawHook(credsA, pre('on-a.txt'))).status).toBe(204);
      expect((await postRawHook(credsB, pre('on-b.txt'))).status).toBe(204);
      await expect.poll(events, { timeout: 8000 }).toBe(2);
      await expect.poll(() => existsSync(logA)).toBe(true);

      const linesA = readFileSync(logA, 'utf8').trim().split('\n');
      expect(linesA, 'A: exactly the one on-period entry').toHaveLength(1);
      expect(JSON.parse(linesA[0]!)).toMatchObject({ kind: 'tool', tool: 'Edit', target: 'on-a.txt' });
      const afterB = readFileSync(logB);
      expect(afterB.subarray(0, seededBytes.length).equals(seededBytes), 'AC11: old content preserved byte for byte').toBe(true);
      const newB = afterB.subarray(seededBytes.length).toString('utf8').trim().split('\n');
      expect(newB, 'B: exactly one new line').toHaveLength(1);
      expect(JSON.parse(newB[0]!)).toMatchObject({ target: 'on-b.txt' });
      expect(readFileSync(logA, 'utf8') + afterB.toString('utf8'), 'nothing from the off period').not.toContain('OFF-');
      await expect(win.getByTestId(TAB_BUTTON), 'AC16: tab button returns').toBeVisible();
    } finally {
      if (ide) await closeApp(ide.app);
      world.cleanup();
    }
  });

  test('AC12/AC16: off, a Follow-files event does not open the file and keeps the preference; back on, the next one opens it', async () => {
    const world = makeWorld(['proja']);
    let ide: Ide | undefined;
    try {
      ide = await launchIde(world.home, world.root, true);
      const { win } = ide;
      await openProject(win, 'proja');
      const id = await projectId(win, 'proja');
      await waitForShell(win, id, 0, 'mock-claude ready');
      const creds = await hookCredentials(win, world.home, id, 0);

      // Turn Follow files on in the Activity tab, then return to Shell.
      await win.getByTestId(TAB_BUTTON).click();
      const follow = win.getByLabel('Follow files');
      await follow.check();
      await expect(follow).toBeChecked();
      await expect.poll(() => win.evaluate(() => localStorage.getItem('metaide.followFiles'))).toBe('true');
      await shellTabButton(win).click();
      await expect(win.getByTestId('shell-tab').first()).toBeVisible();

      // Off: a successful Edit does not open the file viewer.
      await setSetting(win, false);
      await expect(win.getByTestId(TAB_BUTTON)).toHaveCount(0);
      expect((await postRawHook(creds, pre())).status).toBe(204);
      expect((await postRawHook(creds, post())).status).toBe(204);
      await win.waitForTimeout(1500);
      await expect(win.getByTestId('file-preview'), 'AC12: file not opened while off').toHaveCount(0);
      await expect(win.getByTestId('shell-tab').first(), 'positive control: still on the Shell view').toBeVisible();
      expect(await win.evaluate(() => localStorage.getItem('metaide.followFiles')), 'preference kept').toBe('true');

      // On again: the same event now opens the file (positive control for the negative above).
      await setSetting(win, true);
      await expect(win.getByTestId(TAB_BUTTON)).toBeVisible();
      expect((await postRawHook(creds, post())).status).toBe(204);
      await expect(win.getByTestId('file-preview'), 'AC16: follow resumes').toBeVisible({ timeout: 10_000 });
      expect(await win.evaluate(() => localStorage.getItem('metaide.followFiles'))).toBe('true');
    } finally {
      if (ide) await closeApp(ide.app);
      world.cleanup();
    }
  });

  test('AC15: one settings change reaches every window; the Activity tab button follows, and a reloaded window starts in the right state', async () => {
    const world = makeWorld(['proja']);
    let ide: Ide | undefined;
    try {
      ide = await launchIde(world.home, world.root, true);
      const { app, win } = ide;
      await openProject(win, 'proja');
      await waitForShell(win, await projectId(win, 'proja'), 0, 'mock-claude ready');
      await expect(win.getByTestId(TAB_BUTTON), 'positive control: shown while on').toBeVisible();

      const [popout] = await Promise.all([
        app.waitForEvent('window'),
        win.getByTestId('popout-shell').click(),
      ]);
      await popout.waitForLoadState('domcontentloaded');

      const keysSeen = async (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __settingsKeys?: string[] }).__settingsKeys ?? []);
      for (const page of [win, popout]) {
        await page.evaluate(() => {
          const w = window as unknown as { __settingsKeys?: string[]; api: { on: (c: string, cb: (p: { key: string }) => void) => () => void } };
          w.__settingsKeys = [];
          w.api.on('settings:changed', (p) => { w.__settingsKeys!.push(p.key); });
        });
      }

      await setSetting(win, false);

      // The event reaches every window (the popout renders no main tab bar to assert on).
      await expect.poll(() => keysSeen(win)).toContain(KEY);
      await expect.poll(() => keysSeen(popout)).toContain(KEY);
      await expect(win.getByTestId(TAB_BUTTON)).toHaveCount(0);
      await expect(shellTabButton(win), 'positive control: tab bar rendered').toBeVisible();

      // A window opened after the change starts hidden (reload stands in for a new window).
      await win.reload();
      await win.waitForLoadState('domcontentloaded');
      // The shell is popped out, so the main window renders no terminal: select the project without openProject's `.xterm` wait.
      await win.locator('[data-testid="project-row"]').filter({ has: win.getByText('proja', { exact: true }) }).first().click();
      await expect(shellTabButton(win), 'positive control: tab bar rendered after reload').toBeVisible();
      await expect(win.getByTestId(TAB_BUTTON)).toHaveCount(0);
    } finally {
      if (ide) await closeApp(ide.app);
      world.cleanup();
    }
  });
});
