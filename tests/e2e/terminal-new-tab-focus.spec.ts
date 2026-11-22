import { expect, test } from '@playwright/test';
import { launch, newShellTab, PRIMARY, projectIdByName, projectRow, rememberedState, SIDEBAR_FILTER_INPUT, waitForProjectShown, waitForShellOutput } from './helpers/focus';

for (const { engine, entry } of [
  { engine: 'xterm', entry: 'menu' },
  { engine: 'ghostty', entry: 'menu' },
  { engine: 'ghostty', entry: 'shortcut' },
  { engine: 'ghostty', entry: 'profile' },
  { engine: 'ghostty', entry: 'custom command' },
]) {
  test(`${engine}: a new tab opened by ${entry} receives keystrokes`, async () => {
    const { app, win, cleanup } = await launch();
    try {
      await win.evaluate(value => Reflect.get(window, 'api').invoke('settings:set', { key: 'terminal_engine', value }), engine);
      await projectRow(win, 'alpha').click();
      await waitForProjectShown(win, 'alpha');
      const host = win.locator(PRIMARY).locator(`[data-terminal-engine="${engine}"]`);
      await expect(host).toBeVisible();
      const projectId = await projectIdByName(win, 'alpha');
      if (entry === 'menu') {
        await newShellTab(win, 'alpha');
      } else if (entry === 'shortcut') {
        await win.keyboard.press(process.platform === 'darwin' ? 'Meta+t' : 'Control+t');
      } else {
        if (entry === 'profile') {
          await win.evaluate(() => Reflect.get(window, 'api').invoke('settings:set', {
            key: 'default_cli_profiles', value: [{ name: 'Focus profile', argv: ['/bin/sh', '-i'] }],
          }));
        }
        await win.getByTestId('tabbar-new-shell').click();
        if (entry === 'profile') {
          await win.getByRole('button', { name: 'Focus profile', exact: true }).click();
        } else {
          await win.getByRole('button', { name: 'Add a custom command…' }).click();
          await win.getByPlaceholder(/^Command,/).fill('/bin/sh -i');
          await win.getByRole('button', { name: 'Run', exact: true }).click();
        }
      }
      await expect.poll(async () => (await rememberedState(win, projectId))?.activeShellIndex ?? 0).toBe(1);
      await expect(host.locator('textarea:visible')).toBeFocused();
      await win.keyboard.type("printf '%s%s\\n' 'FOCUSED-' 'NEW-TAB'");
      await win.keyboard.press('Enter');
      await waitForShellOutput(win, 'alpha', 1, 'FOCUSED-NEW-TAB');
    } finally {
      await app.close();
      cleanup();
    }
  });
}

for (const newerAction of ['project filter', 'another terminal tab']) test(`a delayed terminal launch does not override ${newerAction}`, async () => {
  const { app, win, cleanup } = await launch();
  try {
    await projectRow(win, 'alpha').click();
    await waitForProjectShown(win, 'alpha');
    const projectId = await projectIdByName(win, 'alpha');
    const otherTab = newerAction === 'another terminal tab' ? await newShellTab(win, 'alpha') : null;
    await app.evaluate(({ ipcMain }) => {
      const handlers: unknown = Reflect.get(ipcMain, '_invokeHandlers');
      if (!(handlers instanceof Map)) throw new Error('Missing Electron IPC handler map');
      const original: unknown = handlers.get('shells:launch-plain');
      if (typeof original !== 'function') throw new Error('Missing terminal launch handler');
      let release: () => void = () => {};
      const gate = new Promise<void>(resolve => { release = resolve; });
      Reflect.set(globalThis, 'releaseTerminalLaunch', release);
      ipcMain.removeHandler('shells:launch-plain');
      ipcMain.handle('shells:launch-plain', async (event, request: unknown) => {
        Reflect.set(globalThis, 'terminalLaunchReceived', true);
        await gate;
        return original(event, request);
      });
    });
    await win.getByTestId('tabbar-new-shell').click();
    await win.locator('[data-new-shell-menu="1"]').getByRole('button', { name: /Terminal/ }).click();
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'terminalLaunchReceived'))).toBe(true);
    const filter = win.locator(SIDEBAR_FILTER_INPUT);
    if (otherTab === null) {
      await filter.fill('alpha');
      await expect(filter).toBeFocused();
    } else {
      await win.locator('[data-testid="shell-tab-button"][data-shell-index="0"]').click();
      await expect.poll(async () => (await rememberedState(win, projectId))?.activeShellIndex ?? 0).toBe(0);
    }
    await app.evaluate(() => Reflect.get(globalThis, 'releaseTerminalLaunch')());
    await waitForShellOutput(win, 'alpha', (otherTab ?? 0) + 1, '$');
    if (otherTab === null) await expect(filter).toBeFocused();
    expect((await rememberedState(win, projectId))?.activeShellIndex ?? 0).toBe(0);
  } finally {
    await app.close();
    cleanup();
  }
});
