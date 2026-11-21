import { expect, test } from '@playwright/test';
import { launchDropFixture, PROJECT, RIGHT } from './helpers/drop';
import { shellOutput } from './helpers/focus';

test('a saved Ghostty choice applies to the next view and context loss keeps the shell', async () => {
  const fixture = await launchDropFixture();
  const { win, right, app } = fixture;
  try {
    const pane = win.locator(RIGHT);
    const status = (engine: string) => pane.locator(`[data-terminal-engine="${engine}"]`);
    await expect(status('xterm')).toBeVisible();
    await win.evaluate(async () => {
      const bridge = Reflect.get(window, 'api');
      await bridge.invoke('settings:set', { key: 'terminal_engine', value: 'ghostty' });
    });
    await expect(status('xterm')).toBeVisible();
    await win.getByRole('button', { name: 'Files', exact: true }).click();
    await win.getByRole('button', { name: 'Shell', exact: true }).click();
    const ghost = status('ghostty');
    await expect(ghost).toBeVisible({ timeout: 10_000 });
    await ghost.locator('[data-terminal-engine-host="ghostty"] .xterm-screen').click();
    await win.keyboard.type('printf "GHOST-BEFORE-%s\\n" "$$"');
    await win.keyboard.press('Enter');
    const transcript = () => shellOutput(win, PROJECT, right);
    await expect.poll(transcript).toMatch(/GHOST-BEFORE-\d+/u);
    const pid = (await transcript()).match(/GHOST-BEFORE-(\d+)/u)?.[1];
    expect(pid).toBeTruthy();
    await app.evaluate(({ clipboard }) => clipboard.writeText('before-ghostty-copy'));
    await win.keyboard.type('printf "\\033]52;c;R2hvc3R0eS1saXZl\\007"');
    await win.keyboard.press('Enter');
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('Ghostty-live');
    await app.evaluate(({ clipboard }) => clipboard.writeText('after-ghostty-copy'));

    const lost = await ghost.locator('[data-terminal-engine-host="ghostty"] canvas').evaluateAll(nodes => {
      for (const node of nodes) {
        if (!(node instanceof HTMLCanvasElement)) continue;
        const gl = node.getContext('webgl2')?.getExtension('WEBGL_lose_context');
        if (gl) { gl.loseContext(); return true; }
      }
      return false;
    });
    expect(lost).toBe(true);
    await expect(status('fallback')).toBeVisible({ timeout: 5000 });
    await expect(pane.getByRole('status')).toHaveText('Using xterm.js after Ghostty failed');
    await expect(status('fallback').locator('textarea')).toBeFocused();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('after-ghostty-copy');
    await win.keyboard.type('printf "GHOST-AFTER-%s\\n" "$$"');
    await win.keyboard.press('Enter');
    await expect.poll(transcript).toContain(`GHOST-AFTER-${pid}`);
  } finally {
    await app.close();
    fixture.cleanup();
  }
});

test('Ghostty Find moves between matches and only a click opens a plain HTTPS link', async () => {
  const { win, right, app, cleanup } = await launchDropFixture();
  const channel = 'app:open-external';
  try {
    // Observe the real renderer intent without starting an OS browser or network request.
    await app.evaluate(({ ipcMain }, name) => {
      const calls: unknown[] = [];
      Object.defineProperty(globalThis, '__ghosttyLinkIntents', { configurable: true, value: calls });
      ipcMain.removeHandler(name);
      ipcMain.handle(name, (_event, request: unknown) => { calls.push(request); });
    }, channel);
    const intents = () => app.evaluate((): unknown => Reflect.get(globalThis, '__ghosttyLinkIntents'));
    await win.evaluate(async () => {
      const bridge = Reflect.get(window, 'api');
      await bridge.invoke('settings:set', { key: 'terminal_engine', value: 'ghostty' });
    });
    await win.getByRole('button', { name: 'Files', exact: true }).click();
    await win.getByRole('button', { name: 'Shell', exact: true }).click();
    const ghost = win.locator(RIGHT).locator('[data-terminal-engine="ghostty"]');
    const screen = ghost.locator('[data-terminal-engine-host="ghostty"] .xterm-screen');
    await expect(screen).toBeVisible();
    await screen.click();
    await win.keyboard.type(`printf '%s%s\\n' 'https://' 'example.test/demo'; printf '%s%s\\n' 'https://' 'example.test/demo'`);
    await win.keyboard.press('Enter');
    await expect.poll(() => shellOutput(win, PROJECT, right)).toContain('https://example.test/demo');
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
    const find = win.locator(RIGHT).getByPlaceholder('Find…');
    await expect(find).toBeFocused();
    await find.fill('HTTPS://example.test/demo');
    await find.press('Enter');
    const mark = ghost.locator('[data-terminal-find] span');
    await expect(mark).toBeVisible();
    const first = await mark.boundingBox();
    expect(first).not.toBeNull();
    await find.press('Enter');
    await expect.poll(() => mark.boundingBox()).not.toEqual(first);
    await find.press('Shift+Enter');
    await expect.poll(() => mark.boundingBox()).toEqual(first);
    await find.press('Escape');
    await expect(mark).toHaveCount(0);
    await expect(screen.locator('textarea')).toBeFocused();
    if (!first) throw new Error('Missing find geometry');
    const point = { x: first.x + first.width / 2, y: first.y + first.height / 2 };
    await win.mouse.move(point.x, point.y);
    await expect(ghost.locator('[data-terminal-engine-host="ghostty"] .xterm')).toHaveCSS('cursor', 'pointer');
    expect(await intents()).toEqual([]);
    await win.mouse.click(point.x, point.y);
    await expect.poll(intents).toEqual([{ url: 'https://example.test/demo' }]);
  } finally {
    await app.close();
    cleanup();
  }
});

