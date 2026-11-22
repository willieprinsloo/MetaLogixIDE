import { expect, test, type Locator, type Page } from '@playwright/test';
import { dropOn, launchDropFixture, PNG_1X1, PROJECT, RIGHT, shellWrites } from './helpers/drop';
import { shellOutput } from './helpers/focus';

async function openGhosttySplit(fixture: Awaited<ReturnType<typeof launchDropFixture>>) {
  const { win } = fixture;
  await win.evaluate(() => Reflect.get(window, 'api').invoke('settings:set', { key: 'terminal_engine', value: 'ghostty' }));
  await win.getByRole('button', { name: 'Files', exact: true }).click();
  await win.getByRole('button', { name: 'Shell', exact: true }).click();
  const host = win.locator(RIGHT).locator('[data-terminal-engine-host="ghostty"]');
  await expect(host).toBeVisible();
  await expect(host.locator('textarea')).toBeEnabled();
  return host;
}

for (const { mode, ctrlC, ctrlX } of [
  { mode: 0, ctrlC: '\x03', ctrlX: '\x18' },
  { mode: 5, ctrlC: '\x1b[99;5u', ctrlX: '\x1b[120;5u' },
  { mode: 7, ctrlC: '\x1b[99;5u\x1b[99;5:3u', ctrlX: '\x1b[120;5u\x1b[120;5:3u' },
]) {
  test(`Ghostty preserves Ctrl+letter in keyboard mode ${mode}`, async () => {
    const fixture = await launchDropFixture();
    const { win, app, right } = fixture;
    try {
      const host = await openGhosttySplit(fixture);
      await host.locator('.xterm-screen').click();
      const enable = mode ? `\\033[>${mode}u` : '';
      await win.keyboard.type(`printf '${enable}%s%s\\r\\n' 'KEYBOARD-' 'READY'; cat >/dev/null`);
      await win.keyboard.press('Enter');
      await expect.poll(() => shellOutput(win, PROJECT, right)).toContain('KEYBOARD-READY');
      const cut = (await shellWrites(app, right)).length;
      await win.keyboard.press('Control+c');
      await win.keyboard.press('Control+x');
      await win.keyboard.press('c');
      await expect.poll(async () => (await shellWrites(app, right)).slice(cut).join('')).toBe(`${ctrlC}${ctrlX}c`);
    } finally {
      await app.close();
      fixture.cleanup();
    }
  });
}

async function selectionText(host: Locator): Promise<string> {
  return host.locator('textarea').evaluate(input => {
    const data = new DataTransfer();
    input.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }));
    return data.getData('text/plain');
  });
}

async function selectionMarker(fixture: Awaited<ReturnType<typeof launchDropFixture>>, host: Locator, text: string, tracking: boolean) {
  const { win, right } = fixture;
  const modes = tracking ? '\\033[?1002h\\033[?1006h' : '\\033[?1002l\\033[?1006l';
  await host.locator('.xterm-screen').click();
  await win.keyboard.type(`printf '${modes}\\033[2J\\033[H%s\\r\\n' '${text}'${tracking ? '; cat >/dev/null' : ''}`);
  await win.keyboard.press('Enter');
  await expect.poll(() => shellOutput(win, PROJECT, right)).toContain(text);
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
  const find = win.locator(RIGHT).getByPlaceholder('Find…');
  await expect(find).toBeFocused();
  await find.fill(text);
  await find.press('Enter');
  const mark = host.locator('[data-terminal-find] span');
  await expect(mark).toBeVisible();
  const bounds = await mark.boundingBox();
  if (!bounds) throw new Error('Selection marker is not visible');
  await find.press('Escape');
  return { start: bounds.x + 1, end: bounds.x + bounds.width - 1, y: bounds.y + bounds.height / 2 };
}

