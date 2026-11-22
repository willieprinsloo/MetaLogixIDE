import { expect, test, type Page } from '@playwright/test';
import { launch, newShellTab, projectIdByName, projectRow, rememberedState, waitForProjectShown, waitForShellOutput } from './helpers/focus';
import { collectFrames, startFrames } from './helpers/frames';

const chip = (index: number) => `[data-testid="shell-tab-button"][data-shell-index="${index}"]`;
const primary = '.split-left';
const primaryHost = `${primary} [data-terminal-engine]`;

async function openProject(win: Page): Promise<void> {
  await projectRow(win, 'alpha').click();
  await waitForProjectShown(win, 'alpha');
  await expect(win.locator(chip(0))).toBeVisible();
}

test('workspace tabs use icons and show labels when hovered or keyboard focused', async () => {
  const { app, win, cleanup } = await launch();
  try {
    await openProject(win);
    const row = win.getByTestId('main-tab-bar');
    const shell = row.getByRole('button', { name: 'Shell', exact: true });
    const files = row.getByRole('button', { name: 'Files', exact: true });
    for (const name of ['Shell', 'Files', 'Diff', 'Settings', 'Activity']) {
      const button = row.getByRole('button', { name: new RegExp(`^${name}(?:$|[, (])`) });
      await expect(button).toBeVisible();
      await expect(button.locator('svg')).toBeVisible();
      await expect(button.getByText(name, { exact: true })).toHaveCount(0);
    }
    // Drive renderer hover directly so the physical macOS pointer cannot steal it between test windows.
    await shell.dispatchEvent('mouseover');
    await expect(win.getByRole('tooltip').filter({ hasText: 'Shell' })).toBeVisible();
    await shell.dispatchEvent('mouseout');
    await shell.focus();
    await win.keyboard.press('Tab');
    await expect(files).toBeFocused();
    await expect(win.getByRole('tooltip').filter({ hasText: 'Files' })).toBeVisible();
    await win.keyboard.press('Enter');
    await expect(files).toHaveAttribute('aria-current', 'page');
  } finally {
    await app.close();
    cleanup();
  }
});

test('the workspace toolbar sits above the main sheet, with an icon-only Board and no session badge', async () => {
  const { app, win, cleanup } = await launch();
  try {
    await openProject(win);
    const bar = win.getByTestId('main-tab-bar');
    const main = win.getByRole('main');
    await expect.soft(main.getByTestId('main-tab-bar')).toHaveCount(0, { timeout: 1000 });
    const [header, sheet, column] = await Promise.all([bar, main, win.getByTestId('main-column')].map(el => el.boundingBox()));
    if (!header || !sheet || !column) throw new Error('Missing workspace region');
    expect.soft(header.y + header.height).toBeLessThanOrEqual(sheet.y);
    expect(header.x).toBeCloseTo(column.x, 0);
    expect(header.width).toBeCloseTo(column.width, 0);
    await expect.soft(bar.getByText('alpha', { exact: true })).toHaveCount(0, { timeout: 1000 });
    await expect.soft(bar.getByRole('button', { name: 'Unload session (close shell)' })).toHaveCount(0, { timeout: 1000 });
    await expect(win.getByTestId('status-bar').getByText('alpha', { exact: true })).toBeVisible();
    await expect(win.getByTestId('section-in-use').getByTestId('row-unload')).toBeAttached();

    const board = bar.getByTestId('metaproject-board');
    await expect.soft(board).toHaveText('', { timeout: 1000 });
    await expect(board.locator('svg')).toBeVisible();
    await expect(board).toHaveAccessibleName('Link project board');
    // Desktop tab order reaches Board from the terminal strip on wide layouts.
    await bar.getByTestId('tabbar-new-shell').focus();
    await win.keyboard.press('Tab');
    await expect(board).toBeFocused();
    await expect(win.getByRole('tooltip').filter({ hasText: 'Link project board' })).toBeVisible();
    await board.click();
    await expect(win.locator('[data-view="chat"]')).toBeVisible();
  } finally {
    await app.close();
    cleanup();
  }
});

