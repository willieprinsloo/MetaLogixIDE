import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  baseEnv, closeApp, hookCredentials, installNotificationSpy, launch, notifications,
  openProject, projectId, sendAndWaitForPromptHook, sendLine, waitForShell,
} from './helpers/claude-harness';

test('Claude command hooks deliver notifications and Activity, then go quiet after IDE exit', async () => {
  const { app, win, isolatedHome, demoRoot, cleanup } = await launch(['proja']);
  try {
    await installNotificationSpy(app);
    await openProject(win, 'proja');
    const id = await projectId(win, 'proja');
    await waitForShell(win, id, 0, 'mock-claude ready');
    const creds = await hookCredentials(win, id, 0);
    await win.getByRole('button', { name: 'Files', exact: true }).click();
    await sendLine(win, id, 0, '/hook-tool forwarder-smoke.txt');
    const logPath = join(demoRoot, 'proja', '.metaide', 'activity.jsonl');
    await expect.poll(() => {
      try { return readFileSync(logPath, 'utf8'); } catch { return ''; }
    }).toContain('forwarder-smoke.txt');
    await sendLine(win, id, 0, '/hook-notify permission_prompt Forwarder smoke');
    await expect.poll(async () => (await notifications(app)).map((n) => n.body)).toContain('Forwarder smoke');
    await sendAndWaitForPromptHook(win, id, 0, 'finish a turn');
    await sendLine(win, id, 0, '/hook-stop');
    await expect.poll(async () => (await notifications(app)).map((n) => n.body)).toContain('Claude finished and is waiting for you');

    const hooksDir = join(isolatedHome, '.metaide', 'claude-hooks');
    const [settingsFile] = readdirSync(hooksDir);
    const settings = JSON.parse(readFileSync(join(hooksDir, settingsFile!), 'utf8')) as {
      hooks: { Stop: [{ hooks: [{ command: string; shell?: string }] }] };
    };
    const hook = settings.hooks.Stop[0].hooks[0];
    const paths = await app.evaluate(({ app }) => ({
      executable: process.execPath,
      appPath: app.getAppPath(),
    }));
    await closeApp(app);
    expect(readdirSync(hooksDir)).toEqual([]);
    const windows = hook.shell === 'powershell';
    const result = spawnSync(windows ? 'powershell.exe' : '/bin/sh',
      windows ? ['-NoProfile', '-Command', hook.command] : ['-c', hook.command], {
        input: JSON.stringify({ hook_event_name: 'Stop' }),
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
        env: {
          ...baseEnv(),
          METAIDE_HOOK_EXE: paths.executable,
          METAIDE_HOOK_FORWARDER: join(paths.appPath, 'resources', 'claude-hooks', 'forward.cjs'),
          METAIDE_HOOK_ENDPOINT: creds.endpoint,
          METAIDE_HOOK_SHELL: creds.shellId,
          METAIDE_HOOK_TOKEN: creds.token,
        },
      });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toBe('');
  } finally {
    await closeApp(app);
    cleanup();
  }
});
