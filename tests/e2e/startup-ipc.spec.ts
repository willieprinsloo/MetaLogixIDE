import { expect, test, _electron as electron } from '@playwright/test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { closeApp, guardedLaunch } from './helpers/claude-harness';

interface StartupSettingsResult {
  readyStateAtInvoke: DocumentReadyState;
  outcome:
    | { status: 'fulfilled'; value: unknown }
    | { status: 'rejected'; error: string };
}

declare global {
  interface Window {
    startupSettingsResult: Promise<StartupSettingsResult>;
  }
}

const STARTUP_RENDERER = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>Startup IPC probe</title>
    <script>
      const readyStateAtInvoke = document.readyState;
      window.startupSettingsResult = window.api.invoke('settings:get', { key: 'scan_depth' }).then(
        ({ value }) => ({ readyStateAtInvoke, outcome: { status: 'fulfilled', value } }),
        (error) => ({ readyStateAtInvoke, outcome: { status: 'rejected', error: String(error) } }),
      );
    </script>
  </head>
  <body>Startup IPC probe</body>
</html>`;

test('settings IPC is registered before the initial renderer can invoke it', async () => {
  const { app, isolatedHome } = await guardedLaunch(async (scope) => {
    const isolatedHome = scope.tempDir('metaide-startup-ipc-home-');
    const rendererPath = join(isolatedHome, 'startup-renderer.html');
    writeFileSync(rendererPath, STARTUP_RENDERER);
    const app = scope.own(await electron.launch({
      args: [`--user-data-dir=${join(isolatedHome, 'userData')}`, '.'],
      env: {
        ...process.env,
        HOME: isolatedHome,
        METAIDE_TEST_MODE: '1',
        ELECTRON_RENDERER_URL: pathToFileURL(rendererPath).href,
      },
    }));
    return { app, isolatedHome };
  });

  try {
    const win = await app.firstWindow();
    await expect(win.getByText('Startup IPC probe')).toBeVisible();
    const result = await win.evaluate(() => window.startupSettingsResult);

    // An inline head script runs while loadURL is still pending. This guards
    // the ordering invariant rather than merely proving settings:get works later.
    expect(result.readyStateAtInvoke).toBe('loading');
    expect(
      result.outcome,
      result.outcome.status === 'rejected' ? result.outcome.error : undefined,
    ).toEqual({ status: 'fulfilled', value: 1 });
  } finally {
    await closeApp(app);
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});