test('terminal tabs stay centered on one row at wide and medium widths, then wrap in a narrow window', async () => {
  const { app, win, cleanup } = await launch();
  try {
    await openProject(win);
    const header = win.getByTestId('main-tab-bar');
    const shell = header.getByRole('button', { name: 'Shell', exact: true });
    const projectControl = win.getByTestId('reveal-project-folder');
    const plus = win.getByTestId('tabbar-new-shell');
    const split = win.getByTestId('tabbar-split');
    const first = win.locator(chip(0));
    const resize = async (width: number) => {
      await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0]?.setContentSize(w, 800), width);
      await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(width);
    };
    const midY = (b: { y: number; height: number }) => b.y + b.height / 2;
    for (const width of [1400, 1024]) {
      await resize(width);
      const [bar, icon, chipBox, add, right] = await Promise.all([header, shell, first, plus, projectControl].map(el => el.boundingBox()));
      if (!bar || !icon || !chipBox || !add || !right) throw new Error('Missing top bar control');
      expect(midY(chipBox), `${width}px: terminal and workspace controls share one row`).toBeCloseTo(midY(icon), 0);
      expect(midY(chipBox)).toBeCloseTo(midY(right), 0);
      expect((chipBox.x + add.x + add.width) / 2).toBeCloseTo(bar.x + bar.width / 2, 0);
      expect(icon.x + icon.width).toBeLessThan(chipBox.x);
      expect(add.x + add.width).toBeLessThan(right.x);
    }

    await resize(900);
    const [narrowIcon, narrowChip] = await Promise.all([shell.boundingBox(), first.boundingBox()]);
    if (!narrowIcon || !narrowChip) throw new Error('Missing narrow bar control');
    expect(narrowChip.y).toBeGreaterThan(narrowIcon.y + narrowIcon.height);
    const [narrowSplit, popout] = await Promise.all([split.boundingBox(), win.getByTestId('popout-shell').boundingBox()]);
    if (!narrowSplit || !popout) throw new Error('Missing pane controls');
    expect(midY(narrowSplit)).toBeCloseTo(midY(popout), 0);
    expect(narrowSplit.x + narrowSplit.width).toBeLessThan(popout.x);
    expect(midY(narrowSplit)).toBeLessThan(narrowChip.y);

    // Keep the menu usable when the tabs overflow and the Add button is near the right edge.
    for (let i = 1; i <= 3; i++) {
      await win.keyboard.press(process.platform === 'darwin' ? 'Meta+t' : 'Control+t');
      await expect(win.locator(chip(i))).toBeAttached();
    }
    const name = 'Terminal profile with a long name for testing a crowded terminal tab strip';
    await win.evaluate(name => Reflect.get(window, 'api').invoke('settings:set', {
      key: 'default_cli_profiles', value: [{ name, argv: ['/bin/sh', '-i'] }],
    }), name);
    await plus.click();
    const menu = win.locator('[data-new-shell-menu="1"]');
    await menu.getByRole('button', { name, exact: true }).click();
    await expect(win.locator(chip(4))).toBeAttached();
    expect(await first.evaluate(el => !!el.parentElement && el.parentElement.scrollWidth > el.parentElement.clientWidth)).toBe(true);
    await plus.click();
    await menu.getByRole('button', { name: 'Add a custom command…' }).click();
    const [bounds, panel] = await Promise.all([header.boundingBox(), menu.boundingBox()]);
    if (!bounds || !panel) throw new Error('Missing custom command menu');
    expect(panel.x).toBeGreaterThanOrEqual(bounds.x);
    expect(panel.x + panel.width).toBeLessThanOrEqual(bounds.x + bounds.width + 0.5);
    const command = menu.getByPlaceholder(/^Command,/);
    await command.click();
    await expect(command).toBeFocused();

    await win.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await resize(1024);
    const [mediumIcon, mediumAdd, mediumSplit] = await Promise.all([shell, plus, split].map(el => el.boundingBox()));
    if (!mediumIcon || !mediumAdd || !mediumSplit) throw new Error('Missing medium-width top bar control');
    expect(midY(mediumAdd)).toBeCloseTo(midY(mediumIcon), 0);
    expect(midY(mediumAdd)).toBeCloseTo(midY(mediumSplit), 0);
    expect(await first.evaluate(el => !!el.parentElement && el.parentElement.scrollWidth > el.parentElement.clientWidth)).toBe(true);
    await plus.click();
    await expect(menu.getByRole('button', { name: 'Add a custom command…' })).toBeVisible();
  } finally {
    await app.close();
    cleanup();
  }
});

