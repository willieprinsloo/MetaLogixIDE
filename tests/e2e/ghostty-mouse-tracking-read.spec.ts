/**
 * Ghostty's MOUSE_TRACKING query writes a one-byte bool into a reused 4-byte scratch slot.
 * Reading the slot as an int32 picked up stale upper bytes, so a long-lived app could treat every
 * plain press as a mouse report and never select. These tests dirty the slot's upper bytes before
 * each read, exactly as a recycled allocation does, and require plain selection to still work.
 */
import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';
import { launchDropFixture, PROJECT, RIGHT } from './helpers/drop';
import { LEFT } from './helpers/split';
import { shellOutput } from './helpers/focus';

async function selectionText(host: Locator): Promise<string> {
  return host.locator('textarea').evaluate((input) => {
    const data = new DataTransfer();
    input.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }));
    return data.getData('text/plain');
  });
}

async function marker(win: Page, pane: string, host: Locator, shell: number, text: string) {
  await host.locator('.xterm-screen').click();
  await win.keyboard.type(`printf '\\033[2J\\033[H%s\\r\\n' '${text}'`);
  await win.keyboard.press('Enter');
  await expect.poll(() => shellOutput(win, PROJECT, shell)).toContain(text);
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
  const find = win.locator(pane).getByPlaceholder('Find…');
  await expect(find).toBeFocused();
  await find.fill(text);
  await find.press('Enter');
  const mark = host.locator('[data-terminal-find] span');
  await expect(mark).toBeVisible();
  const b = await mark.boundingBox();
  if (!b) throw new Error('Selection marker is not visible');
  await find.press('Escape');
  return { start: b.x + 1, end: b.x + b.width - 1, y: b.y + b.height / 2 };
}

/**
 * Sets a non-pausing breakpoint in the pointer controller that fills the tracking scratch slot with
 * stale upper bytes before every read. The condition counts each successful dirtying on
 * `globalThis.__trackingDirtied`; V8 swallows a throwing condition, so callers assert the count.
 */
async function dirtyTrackingScratch(cdp: CDPSession): Promise<void> {
  const scripts: Array<{ scriptId: string; url: string }> = [];
  cdp.on('Debugger.scriptParsed', (e) => scripts.push({ scriptId: e.scriptId, url: e.url }));
  await cdp.send('Debugger.enable');
  for (const { scriptId } of scripts) {
    const { scriptSource } = await cdp.send('Debugger.getScriptSource', { scriptId });
    if (!scriptSource.includes('read mouse tracking mode')) continue;
    const lines = scriptSource.split('\n');
    const line = lines.findIndex((l) => /tracking\(\w+\) \{/.test(l));
    if (line < 0) continue;
    const { actualLocation } = await cdp.send('Debugger.setBreakpoint', {
      location: { scriptId, lineNumber: line + 1, columnNumber: 0 },
      condition: '(this.scalar.view.setUint32(0, 0x00999900, true), globalThis.__trackingDirtied = (globalThis.__trackingDirtied || 0) + 1, false)',
    });
    expect(actualLocation.lineNumber, 'breakpoint resolves inside tracking()').toBe(line + 1);
    expect(lines[line + 1], 'tracking() body reads the scratch slot').toContain('read mouse tracking mode');
    return;
  }
  throw new Error('pointer controller tracking() not found in any loaded script');
}

for (const side of ['left', 'right'] as const) {
  test(`Ghostty plain drag selects in the ${side} split pane when the tracking scratch holds stale bytes`, async () => {
    const fixture = await launchDropFixture();
    const { win, app, left, right } = fixture;
    try {
      await win.evaluate(() => Reflect.get(window, 'api').invoke('settings:set', { key: 'terminal_engine', value: 'ghostty' }));
      await win.getByRole('button', { name: 'Files', exact: true }).click();
      await win.getByRole('button', { name: 'Shell', exact: true }).click();
      const pane = side === 'left' ? LEFT : RIGHT;
      const host = win.locator(pane).locator('[data-terminal-engine-host="ghostty"]');
      await expect(host).toBeVisible();
      const tag = `STALE-TRACKING-${side.toUpperCase()}`;
      const m = await marker(win, pane, host, side === 'left' ? left : right, tag);
      const cdp = await win.context().newCDPSession(win);
      await dirtyTrackingScratch(cdp);
      await win.mouse.move(m.start, m.y);
      await win.mouse.down();
      await win.mouse.move(m.end, m.y, { steps: 8 });
      await win.mouse.up();
      await expect.poll(() => selectionText(host), { message: 'plain drag selects despite stale scratch bytes' }).toBe(tag);
      const dirtied = await win.evaluate(() => Number(Reflect.get(globalThis, '__trackingDirtied') ?? 0));
      expect(dirtied, 'the stale bytes were planted before the reads under test').toBeGreaterThan(0);
      await win.mouse.click(m.start + 2, m.y + 60);
      await expect.poll(() => selectionText(host), { message: 'a plain click clears the drag selection' }).toBe('');
      await win.mouse.dblclick(m.start + 2, m.y);
      await expect.poll(async () => {
        const word = await selectionText(host);
        return word !== '' && tag.includes(word);
      }, { message: 'double-click selects part of the marker' }).toBe(true);
      await cdp.detach();
    } finally {
      await app.close();
      fixture.cleanup();
    }
  });
}