test('General applies a committed engine choice on reopen in an already-open popout', async () => {
  const { win, app, projectId, cleanup } = await launchDropFixture();
  try {
    const [popout] = await Promise.all([app.waitForEvent('window'), win.evaluate(async id => {
      const bridge = Reflect.get(window, 'api');
      const { shellIndex } = await bridge.invoke('shells:launch-plain', { projectId: id });
      await bridge.invoke('windows:popout-shell', { projectId: id, shellIndex });
    }, projectId)]);
    const popoutEngine = popout.locator('[data-terminal-engine]');
    await expect(popoutEngine).toHaveAttribute('data-terminal-engine', 'xterm');
    await app.evaluate(({ ipcMain }) => {
      type Handler = (event: unknown, request: { key?: string }) => unknown;
      type Settle = (commit: boolean) => void;
      const handlers: unknown = Reflect.get(ipcMain, '_invokeHandlers');
      const original: Handler | undefined = handlers instanceof Map ? handlers.get('settings:set') : undefined;
      if (!original) throw new Error('No settings:set handler');
      ipcMain.removeHandler('settings:set');
      ipcMain.handle('settings:set', async (event, request: { key?: string }) => {
        if (request.key === 'terminal_engine') {
          const commit = await new Promise<boolean>(resolve => Reflect.set(globalThis, '__engineSaveSettle', resolve satisfies Settle));
          Reflect.deleteProperty(globalThis, '__engineSaveSettle');
          if (!commit) throw new Error('engine save rejected by test');
        }
        return original(event, request);
      });
    });
    async function settle(commit: boolean) {
      await expect.poll(() => app.evaluate(() => typeof Reflect.get(globalThis, '__engineSaveSettle'))).toBe('function');
      await app.evaluate((_electron, next) => Reflect.get(globalThis, '__engineSaveSettle')(next), commit);
    }
    async function reopenPopout() {
      await popout.getByRole('button', { name: 'Files', exact: true }).click();
      await expect(popoutEngine).toHaveCount(0);
      await popout.getByRole('button', { name: 'Shell', exact: true }).click();
      await expect(popoutEngine).toBeVisible();
    }
    await win.getByRole('button', { name: /^Settings \(/ }).click();
    const chooser = win.getByRole('radiogroup', { name: 'Terminal engine' });
    const xterm = chooser.getByRole('radio', { name: 'xterm.js', exact: true });
    const ghostty = chooser.getByRole('radio', { name: 'Ghostty (WASM)', exact: true });
    await expect(chooser).toHaveAccessibleDescription('Applies when you open or reopen a terminal view. Open views stay as they are.');
    await expect(xterm).toBeChecked();
    await xterm.press('ArrowRight');
    await expect(chooser).toHaveAttribute('aria-busy', 'true');
    await expect(xterm).toBeChecked();
    await reopenPopout();
    await expect(popoutEngine).toHaveAttribute('data-terminal-engine', 'xterm');
    await settle(false);
    await expect(win.getByRole('alert').filter({ hasText: 'Could not save the terminal engine' })).toBeVisible();
    await expect(xterm).toBeChecked();
    await reopenPopout();
    await expect(popoutEngine).toHaveAttribute('data-terminal-engine', 'xterm');

    await ghostty.click();
    await settle(true);
    await expect(ghostty).toBeChecked();
    await expect(popoutEngine).toHaveAttribute('data-terminal-engine', 'xterm');
    await reopenPopout();
    await expect(popoutEngine).toHaveAttribute('data-terminal-engine', 'ghostty');

    await ghostty.press('ArrowLeft');
    await settle(true);
    await expect(xterm).toBeChecked();
    await expect(popoutEngine).toHaveAttribute('data-terminal-engine', 'ghostty');
    await reopenPopout();
    await expect(popoutEngine).toHaveAttribute('data-terminal-engine', 'xterm');
  } finally {
    await app.close();
    cleanup();
  }
});
