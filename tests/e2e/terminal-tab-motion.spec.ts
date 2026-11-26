/** Electron coverage for desktop terminal chip motion and tab selection. */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launch, newShellTab, projectIdByName, projectRow, waitForProjectShown } from './helpers/focus';
import { collectFrames, startFrames, type Frame } from './helpers/frames';

const chip = (index: number) => `[data-testid="shell-tab-button"][data-shell-index="${index}"]`;
const leaving = '[data-testid="shell-tab-leaving"]';

async function pick(win: Page, name: string): Promise<void> {
  await projectRow(win, name).click();
  await waitForProjectShown(win, name);
  await expect(win.locator(chip(0))).toBeVisible();
}

async function terminalMenuButton(win: Page) {
  await win.getByTestId('tabbar-new-shell').click();
  const terminal = win.getByRole('button', { name: /Terminal/ }).filter({ has: win.getByText('Terminal', { exact: true }) });
  await expect(terminal).toBeVisible();
  return terminal;
}

function faded(frames: Frame[], target: string): boolean {
  return frames.some(({ s }) => s[target]?.present && s[target].opacity > 0 && s[target].opacity < 0.99);
}

function transformed(frames: Frame[], target: string): boolean {
  return frames.some(({ s }) => s[target]?.present && s[target].transform !== 'none');
}

function verticalTravel(frames: Frame[], target: string): number {
  const positions = frames.flatMap(({ s }) => s[target]?.present ? [s[target].y] : []);
  return positions.length > 1 ? Math.max(...positions) - Math.min(...positions) : 0;
}

function slid(frames: Frame[], target: string): boolean {
  const start = frames[0]?.s[target]?.x ?? 0;
  const end = frames.at(-1)?.s[target]?.x ?? start;
  return Math.abs(end - start) > 10 && frames.some(({ s }) => {
    const x = s[target]?.x ?? start;
    return x > Math.min(start, end) + 1 && x < Math.max(start, end) - 1;
  });
}

for (const reduced of [false, true]) {
  test(`pointer chips fade, leave inertly and ${reduced ? 'snap under Reduce Motion' : 'slide surviving neighbors'}`, async () => {
    const { app, win, cleanup } = await launch();
    try {
      await pick(win, 'alpha');
      await newShellTab(win, 'alpha');
      await newShellTab(win, 'alpha');
      if (reduced) await win.emulateMedia({ reducedMotion: 'reduce' });
      const close = win.locator(chip(1)).getByRole('button', { name: /^Close/ });
      await close.hover();
      await startFrames(win, { neighbor: chip(2), leaving }, 850);
      await close.click();
      await expect(win.locator(chip(1))).toHaveCount(0);
      const exit = await collectFrames(win);
      expect(faded(exit, 'leaving'), 'the closed member briefly remains visible as it fades').toBe(true);
      expect(transformed(exit, 'leaving'), 'exit scaling respects the live media preference').toBe(!reduced);
      expect(slid(exit, 'neighbor'), 'survivor reflow respects the live media preference').toBe(!reduced);
      await expect(win.locator(leaving)).toHaveCount(0);

      const terminal = await terminalMenuButton(win);
      await startFrames(win, { entry: chip(1), neighbor: chip(2) }, 850);
      await terminal.click();
      await expect(win.locator(chip(1))).toBeVisible();
      const entry = await collectFrames(win);
      expect(faded(entry, 'entry'), 'refilling an earlier slot fades the new chip in').toBe(true);
      expect(transformed(entry, 'entry'), 'entry scaling respects the live media preference').toBe(!reduced);
      expect(slid(entry, 'neighbor'), 'opening into a gap slides the surviving neighbor').toBe(!reduced);
    } finally {
      await app.close();
      cleanup();
    }
  });
}

test('pointer append and last-chip close have visible vertical travel without sibling reflow', async () => {
  const { app, win, cleanup } = await launch();
  try {
    await pick(win, 'alpha');
    const terminal = await terminalMenuButton(win);
    await startFrames(win, { member: chip(1) }, 850);
    await terminal.click();
    await expect(win.locator(chip(1))).toBeVisible();
    const entry = await collectFrames(win);
    expect(faded(entry, 'member')).toBe(true);
    expect(verticalTravel(entry, 'member')).toBeGreaterThan(4);

    await startFrames(win, { leaving }, 850);
    await win.locator(chip(1)).getByRole('button', { name: /^Close/ }).click();
    await expect(win.locator(chip(1))).toHaveCount(0);
    const exit = await collectFrames(win);
    expect(faded(exit, 'leaving')).toBe(true);
    expect(verticalTravel(exit, 'leaving')).toBeGreaterThan(4);
  } finally {
    await app.close();
    cleanup();
  }
});