async function dragSelection(win: Page, { start, end, y }: Awaited<ReturnType<typeof selectionMarker>>, option = false): Promise<void> {
  await win.mouse.move(start, y);
  if (option) await win.keyboard.down('Alt');
  await win.mouse.down();
  await win.mouse.move(end, y, { steps: 8 });
  // Releasing Option before the mouse must not report a stray mouse release.
  if (option) await win.keyboard.up('Alt');
  await win.mouse.up();
}

async function shiftClick(win: Page, x: number, y: number): Promise<void> {
  await win.keyboard.down('Shift');
  try { await win.mouse.click(x, y); } finally { await win.keyboard.up('Shift'); }
}

test('Ghostty Shift-click extends a drag selection from its original anchor', async () => {
  const fixture = await launchDropFixture();
  const { win, app, right } = fixture;
  try {
    const host = await openGhosttySplit(fixture);
    const tag = 'LEFT-GHOST-RIGHT';
    const { start, end, y } = await selectionMarker(fixture, host, tag, false);
    const middle = (start + end) / 2;
    const writes = () => shellWrites(app, right);
    const before = (await writes()).length;
    await dragSelection(win, { start: middle, end, y });
    await expect.poll(() => selectionText(host)).toMatch(/RIGHT$/u);
    await shiftClick(win, start, y);
    await expect.poll(() => selectionText(host)).toMatch(/^LEFT-/u);
    expect(await selectionText(host)).not.toContain('RIGHT');
    await shiftClick(win, end, y);
    await expect.poll(() => selectionText(host)).toMatch(/RIGHT$/u);
    expect(await selectionText(host)).not.toContain('LEFT');
    expect((await writes()).slice(before)).toEqual([]);
  } finally {
    await app.close();
    fixture.cleanup();
  }
});

test('Ghostty does not count Shift-click as part of a repeat-click sequence', async () => {
  const fixture = await launchDropFixture();
  const { win, app } = fixture;
  try {
    const host = await openGhosttySplit(fixture);
    const tag = 'ALPHA BRAVO CHARLIE';
    const { start, end, y } = await selectionMarker(fixture, host, tag, false);
    await dragSelection(win, { start, end: (start + end) / 2, y });
    await shiftClick(win, end, y);
    await expect.poll(() => selectionText(host)).toBe(tag);
    await win.mouse.click(start, y);
    await expect.poll(() => selectionText(host)).toBe('');
    await win.mouse.click(start, y);
    await expect.poll(() => selectionText(host)).toBe('ALPHA');
  } finally {
    await app.close();
    fixture.cleanup();
  }
});

test('Ghostty plain click clears a selection and anchors the next Shift-click', async () => {
  const fixture = await launchDropFixture();
  const { win, app } = fixture;
  try {
    const host = await openGhosttySplit(fixture);
    const tag = 'GHOST-SHIFT-ANCHOR';
    const { start, end, y } = await selectionMarker(fixture, host, tag, false);
    await dragSelection(win, { start: (start + end) / 2, end, y });
    await expect.poll(() => selectionText(host)).toMatch(/ANCHOR$/u);
    await win.mouse.click(start, y);
    await expect.poll(() => selectionText(host)).toBe('');
    await shiftClick(win, end, y);
    await expect.poll(() => selectionText(host)).toBe(tag);
    await host.locator('.xterm-screen').click({ button: 'right' });
    const clear = win.getByRole('menuitem', { name: 'Clear selection', exact: true });
    await expect(clear).toBeEnabled();
    await clear.click();
    await expect.poll(() => selectionText(host)).toBe('');
    await shiftClick(win, end, y);
    expect(await selectionText(host)).toBe('');
  } finally {
    await app.close();
    fixture.cleanup();
  }
});