test('switching terminal tabs neither dims nor moves the terminal or remounts the right split', async () => {
  const { app, win, cleanup } = await launch();
  try {
    await openProject(win);
    const second = await newShellTab(win, 'alpha');
    await win.getByTestId('tabbar-split').click();
    const right = win.getByTestId('split-right').locator('[data-terminal-engine="xterm"]');
    await expect(right).toBeVisible();
    const rightHost = await right.elementHandle();
    const host = win.locator(primaryHost);
    await expect(host).toHaveCSS('opacity', '1');
    // Opening the right pane itself folds; wait for that independent effect to settle.
    await right.click({ trial: true });
    for (const index of [0, second]) {
      const oldHost = await host.elementHandle();
      const before = await right.boundingBox();
      await startFrames(win, {
        host: `${primaryHost}:not([style*="visibility: hidden"])`, body: `${primaryHost}^`,
        outgoing: `${primary} :active-view-transition`, right: '[data-testid="split-right"] [data-terminal-engine]',
      }, 500);
      await win.locator(chip(index)).click();
      await expect(host).toBeVisible();
      expect(await oldHost?.evaluate(el => el.isConnected)).toBe(false);
      const frames = await collectFrames(win);
      const visible = frames.filter(({ s }) => s.host.present);
      const rest = visible.at(-1);
      if (!rest) throw new Error('No visible terminal frames');
      const base = rest.s.host.x - rest.s.body.x;
      const minOpacity = Math.min(...visible.map(({ s }) => s.host.opacity));
      const travel = Math.max(...visible.map(({ s }) => Math.abs(s.host.x - s.body.x - base)));
      expect.soft(minOpacity, 'every visible frame is fully opaque').toBe(1);
      expect.soft(travel, 'terminal content stays in place').toBeLessThan(1);
      expect(frames.every(({ s }) => !s.outgoing.present && s.host.count <= 1)).toBe(true);
      expect(await right.boundingBox()).toEqual(before);
      expect(frames.every(({ s }) => before && s.right.x === before.x && s.right.w === before.width)).toBe(true);
    }
    expect(await rightHost?.evaluate(el => el.isConnected && el.getAnimations({ subtree: true }).length === 0)).toBe(true);
    await expect(host).toHaveCount(1);
  } finally {
    await app.close();
    cleanup();
  }
});

for (const engine of ['xterm', 'ghostty']) test(`${engine}: fast tab navigation keeps the newest terminal clickable and focused`, async () => {
  const { app, win, cleanup } = await launch();
  try {
    await win.evaluate(value => Reflect.get(window, 'api').invoke('settings:set', { key: 'terminal_engine', value }), engine);
    await openProject(win);
    const second = await newShellTab(win, 'alpha');
    const host = win.locator(`${primaryHost}[data-terminal-engine="${engine}"]`);
    await expect(host).toBeVisible();
    const previous = await host.elementHandle();
    await win.locator(chip(0)).click();
    await win.locator(chip(second)).click();
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+t' : 'Control+t');
    await expect(win.locator(chip(2))).toBeVisible();
    const input = host.locator('textarea:visible');
    await expect(input).toBeFocused();
    await expect(host).toHaveCSS('opacity', '1');
    expect(await previous?.evaluate(el => !el.isConnected && el.getAnimations().length === 0)).toBe(true);
    await host.locator(engine === 'ghostty' ? '[data-terminal-engine-host="ghostty"] .xterm-screen' : '.xterm-screen').click();
    await expect(input).toBeFocused();
    await win.keyboard.type("printf 'TAB-SWITCH-%s\\n' 'INPUT'");
    await win.keyboard.press('Enter');
    await waitForShellOutput(win, 'alpha', 2, 'TAB-SWITCH-INPUT');

    if (engine === 'ghostty') {
      const canvas = host.locator('[data-terminal-engine-host="ghostty"] canvas').first();
      await canvas.dispatchEvent('webglcontextlost');
      const fallback = win.locator(`${primaryHost}[data-terminal-engine="fallback"]`);
      await expect(fallback.locator('textarea')).toBeFocused();
      await expect(fallback).toHaveCSS('opacity', '1');
    }

    const close = win.locator(chip(2)).getByRole('button', { name: /close/i });
    await close.click();
    await expect(win.locator(chip(2))).toHaveCount(0);
    const project = await projectIdByName(win, 'alpha');
    await expect.poll(async () => (await rememberedState(win, project))?.activeShellIndex).toBe(0);
    await expect(host).toBeVisible();
    await expect(host).toHaveCSS('opacity', '1');
  } finally {
    await app.close();
    cleanup();
  }
});