test('the closing last chip remains visible past the shortened tab strip', async () => {
  const { app, win, cleanup } = await launch();
  try {
    await pick(win, 'alpha');
    await newShellTab(win, 'alpha');
    await win.evaluate(selector => {
      const observer = new MutationObserver(() => {
        const ghost = document.querySelector(selector);
        if (!ghost) return;
        observer.disconnect();
        const intersection = new IntersectionObserver(([sample]) => {
          Reflect.set(window, 'exitClip', {
            totalWidth: sample.boundingClientRect.width,
            visibleWidth: sample.intersectionRect.width,
            visibleHeight: sample.intersectionRect.height,
          });
          intersection.disconnect();
        });
        intersection.observe(ghost);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }, leaving);
    await win.locator(chip(1)).getByRole('button', { name: /^Close/ }).click();
    await expect.poll(() => win.evaluate(() => Reflect.get(window, 'exitClip'))).toBeDefined();
    const clip = await win.evaluate(() => Reflect.get(window, 'exitClip'));
    expect(clip.visibleWidth).toBeGreaterThan(clip.totalWidth / 2);
    expect(clip.visibleHeight).toBeGreaterThan(0);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a close animates when the tab disappears before the IPC reply', async () => {
  const { app, win, cleanup } = await launch();
  try {
    await pick(win, 'alpha');
    await newShellTab(win, 'alpha');
    await app.evaluate(({ ipcMain }) => {
      const handlers: unknown = Reflect.get(ipcMain, '_invokeHandlers');
      const close: unknown = handlers instanceof Map ? handlers.get('shells:kill') : undefined;
      if (typeof close !== 'function' || !(handlers instanceof Map)) throw new Error('Missing close handler');
      const gate = new Promise<void>(resolve => { Reflect.set(globalThis, 'releaseCloseReply', resolve); });
      handlers.set('shells:kill', async (event: unknown, request: unknown) => {
        const result: unknown = await close(event, request);
        await gate;
        return result;
      });
    });
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await startFrames(win, { leaving }, 850);
    await win.keyboard.press(`${modifier}+w`);
    await expect(win.locator(chip(1))).toHaveCount(0);
    const frames = await collectFrames(win);
    await app.evaluate(() => Reflect.get(globalThis, 'releaseCloseReply')());
    expect(faded(frames, 'leaving')).toBe(true);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a rejected close clears its animation intent and leaves the tab usable', async () => {
  const { app, win, cleanup } = await launch();
  try {
    await pick(win, 'alpha');
    await newShellTab(win, 'alpha');
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('shells:kill');
      ipcMain.handle('shells:kill', () => { throw new Error('Fixture refuses close'); });
    });
    const tab = win.locator(chip(1));
    await tab.getByRole('button', { name: /^Close/ }).click();
    await expect(win.getByText('Failed to close terminal', { exact: true })).toBeVisible();
    await expect(tab).toBeVisible();
    await expect(win.locator(leaving)).toHaveCount(0);

    await startFrames(win, { leaving }, 850);
    await win.locator('.split-left [data-terminal-engine] textarea:visible').first().click();
    await win.keyboard.type('exit');
    await win.keyboard.press('Enter');
    await expect(tab).toHaveCount(0);
    expect((await collectFrames(win)).some(frame => frame.s.leaving?.present)).toBe(false);
  } finally {
    await app.close();
    cleanup();
  }
});

for (const reduced of [false, true]) {
test(`keyboard opens and closes animate ${reduced ? 'with fades only under Reduce Motion' : 'with vertical travel'}`, async () => {
  const { app, win, cleanup } = await launch();
  try {
    await pick(win, 'alpha');
    if (reduced) await win.emulateMedia({ reducedMotion: 'reduce' });
    const terminal = await terminalMenuButton(win);
    await startFrames(win, { member: chip(1), leaving }, 850);
    await terminal.press('Enter');
    await expect(win.locator(chip(1))).toBeVisible();
    const opened = await collectFrames(win);
    expect(faded(opened, 'member'), 'Enter on the menu item').toBe(true);
    expect(verticalTravel(opened, 'member') > 4).toBe(!reduced);

    await startFrames(win, { member: chip(1), leaving }, 850);
    await win.locator(chip(1)).getByRole('button', { name: /^Close/ }).press('Enter');
    await expect(win.locator(chip(1))).toHaveCount(0);
    const closed = await collectFrames(win);
    expect(faded(closed, 'leaving'), 'Enter on the close button').toBe(true);
    expect(verticalTravel(closed, 'leaving') > 4).toBe(!reduced);

    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await startFrames(win, { member: chip(1) }, 850);
    await win.keyboard.press(`${modifier}+t`);
    await expect(win.locator(chip(1))).toBeVisible();
    const shortcut = await collectFrames(win);
    expect(faded(shortcut, 'member'), 'new-terminal shortcut').toBe(true);
    expect(verticalTravel(shortcut, 'member') > 4).toBe(!reduced);

    await startFrames(win, { leaving }, 850);
    await win.keyboard.press(`${modifier}+w`);
    await expect(win.locator(chip(1))).toHaveCount(0);
    const shortcutClose = await collectFrames(win);
    expect(faded(shortcutClose, 'leaving'), 'close-terminal shortcut').toBe(true);
    expect(verticalTravel(shortcutClose, 'leaving') > 4).toBe(!reduced);
  } finally {
    await app.close();
    cleanup();
  }
});
}

test('project switch and restoring or selecting a live chip do not animate membership', async () => {
  const { app, win, cleanup } = await launch(['alpha', 'beta']);
  try {
    await pick(win, 'alpha');
    await newShellTab(win, 'alpha');
    await pick(win, 'beta');
    await startFrames(win, { primary: chip(0), restored: chip(1), leaving }, 850);
    await pick(win, 'alpha');
    await expect(win.locator(chip(1))).toBeVisible();
    const restored = await collectFrames(win);
    for (const target of ['primary', 'restored']) {
      expect(faded(restored, target) || transformed(restored, target)).toBe(false);
    }
    expect(restored.some(f => f.s.leaving?.present)).toBe(false);
    await startFrames(win, { primary: chip(0), other: chip(1), leaving }, 850);
    await win.locator(chip(0)).click();
    const selected = await collectFrames(win);
    expect(transformed(selected, 'primary') || transformed(selected, 'other')).toBe(false);
    expect(selected.some(f => f.s.leaving?.present)).toBe(false);
  } finally {
    await app.close();
    cleanup();
  }
});

async function pinStartTimes(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const handlers: unknown = Reflect.get(ipcMain, '_invokeHandlers');
    if (!(handlers instanceof Map)) throw new Error('Missing Electron IPC handler map');
    const original: unknown = handlers.get('shells:alive-list');
    if (typeof original !== 'function') throw new Error('Missing alive-list handler');
    handlers.set('shells:alive-list', async (event: unknown, req: unknown) => {
      const result: { shells: Array<{ startedAt: string }> } = await original(event, req);
      for (const row of result.shells) row.startedAt = '2026-01-01 00:00:00';
      return result;
    });
  });
}

