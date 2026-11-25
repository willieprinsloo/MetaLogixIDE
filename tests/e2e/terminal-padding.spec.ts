import { expect, test, type Locator, type Page } from '@playwright/test';
import { launch, newShellTab, PRIMARY, projectIdByName, projectRow, shellOutput, waitForProjectShown } from './helpers/focus';

const horizontal = 'Terminal horizontal padding';
const vertical = 'Terminal vertical padding';

async function expectPadding(frame: Locator, horizontalPx: number, top: number, bottom: number): Promise<void> {
  await expect(frame).toHaveCSS('padding-left', `${horizontalPx}px`);
  await expect(frame).toHaveCSS('padding-right', `${horizontalPx}px`);
  await expect(frame).toHaveCSS('padding-top', `${top}px`);
  await expect(frame).toHaveCSS('padding-bottom', `${bottom}px`);
}

async function savePadding(win: Page, label: string, value: number): Promise<void> {
  const input = win.getByRole('spinbutton', { name: label });
  await expect(input).toBeVisible();
  await input.fill(String(value));
  await input.press('Enter');
  await expect(input).toHaveValue(String(value));
}

async function shellSize(win: Page, projectId: number, shellIndex: number, tag: string): Promise<number[]> {
  const marker = new RegExp(`${tag} (\\d+) (\\d+) (\\d+)`);
  await win.evaluate(({ projectId, shellIndex, tag }) => window.api.invoke('shells:write', {
    projectId, shellIndex, data: `printf '%s %s ' '${tag}' "$$"; stty size\r`,
  }), { projectId, shellIndex, tag });
  let output = '';
  await expect.poll(async () => {
    output = await shellOutput(win, 'alpha', shellIndex);
    return output;
  }).toMatch(marker);
  const match = output.match(marker);
  if (!match) throw new Error(`Missing terminal grid report for ${tag}`);
  return match.slice(1).map(Number);
}

for (const engine of ['xterm', 'ghostty'] as const) {
  test(`${engine} refits a running terminal when padding changes and resets`, async () => {
    const { app, win, cleanup } = await launch();
    try {
      await win.evaluate(value => window.api.invoke('settings:set', { key: 'terminal_engine', value }), engine);
      await projectRow(win, 'alpha').click();
      await waitForProjectShown(win, 'alpha');
      const projectId = await projectIdByName(win, 'alpha');
      const index = await newShellTab(win, 'alpha');
      const frame = win.locator(PRIMARY).getByTestId('shell-tab');
      const host = frame.locator(`[data-terminal-engine="${engine}"]`);
      await expect(host).toBeVisible();
      await expectPadding(frame, 12, 8, 4);
      const originalHost = await host.elementHandle();
      if (!originalHost) throw new Error('Terminal host did not mount');
      const [pid, rows, cols] = await shellSize(win, projectId, index, 'PADDING-BASE');

      await win.getByTestId('settings-open').click();
      await savePadding(win, horizontal, 32);
      await savePadding(win, vertical, 32);
      await expectPadding(frame, 32, 32, 32);
      // Geometry is updated via ResizeObserver. Wait for its new grid, not a fixed animation delay.
      let attempt = 0;
      await expect.poll(async () => {
        const [newPid, newRows, newCols] = await shellSize(win, projectId, index, `PADDING-LARGE-${++attempt}`);
        return { samePid: newPid === pid, fewerRows: newRows < rows, fewerCols: newCols < cols };
      }).toEqual({ samePid: true, fewerRows: true, fewerCols: true });
      expect(await originalHost.evaluate(el => el.isConnected)).toBe(true);
      await expect(host).toBeVisible();

      await savePadding(win, horizontal, 0);
      await expectPadding(frame, 0, 32, 32);
      await win.getByRole('button', { name: 'Reset terminal horizontal padding' }).click();
      await win.getByRole('button', { name: 'Reset terminal vertical padding' }).click();
      await expectPadding(frame, 12, 8, 4);
      await expect.poll(() => shellSize(win, projectId, index, `PADDING-RESET-${++attempt}`))
        .toEqual([pid, rows, cols]);
    } finally {
      await app.close();
      cleanup();
    }
  });
}

test('main window Settings updates both split panes and an already-open popout', async () => {
  const { app, win, cleanup } = await launch();
  try {
    await projectRow(win, 'alpha').click();
    await waitForProjectShown(win, 'alpha');
    const projectId = await projectIdByName(win, 'alpha');
    const [popout] = await Promise.all([app.waitForEvent('window'), win.evaluate(async id => {
      const { shellIndex } = await window.api.invoke('shells:launch-plain', { projectId: id });
      await window.api.invoke('windows:popout-shell', { projectId: id, shellIndex });
    }, projectId)]);
    const popoutFrame = popout.getByTestId('shell-tab');
    await expectPadding(popoutFrame, 12, 8, 4);

    await win.getByTestId('tabbar-split').click();
    const left = win.locator(PRIMARY).getByTestId('shell-tab');
    const right = win.getByTestId('split-right').getByTestId('shell-tab');
    await expectPadding(left, 12, 8, 4);
    await expectPadding(right, 12, 8, 4);
    await win.getByTestId('settings-open').click();
    await savePadding(win, horizontal, 4);
    await savePadding(win, vertical, 0);
    for (const frame of [left, right, popoutFrame]) await expectPadding(frame, 4, 0, 0);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a rejected padding save keeps the committed spacing', async () => {
  const { app, win, cleanup } = await launch();
  try {
    await projectRow(win, 'alpha').click();
    await waitForProjectShown(win, 'alpha');
    const frame = win.locator(PRIMARY).getByTestId('shell-tab');
    await expectPadding(frame, 12, 8, 4);
    await app.evaluate(({ ipcMain }) => {
      const handlers: unknown = Reflect.get(ipcMain, '_invokeHandlers');
      const original: unknown = handlers instanceof Map ? handlers.get('settings:set') : undefined;
      if (typeof original !== 'function') throw new Error('Missing settings:set handler');
      ipcMain.removeHandler('settings:set');
      ipcMain.handle('settings:set', (event, request: { key: string }) => {
        if (request.key === 'terminal_padding_horizontal') throw new Error('Test save failure');
        return original(event, request);
      });
    });
    await win.getByTestId('settings-open').click();
    const input = win.getByRole('spinbutton', { name: horizontal });
    await input.fill('22');
    await input.press('Enter');
    await expect(win.getByRole('alert').filter({ hasText: 'Could not save terminal horizontal padding' })).toBeVisible();
    await expectPadding(frame, 12, 8, 4);
  } finally {
    await app.close();
    cleanup();
  }
});