test('Ghostty Shift-click extends Option-drag without reporting mouse input', async () => {
  test.skip(process.platform !== 'darwin', 'macOS Option override');
  const fixture = await launchDropFixture();
  const { win, app, right } = fixture;
  try {
    const host = await openGhosttySplit(fixture);
    const tag = 'GHOST-SHIFT-MOUSE-EXTEND';
    const { start, end, y } = await selectionMarker(fixture, host, tag, true);
    const before = (await shellWrites(app, right)).length;
    await dragSelection(win, { start, end: (start + end) / 2, y }, true);
    await expect.poll(() => selectionText(host)).toMatch(/^GHOST-SHIFT/u);
    await win.mouse.move(end, y);
    await win.keyboard.down('Shift');
    await win.mouse.down();
    await win.keyboard.up('Shift');
    await win.mouse.up();
    await expect.poll(() => selectionText(host)).toBe(tag);
    expect((await shellWrites(app, right)).slice(before)).toEqual([]);
  } finally {
    await app.close();
    fixture.cleanup();
  }
});

test('Ghostty reports primary drag motion separately from unpressed hover', async () => {
  const fixture = await launchDropFixture();
  const { win, app, right } = fixture;
  try {
    const host = await openGhosttySplit(fixture);
    const screen = host.locator('.xterm-screen');
    await screen.click();
    await win.keyboard.type(`printf '\\033[?1003h\\033[?1006h%s%s\\r\\n' 'MOUSE-' 'READY'; cat >/dev/null`);
    await win.keyboard.press('Enter');
    await expect.poll(() => shellOutput(win, PROJECT, right)).toContain('MOUSE-READY');

    const bounds = await screen.boundingBox();
    if (!bounds) throw new Error('Terminal screen is not visible');
    const before = (await shellWrites(app, right)).length;
    const reports = async () => [...(await shellWrites(app, right)).slice(before).join('').matchAll(/\x1b\[<(\d+);\d+;\d+([Mm])/gu)]
      .map(([, button, action]) => `${button}${action}`);

    const y = bounds.y + 20;
    await win.mouse.move(bounds.x + 15, y);
    await expect.poll(reports).toEqual(['35M']);
    await win.mouse.down();
    await win.mouse.move(bounds.x + 95, y);
    await win.mouse.up();
    await expect.poll(async () => (await reports()).at(-1)).toBe('0m');
    expect(await reports()).toEqual(['35M', '0M', '32M', '0m']);
  } finally {
    await app.close();
    fixture.cleanup();
  }
});

test('Ghostty Option-drag selects on macOS without sending a mouse report', async () => {
  test.skip(process.platform !== 'darwin', 'macOS Option override');
  const fixture = await launchDropFixture();
  const { win, app, right } = fixture;
  try {
    const host = await openGhosttySplit(fixture);
    const normal = await selectionMarker(fixture, host, 'GHOST-PLAIN-SELECTION', false);
    await dragSelection(win, normal);
    await expect.poll(() => selectionText(host)).toBe('GHOST-PLAIN-SELECTION');

    const mouse = await selectionMarker(fixture, host, 'GHOST-OPTION-SELECTION', true);
    const writes = () => shellWrites(app, right);
    const beforePlain = (await writes()).length;
    await dragSelection(win, mouse);
    await expect.poll(async () => (await writes()).slice(beforePlain).some(text => text.startsWith('\x1b[<'))).toBe(true);
    expect(await selectionText(host)).not.toContain('GHOST-OPTION-SELECTION');

    const beforeOption = (await writes()).length;
    await dragSelection(win, mouse, true);
    await expect.poll(() => selectionText(host)).toBe('GHOST-OPTION-SELECTION');
    expect((await writes()).slice(beforeOption)).toEqual([]);
  } finally {
    await app.close();
    fixture.cleanup();
  }
});

test('Ghostty Option-drag recovers after pointer capture is lost', async () => {
  test.skip(process.platform !== 'darwin', 'macOS Option override');
  const fixture = await launchDropFixture();
  const { win, app, right } = fixture;
  try {
    const host = await openGhosttySplit(fixture);
    const mouse = await selectionMarker(fixture, host, 'GHOST-CAPTURE-RECOVERY', true);
    const nativeHost = host.locator('.gespenst');
    await nativeHost.evaluate(root => {
      root.addEventListener('gotpointercapture', event => { root.dataset.testPointerId = String(event.pointerId); }, { once: true });
    });
    const writes = () => shellWrites(app, right);
    await win.mouse.move(mouse.start, mouse.y);
    const before = (await writes()).length;
    await win.keyboard.down('Alt');
    await win.mouse.down();
    await win.mouse.move(mouse.end, mouse.y, { steps: 4 });
    // The browser delivers a real lostpointercapture on the next pointer event.
    expect(await nativeHost.evaluate(root => {
      const id = Number(root.dataset.testPointerId);
      if (!root.hasPointerCapture(id)) return false;
      root.releasePointerCapture(id);
      return true;
    })).toBe(true);
    await win.keyboard.up('Alt');
    await win.mouse.up();
    expect((await writes()).slice(before)).toEqual([]);
    await dragSelection(win, mouse, true);
    await expect.poll(() => selectionText(host)).toBe('GHOST-CAPTURE-RECOVERY');
    expect((await writes()).slice(before)).toEqual([]);
  } finally {
    await app.close();
    fixture.cleanup();
  }
});

test('Ghostty inserts a dropped PNG path exactly once as bracketed paste', async () => {
  const fixture = await launchDropFixture();
  const { win, app, right } = fixture;
  try {
    const host = await openGhosttySplit(fixture);
    const screen = host.locator('.xterm-screen');
    await screen.click();
    await win.keyboard.type(`printf '\\033[?2004hDROP-%s\\n' 'READY'; cat`);
    await win.keyboard.press('Enter');
    await expect.poll(() => shellOutput(win, PROJECT, right)).toContain('DROP-READY');
    await dropOn(screen, { files: [{ name: 'ghostty-drop-oracle.png', type: 'image/png', bytes: [...PNG_1X1] }] });
    const writes = () => shellWrites(app, right).then(data => data.filter(text => text.includes('ghostty-drop-oracle.png')));
    await expect.poll(async () => (await writes()).map(text => ({ start: text.startsWith('\x1b[200~'), end: text.endsWith('ghostty-drop-oracle.png\x1b[201~') }))).toEqual([{ start: true, end: true }]);
  } finally {
    await app.close();
    fixture.cleanup();
  }
});

test('Ghostty fits its full pane on entry to alternate screen and after resize', async () => {
  const fixture = await launchDropFixture();
  const { win, app } = fixture;
  try {
    const host = await openGhosttySplit(fixture);
    const screen = host.locator('.xterm-screen');
    const viewport = host.locator('.xterm-viewport');
    await expect(viewport).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const fit = () => host.evaluate(el => {
      const screen = el.querySelector('.xterm-screen')?.getBoundingClientRect();
      const canvas = el.querySelector('canvas.gespenst__text')?.getBoundingClientRect();
      if (!screen || !canvas) throw new Error('Ghostty screen or canvas missing');
      return { fillsWidth: el.clientWidth - screen.width <= 1, containsColumns: canvas.width <= screen.width + 1,
        heightFits: screen.height - canvas.height >= -1 && screen.height - canvas.height < 26, screenHeight: screen.height };
    });
    await expect.poll(fit).toMatchObject({ containsColumns: true, heightFits: true });
    await screen.click();
    await win.keyboard.type(`printf '\\033[?1049h'; cat`);
    await win.keyboard.press('Enter');
    await expect(win.locator(RIGHT).getByTestId('shell-tab')).toHaveAttribute('data-alt-screen', 'true');
    await expect(viewport).toBeHidden();
    await expect.poll(fit).toMatchObject({ fillsWidth: true, containsColumns: true, heightFits: true });
    const before = (await fit()).screenHeight;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1260, 730));
    await expect.poll(async () => (await fit()).screenHeight).not.toBe(before);
    await expect.poll(fit).toMatchObject({ fillsWidth: true, containsColumns: true, heightFits: true });
  } finally {
    await app.close();
    fixture.cleanup();
  }
});

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
