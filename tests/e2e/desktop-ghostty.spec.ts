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