test('an inert departure stays separate from an immediate same-index, same-timestamp replacement', async () => {
  const { app, win, cleanup } = await launch();
  try {
    await pinStartTimes(app);
    await pick(win, 'alpha');
    await newShellTab(win, 'alpha');
    const id = await projectIdByName(win, 'alpha');
    await win.evaluate(({ active, leaving, projectId }) => {
      const old = document.querySelector(active);
      const observer = new MutationObserver(() => {
        const ghost = document.querySelector<HTMLElement>(leaving);
        if (!ghost) return;
        observer.disconnect();
        const button = ghost.querySelector('button');
        button?.focus();
        const before = { inert: ghost.inert, hidden: ghost.getAttribute('aria-hidden'), focusable: document.activeElement === button };
        for (const animation of ghost.getAnimations()) animation.pause();
        const api = Reflect.get(window, 'api');
        void api.invoke('shells:launch-plain', { projectId }).then(() => {
          const recordReplacement = () => {
            const fresh = document.querySelector(active);
            if (!fresh) return;
            replacement.disconnect();
            Reflect.set(window, 'reuse', { ...before, independent: old !== fresh && ghost !== fresh, overlapped: ghost.isConnected });
            for (const animation of ghost.getAnimations()) animation.play();
          };
          const replacement = new MutationObserver(recordReplacement);
          replacement.observe(document.body, { childList: true, subtree: true, attributes: true });
          recordReplacement();
        });
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    }, { active: chip(1), leaving, projectId: id });
    await win.locator(chip(1)).getByRole('button', { name: /^Close/ }).click();
    await expect.poll(() => win.evaluate(() => Reflect.get(window, 'reuse')), { timeout: 4000 })
      .toEqual({ inert: true, hidden: 'true', focusable: false, independent: true, overlapped: true });
    await expect(win.locator(chip(1)).getByRole('button', { name: /^Close/ })).toBeEnabled();
    await expect(win.locator(leaving)).toHaveCount(0);
  } finally {
    await app.close();
    cleanup();
  }
});

test('main tabs animate selection chrome without moving buttons or delaying aria-current', async () => {
  const { app, win, cleanup } = await launch();
  try {
    await pick(win, 'alpha');
    const row = win.getByTestId('main-tab-bar');
    const shell = row.getByRole('button', { name: 'Shell', exact: true });
    const files = row.getByRole('button', { name: 'Files', exact: true });
    const box = await files.boundingBox();
    const state = await files.evaluate(async button => {
      if (!(button instanceof HTMLButtonElement)) throw new Error('Missing Files button');
      button.click();
      await Promise.resolve();
      return {
        current: button.getAttribute('aria-current'),
        properties: button.getAnimations({ subtree: true }).flatMap(a => a instanceof CSSTransition ? [a.transitionProperty] : []),
      };
    });
    expect(state.current).toBe('page');
    expect(state.properties).toEqual(expect.arrayContaining(['opacity', 'transform']));
    await expect(shell).not.toHaveAttribute('aria-current');
    expect(await files.boundingBox()).toEqual(box);
  } finally {
    await app.close();
    cleanup();
  }
});
