import { expect, test, _electron as electron, type Locator } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { closeApp, guardedLaunch } from './helpers/claude-harness';

const fixture = [
  "const esc = '\\x1b[';",
  "const fill = (background) => {",
  "  const row = ' '.repeat(process.stdout.columns);",
  "  const frame = Array.from({ length: process.stdout.rows }, (_, i) => esc + (i + 1) + ';1H' + row).join('');",
  "  process.stdout.write(esc + '?7l' + esc + '48;' + background + 'm' + frame + esc + '0m' + esc + 'H');",
  "};",
  "process.stdout.write(esc + '?1049h' + esc + '?25l');",
  "let color = '2;19;57;91'; let active = true; fill(color);",
  "process.stdout.on('resize', () => { if (active) fill(color); });",
  "require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {",
  "  if (line === 'leave') { active = false; process.stdout.write(esc + '?1049l' + esc + '?7h' + esc + '?25h' + esc + '0m' + esc + '2J' + esc + 'H'); }",
  "  else if (active) { color = '5;162'; fill(color); }",
  '});',
  'process.stdin.resume();',
].join(' ');

async function terminalPixels(tab: Locator) {
  const png = (await tab.screenshot({ scale: 'css' })).toString('base64');
  return tab.page().evaluate(async (encoded) => {
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const { width, height } = image;
    const ctx = new OffscreenCanvas(width, height).getContext('2d');
    if (!ctx) throw new Error('Screenshot pixels unavailable');
    ctx.drawImage(image, 0, 0);
    image.close();
    function pixel(x: number, y: number): readonly [number, number, number] {
      const data = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
      return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
    }
    return {
      center: pixel(width / 2, height / 2),
      edges: [pixel(0, height / 2), pixel(width - 1, height / 2), pixel(width / 2, 0), pixel(width / 2, height - 1)],
    };
  }, png);
}

for (const engine of ['xterm', 'ghostty']) {
  test(`${engine} extends the full-screen app background to the terminal border`, async () => {
    let launch: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
      const win = await guardedLaunch(async (scope) => {
        const home = scope.tempDir('metaide-terminal-edge-home-');
        const root = scope.tempDir('metaide-terminal-edge-root-');
        mkdirSync(join(root, 'color-demo', '.git'), { recursive: true });
        launch = scope.own(await electron.launch({
          args: ['.', `--user-data-dir=${join(home, 'userData')}`],
          env: { ...process.env, HOME: home, METAIDE_TEST_MODE: '1', METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
            METAIDE_DEFAULT_LAUNCH_FIRST: JSON.stringify({ argv: ['node', '-e', fixture], env: {} }) },
        }));
        const win = await launch.firstWindow();
        await win.getByTestId('settings-open').waitFor();
        await win.evaluate(async ({ root, engine }) => {
          await window.api.invoke('settings:set', { key: 'terminal_engine', value: engine });
          await window.api.invoke('roots:add', { path: root });
        }, { root, engine });
        await win.getByTestId('project-row').filter({ hasText: 'color-demo' }).first().click();
        return win;
      });
      const tab = win.getByTestId('shell-tab').first();
      const terminal = tab.locator(`[data-terminal-engine="${engine}"]`);
      await expect(terminal).toBeVisible();
      async function expectFilled(color: 'blue' | 'red'): Promise<void> {
        await expect.poll(async () => {
          const colors = await terminalPixels(tab);
          const [r, g, b] = colors.center;
          const colorMatches = color === 'red' ? r - g > 30 && r - b > 30 : b - g > 20 && g - r > 20;
          if (!colorMatches) return 255;
          // CSS and WebGL can differ by 2 channel steps in macOS screenshot color conversion.
          const edgeDistances = colors.edges.map(([er, eg, eb]) => Math.max(Math.abs(er - r), Math.abs(eg - g), Math.abs(eb - b)));
          return Math.max(...edgeDistances);
        }, { message: `all four edges match the ${color} terminal fill` }).toBeLessThanOrEqual(2);
      }
      await expectFilled('blue');

      await win.getByTestId('settings-open').click();
      for (const axis of ['horizontal', 'vertical']) {
        const padding = win.getByRole('spinbutton', { name: `Terminal ${axis} padding` });
        await padding.fill('0');
        await padding.press('Enter');
      }
      await win.getByRole('button', { name: 'Close settings' }).click();
      await expect(tab).toHaveCSS('padding-bottom', '0px');
      await terminal.click();
      await win.keyboard.type('change');
      await win.keyboard.press('Enter');
      await expectFilled('red');

      await win.keyboard.type('leave');
      await win.keyboard.press('Enter');
      await expect(tab).not.toHaveAttribute('data-alt-screen', 'true');
      await expect(tab).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    } finally {
      if (launch) await closeApp(launch);
    }
  });
}
