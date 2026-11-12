import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { closeApp, guardedLaunch } from './helpers/claude-harness';

/**
 * Full-screen terminal apps (opencode, vim) paint their own margins and background, so the
 * shell's padding drops while the alternate screen shows and returns when it is left.
 */

// Enters the alternate screen, leaves it after a "leave" line on stdin.
const ALT_APP = [
  "process.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[HFULLSCREEN');",
  "process.stdin.setRawMode?.(false);",
  "process.stdin.on('data', (d) => { if (String(d).includes('leave')) process.stdout.write('\\x1b[?1049lBACK\\r\\n'); });",
  'setInterval(() => {}, 1000);',
].join(' ');

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  await guardedLaunch(async (scope) => {
    const home = scope.tempDir('metaide-alt-home-');
    const root = scope.tempDir('metaide-alt-root-');
    mkdirSync(join(root, 'alt')); mkdirSync(join(root, 'alt', '.git'));
    const launch = JSON.stringify({ argv: ['node', '-e', ALT_APP], env: {} });
    app = scope.own(await electron.launch({
      args: ['.', `--user-data-dir=${join(home, 'userData')}`],
      env: { ...process.env, HOME: home, METAIDE_TEST_MODE: '1', METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
        METAIDE_DEFAULT_LAUNCH_FIRST: launch, METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: launch },
    }));
    win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.evaluate(async (path: string) => {
      await (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } }).api.invoke('roots:add', { path });
    }, root);
    await win.locator('[data-testid="project-row"]', { hasText: 'alt' }).first().click();
  });
});

test.afterAll(async () => {
  if (app) await closeApp(app);
});

const padding = (page: Page) => page.getByTestId('shell-tab').first().evaluate((el) => {
  const cs = getComputedStyle(el);
  return [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft];
});

test('the shell padding drops while a full-screen app shows and returns after it leaves', async () => {
  const tab = win.getByTestId('shell-tab').first();
  await expect(tab).toHaveAttribute('data-alt-screen', 'true', { timeout: 10_000 });
  expect(await padding(win), 'no frame around a full-screen app').toEqual(['0px', '0px', '0px', '0px']);
  const host = await tab.boundingBox();
  const screen = await tab.locator('.xterm-screen').boundingBox();
  expect(host && screen && Math.abs(screen.x - host.x), 'the app starts at the sheet edge').toBeLessThanOrEqual(1);
  // No 14px scrollbar reserve: what is left on the right is under one cell wide.
  const cellWidth = await tab.evaluate((el) => {
    const probe = el.querySelector('.xterm-char-measure-element') as HTMLElement | null;
    return probe ? probe.getBoundingClientRect().width / Math.max(1, (probe.textContent ?? '').length) : 10;
  });
  await expect.poll(async () => {
    const h = await tab.boundingBox();
    const sc = await tab.locator('.xterm-screen').boundingBox();
    return h && sc ? h.x + h.width - (sc.x + sc.width) : -1;
  }, { message: `right-hand gap under one cell (${cellWidth.toFixed(1)}px)` }).toBeLessThan(cellWidth);

  await tab.click();
  await win.keyboard.type('leave');
  await win.keyboard.press('Enter');
  await expect(tab).not.toHaveAttribute('data-alt-screen', 'true');
  expect(await padding(win), 'a plain shell keeps its padding').toEqual(['8px', '12px', '4px', '12px']);
});
