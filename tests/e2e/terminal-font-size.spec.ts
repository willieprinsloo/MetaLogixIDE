import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FONT_COPY, FONT_TEST_IDS } from '../../src/renderer/fonts/font-contract';
import {
  terminalProbes,
  installResizeRecorder,
  resizeCalls,
  latestCallsByShell,
  installInvokeRecorder,
  invokeCalls,
  installFailingHandler,
  installDelayedGet,
  restoreHandler,
  type TermProbe,
} from './helpers/terminal-probe';

/**
 * Terminal font size setting (docs/specs/terminal-font-size.md, AC1-AC14).
 *
 * Authored against the Setup-contract commit (204a895): `FONT_TEST_IDS.terminalSizeInput` and
 * the `FONT_COPY.terminalSize*` strings in `src/renderer/fonts/font-contract.ts`, the IPC channel
 * `settings:set-terminal-font-size` in `src/shared/ipc-contract.ts`, and the `terminal_font_size`
 * settings key. The bounds/step/default (9, 28, 1, 14) and the legacy localStorage key name
 * (`metaide.shellFontSize`) are spec values (docs/specs/terminal-font-size.md), not read from
 * `src/shared/terminal-font-size.ts` — that module is Agent 1's, not part of the Setup contract,
 * and literal values here catch a regression in it the same way AC40 in fonts.spec.ts keeps
 * font-family copy literal.
 */

const PROJECT = 'terminal-size-e2e';
const E2E_TIMEOUT = 10_000;
const CHANNEL = 'settings:set-terminal-font-size';
const SETTING_KEY = 'terminal_font_size';
const LEGACY_KEY = 'metaide.shellFontSize';
const MIN = 9;
const MAX = 28;
const DEFAULT = 14;

type Api = { invoke: (channel: string, request: unknown) => Promise<unknown> };
type RendererWindow = Window & { api: Api };

interface Harness {
  app: ElectronApplication;
  win: Page;
  home: string;
  root: string;
  projectDir: string;
  close: (remove?: boolean) => Promise<void>;
}

function createFixture(): { home: string; root: string; projectDir: string } {
  const home = mkdtempSync(join(tmpdir(), 'metaide-termsize-home-'));
  const root = mkdtempSync(join(tmpdir(), 'metaide-termsize-root-'));
  const projectDir = join(root, PROJECT);
  mkdirSync(projectDir);
  mkdirSync(join(projectDir, '.git'));
  writeFileSync(join(projectDir, 'placeholder.txt'), 'terminal font size E2E fixture\n');
  return { home, root, projectDir };
}

async function launchHarness(
  fixture = createFixture(),
  options: { addRoot?: boolean } = {},
): Promise<Harness> {
  const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${join(fixture.home, 'userData')}`],
    env: {
      ...process.env,
      HOME: fixture.home,
      SHELL: '/bin/sh',
      METAIDE_TEST_MODE: '1',
      METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
      METAIDE_DEFAULT_LAUNCH_FIRST: JSON.stringify({ argv: ['node', mockClaude], env: {} }),
      METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: ['node', mockClaude, '--continue'], env: {} }),
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1400, 900));
  if (options.addRoot !== false) {
    await win.evaluate(async (path: string) => {
      const rendererWindow = window as unknown as RendererWindow;
      await rendererWindow.api.invoke('roots:add', { path });
    }, fixture.root);
  }
  return {
    app,
    win,
    ...fixture,
    close: async (remove = true) => {
      await app.close();
      if (remove) {
        rmSync(fixture.home, { recursive: true, force: true });
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  };
}

async function openProject(win: Page): Promise<void> {
  const project = win.getByTestId('project-row')
    .filter({ has: win.getByText(PROJECT, { exact: true }) })
    .first();
  await expect(project).toBeVisible({ timeout: E2E_TIMEOUT });
  await project.click();
  await expect(win.locator('[data-testid="shell-tab"] .xterm-screen')).toBeVisible({ timeout: E2E_TIMEOUT });
}

async function openSettings(win: Page): Promise<void> {
  await win.getByTestId('settings-open').click();
  await expect(win.getByTestId('settings-modal')).toBeVisible();
}

async function closeSettings(win: Page): Promise<void> {
  await win.getByTestId('settings-done').click();
  await expect(win.getByTestId('settings-modal')).toHaveCount(0);
}

function sizeInput(win: Page) {
  return win.getByTestId(FONT_TEST_IDS.terminalSizeInput);
}

async function storedSize(win: Page): Promise<number | null> {
  return win.evaluate(async (key: string) => {
    const rendererWindow = window as unknown as RendererWindow;
    const response = await rendererWindow.api.invoke('settings:get', { key }) as { value: number | null };
    return response.value;
  }, SETTING_KEY);
}

async function shellOutput(win: Page, shellIndex = 0): Promise<string> {
  return win.evaluate(async ({ projectName, index }) => {
    const rendererWindow = window as unknown as RendererWindow;
    const { shells } = await rendererWindow.api.invoke('shells:alive-list', undefined) as {
      shells: Array<{ projectId: number; projectName: string; shellIndex: number }>;
    };
    const shell = shells.find((entry) => entry.projectName === projectName && entry.shellIndex === index);
    if (!shell) return '';
    const snapshot = await rendererWindow.api.invoke('shells:snapshot', {
      projectId: shell.projectId,
      shellIndex: shell.shellIndex,
    }) as { output: string };
    return snapshot.output;
  }, { projectName: PROJECT, index: shellIndex });
}

function byKey(probes: TermProbe[], key: TermProbe['key']): TermProbe {
  const probe = probes.find((p) => p.key === key);
  if (!probe) throw new Error(`no terminal probe with key ${key}`);
  return probe;
}

test.describe.serial('terminal font size setting', () => {
  test('AC1, AC3, AC12: Settings shows the control below Terminal family, at the default, keyboard operable, and live-applies', async () => {
    const harness = await launchHarness();
    try {
      const { win } = harness;
      await openProject(win);

      // AC3: fresh install, no legacy value — default 14. The store's migration
      // (resolveStored -> save({ onlyIfUnset: true })) persists this the moment the
      // window's provider connects, before any UI interaction is possible, so by the
      // time the project has opened the stored value is already 14, not null.
      await expect.poll(() => storedSize(win), { timeout: E2E_TIMEOUT }).toBe(DEFAULT);
      const firstProbe = (await terminalProbes(win))[0];
      if (!firstProbe) throw new Error('terminal probe unavailable');
      expect(firstProbe.fontSize).toBe(DEFAULT);

      await openSettings(win);
      const input = sizeInput(win);
      // AC12: accessible name is exactly "Terminal font size".
      await expect(input).toHaveAccessibleName(FONT_COPY.terminalSizeLabel);
      expect(FONT_COPY.terminalSizeLabel).toBe('Terminal font size');
      await expect(input).toHaveAttribute('type', 'number');
      await expect(input).toHaveAttribute('min', String(MIN));
      await expect(input).toHaveAttribute('max', String(MAX));
      await expect(input).toHaveAttribute('step', '1');
      await expect(input).toHaveValue(String(DEFAULT));

      // AC1: directly after the Terminal family combobox, with the "px" unit visible.
      const terminalCombobox = win.getByRole('combobox', { name: 'Terminal', exact: true });
      const comboBox = await terminalCombobox.boundingBox();
      const inputBox = await input.boundingBox();
      if (!comboBox || !inputBox) throw new Error('font row geometry unavailable');
      expect(inputBox.y).toBeGreaterThan(comboBox.y);
      await expect(win.getByText(FONT_COPY.terminalSizeUnit, { exact: true })).toBeVisible();

      // AC1: exact hint text, on every platform (⌘ form unconditionally).
      await expect(win.getByText(FONT_COPY.terminalSizeHint, { exact: true })).toBeVisible();
      expect(FONT_COPY.terminalSizeHint).toBe('Every terminal uses this size. ⌘= / ⌘- / ⌘0 also change it.');

      // AC12: keyboard operable. ArrowUp from 14 -> 15, saved as typed (AC2), live-applied (AC4/AC5).
      await input.focus();
      await input.press('ArrowUp');
      await expect.poll(() => storedSize(win), { timeout: E2E_TIMEOUT }).toBe(15);
      await expect(input).toHaveValue('15');
      await expect.poll(async () => (await terminalProbes(win))[0]?.fontSize, { timeout: E2E_TIMEOUT }).toBe(15);
    } finally {
      await harness.close();
    }
  });

  test('AC2: commits on blur/Enter (not per keystroke), clamps out-of-range, invalid input reverts, arrows save immediately', async () => {
    const harness = await launchHarness();
    try {
      const { app, win } = harness;
      await openProject(win);
      await openSettings(win);
      const input = sizeInput(win);
      await expect(input).toHaveValue(String(DEFAULT));

      // Out-of-range whole number clamps to the nearest bound on blur.
      await input.fill('40');
      await input.blur();
      await expect.poll(() => storedSize(win), { timeout: E2E_TIMEOUT }).toBe(MAX);
      await expect(input).toHaveValue(String(MAX));

      // Positive control for the next two reverts: a genuine in-range change does save.
      await input.fill('20');
      await input.blur();
      await expect.poll(() => storedSize(win), { timeout: E2E_TIMEOUT }).toBe(20);

      // Empty input saves nothing and reverts to the last saved value.
      await input.fill('');
      await input.blur();
      await expect(input).toHaveValue('20');
      expect(await storedSize(win), 'empty input must not change the stored value').toBe(20);

      // A non-integer (16.5) saves nothing and reverts.
      await input.fill('16.5');
      await input.blur();
      await expect(input).toHaveValue('20');
      expect(await storedSize(win), 'a fractional value must not change the stored value').toBe(20);

      // Non-numeric input: `type="number"` means the DOM itself refuses to hold
      // non-numeric text (the HTML spec's value-sanitization algorithm forces it to
      // "" the moment a non-numeric string would be assigned, whether by keystroke or
      // script), so `locator.fill('abc')` throws rather than reaching the app at all
      // (confirmed: Playwright's own `locator.fill` check rejects it before dispatching
      // any event). The real-world equivalent is typing letters, which the browser
      // suppresses keystroke by keystroke — prove that, then that the empty result
      // still reverts (the same path as the empty-input case above).
      await input.fill('');
      await input.pressSequentially('abc');
      await expect(input, 'the browser itself blocks non-numeric characters in a number field').toHaveValue('');
      await input.blur();
      await expect(input).toHaveValue('20');
      expect(await storedSize(win), 'non-numeric input must not change the stored value').toBe(20);

      // Clamp also applies on Enter, at the other bound.
      await input.fill('0');
      await input.press('Enter');
      await expect.poll(() => storedSize(win), { timeout: E2E_TIMEOUT }).toBe(MIN);
      await expect(input).toHaveValue(String(MIN));

      // AC2 amendment (user ruling, Phase 7 gate): typed text saves nothing while
      // typing — only Arrow keys and the stepper buttons save immediately. Typing
      // "100" one key at a time must never record a save for the "1" or the "10"
      // it passes through on the way (which the old "in-range saves as typed" rule
      // would have done, briefly setting every terminal to 10).
      await installInvokeRecorder(app, CHANNEL);
      const baseline = (await invokeCalls(app, CHANNEL)).length;
      await input.focus();
      await input.fill('');
      await input.press('1');
      expect(await invokeCalls(app, CHANNEL), 'typing "1" does not save').toHaveLength(baseline);
      await input.press('0');
      expect(await invokeCalls(app, CHANNEL), 'typing "10" does not save').toHaveLength(baseline);
      await input.press('0');
      await expect(input).toHaveValue('100');
      expect(await invokeCalls(app, CHANNEL), 'typing "100" does not save').toHaveLength(baseline);

      // Blur now commits the typed value, clamped to the max — exactly one save call.
      await input.blur();
      await expect.poll(() => storedSize(win), { timeout: E2E_TIMEOUT }).toBe(MAX);
      await expect(input).toHaveValue(String(MAX));
      expect(await invokeCalls(app, CHANNEL), 'blur issues exactly one save').toHaveLength(baseline + 1);

      // Arrow keys still save immediately, with no blur or Enter needed.
      await input.focus();
      await input.press('ArrowDown');
      await expect.poll(() => storedSize(win), { timeout: E2E_TIMEOUT }).toBe(MAX - 1);
      await expect(input).toHaveValue(String(MAX - 1));
      expect(await invokeCalls(app, CHANNEL), 'ArrowDown saves immediately, with the field still focused').toHaveLength(baseline + 2);

      // The explicit stepper buttons save immediately too, and clamp (no-op) at a bound.
      const decreaseButton = win.getByRole('button', { name: 'Decrease terminal font size' });
      const increaseButton = win.getByRole('button', { name: 'Increase terminal font size' });
      await increaseButton.click();
      await expect.poll(() => storedSize(win), { timeout: E2E_TIMEOUT }).toBe(MAX);
      await expect(input).toHaveValue(String(MAX));
      expect(await invokeCalls(app, CHANNEL), 'the "+" button saves immediately').toHaveLength(baseline + 3);
      const callsAtMax = (await invokeCalls(app, CHANNEL)).length;
      await increaseButton.click();
      await expect.poll(async () => input.inputValue(), { message: 'the "+" button is a no-op at the max' }).toBe(String(MAX));
      expect(await invokeCalls(app, CHANNEL), 'no save call at the bound').toHaveLength(callsAtMax);
      expect(await storedSize(win)).toBe(MAX);

      await decreaseButton.click();
      await expect.poll(() => storedSize(win), { timeout: E2E_TIMEOUT }).toBe(MAX - 1);
      expect(await invokeCalls(app, CHANNEL), 'the "-" button saves immediately').toHaveLength(callsAtMax + 1);
    } finally {
      await harness.close();
    }
  });

  test('AC4, AC5, AC6: a Settings change live-applies, reflows and resizes every open and later-opened terminal', async () => {
    const harness = await launchHarness();
    try {
      const { app, win } = harness;
      await openProject(win);
      await win.getByTestId('tabbar-split').click();
      await expect(win.getByTestId('split-right').locator('.xterm')).toBeVisible({ timeout: E2E_TIMEOUT });
      const poppedShell = await win.evaluate(async (projectName) => {
        const rendererWindow = window as unknown as RendererWindow;
        const { projects } = await rendererWindow.api.invoke('projects:list', undefined) as {
          projects: Array<{ id: number; name: string }>;
        };
        const project = projects.find((p) => p.name === projectName);
        if (!project) throw new Error('project unavailable');
        const { shellIndex } = await rendererWindow.api.invoke('shells:launch-plain', { projectId: project.id }) as { shellIndex: number };
        return { projectId: project.id, shellIndex };
      }, PROJECT);
      const poppedIndex = poppedShell.shellIndex;
      const [popout] = await Promise.all([
        app.waitForEvent('window'),
        win.evaluate(async (request) => {
          const rendererWindow = window as unknown as RendererWindow;
          await rendererWindow.api.invoke('windows:popout-shell', request);
        }, poppedShell),
      ]);
      await popout.waitForLoadState('domcontentloaded');
      await expect(popout.locator('.xterm')).toBeVisible({ timeout: E2E_TIMEOUT });

      // The marker goes into the popped-out shell, not the main window's left pane:
      // the left pane (and the split's right pane, which inherits the harness's
      // METAIDE_DEFAULT_LAUNCH_SUBSEQUENT override) both run `scripts/mock-claude.mjs`,
      // whose own Ink-style full-screen redraw recomputes line-wrapping from
      // `process.stdout.columns` on SIGWINCH. That redraw has a latent off-by-one that
      // drops a character when the column count shrinks while a line is mid-edit — a
      // test-fixture bug, confirmed present even in the raw PTY snapshot (not an xterm.js
      // or app rendering artifact), and orthogonal to this feature. `shells:launch-plain`
      // (used for the popout below) bypasses the default launch command entirely, so its
      // PTY is a genuine login shell with plain kernel tty echo, immune to that redraw path.
      const marker = `term-size-${Date.now()}`;
      await popout.locator('.xterm').click();
      await popout.keyboard.type(marker);
      await expect.poll(() => shellOutput(win, poppedIndex), { timeout: E2E_TIMEOUT }).toContain(marker);

      const mainBefore = await terminalProbes(win);
      const popoutBefore = await terminalProbes(popout);
      expect(mainBefore).toHaveLength(2);
      expect(popoutBefore).toHaveLength(1);
      const colsBefore = byKey(mainBefore, 'left').cols;

      await installResizeRecorder(app);
      await openSettings(win);
      await sizeInput(win).fill('16');
      await sizeInput(win).blur();

      // AC4: live-applies to every open terminal in every window, same tokens throughout.
      await expect.poll(async () => (await terminalProbes(win)).map((p) => p.fontSize), { timeout: E2E_TIMEOUT }).toEqual([16, 16]);
      await expect.poll(async () => (await terminalProbes(popout))[0]?.fontSize, { timeout: E2E_TIMEOUT }).toBe(16);
      const mainAfter = await terminalProbes(win);
      const popoutAfter = await terminalProbes(popout);
      expect(mainAfter.map((p) => p.token)).toEqual(mainBefore.map((p) => p.token));
      expect(popoutAfter.map((p) => p.token)).toEqual(popoutBefore.map((p) => p.token));
      const popoutScreen = popoutAfter[0]?.screen ?? '';
      expect(popoutScreen.replace(/\s+/gu, '')).toContain(marker);
      expect(await shellOutput(win, poppedIndex), 'the PTY-level scrollback is untouched by the resize').toContain(marker);

      // AC5: the PTY was told about the new columns/rows, and columns shrank (bigger glyphs, same width).
      await expect.poll(() => resizeCalls(app), { timeout: E2E_TIMEOUT }).toHaveLength(3);
      const latest = latestCallsByShell(await resizeCalls(app));
      expect(latest.size).toBe(3);
      const rightIndex = [...latest.keys()].find((index) => index !== 0 && index !== poppedIndex);
      const leftAfter = byKey(mainAfter, 'left');
      const rightAfter = byKey(mainAfter, 'right');
      if (rightIndex === undefined) throw new Error('right-pane shell index not found among resize calls');
      expect(latest.get(0)).toMatchObject({ cols: leftAfter.cols, rows: leftAfter.rows });
      expect(latest.get(rightIndex)).toMatchObject({ cols: rightAfter.cols, rows: rightAfter.rows });
      expect(latest.get(poppedIndex)).toMatchObject({ cols: popoutAfter[0]?.cols, rows: popoutAfter[0]?.rows });
      expect(leftAfter.cols).toBeLessThan(colsBefore);

      await closeSettings(win);

      // AC6: a newly opened shell and a newly popped-out window open at the new size, not the old one.
      const launched = await win.evaluate(async (projectName) => {
        const rendererWindow = window as unknown as RendererWindow;
        const { projects } = await rendererWindow.api.invoke('projects:list', undefined) as {
          projects: Array<{ id: number; name: string }>;
        };
        const project = projects.find((p) => p.name === projectName);
        if (!project) throw new Error('project unavailable');
        const { shellIndex } = await rendererWindow.api.invoke('shells:launch-plain', { projectId: project.id }) as { shellIndex: number };
        return { projectId: project.id, shellIndex };
      }, PROJECT);
      const [secondPopout] = await Promise.all([
        app.waitForEvent('window'),
        win.evaluate(async (request) => {
          const rendererWindow = window as unknown as RendererWindow;
          await rendererWindow.api.invoke('windows:popout-shell', request);
        }, launched),
      ]);
      await secondPopout.waitForLoadState('domcontentloaded');
      await expect(secondPopout.locator('.xterm')).toBeVisible({ timeout: E2E_TIMEOUT });
      expect((await terminalProbes(secondPopout))[0]?.fontSize).toBe(16);
      await secondPopout.close();
    } finally {
      await harness.close();
    }
  });

  test('AC7: keyboard zoom changes the shared size everywhere, reflects into Settings, and is a no-op at a bound', async () => {
    const harness = await launchHarness();
    try {
      const { app, win } = harness;
      await openProject(win);
      await win.getByTestId('tabbar-split').click();
      await expect(win.getByTestId('split-right').locator('.xterm')).toBeVisible({ timeout: E2E_TIMEOUT });
      await openSettings(win);
      const input = sizeInput(win);
      await expect(input).toHaveValue(String(DEFAULT));
      await closeSettings(win);

      await installInvokeRecorder(app, CHANNEL);
      await win.locator('.split-left .xterm').click();
      await win.keyboard.press('Meta+=');
      await expect.poll(async () => (await terminalProbes(win)).map((p) => p.fontSize), { timeout: E2E_TIMEOUT }).toEqual([DEFAULT + 1, DEFAULT + 1]);

      // Reflected into Settings if open.
      await openSettings(win);
      await expect(sizeInput(win)).toHaveValue(String(DEFAULT + 1));
      await closeSettings(win);

      // Drive to the maximum, then one more: no-op, and no invoke at all is issued at the bound.
      for (let size = DEFAULT + 1; size < MAX; size += 1) {
        await win.locator('.split-left .xterm').click();
        await win.keyboard.press('Meta+=');
        await expect.poll(async () => (await terminalProbes(win))[0]?.fontSize, { timeout: E2E_TIMEOUT }).toBe(size + 1);
      }
      expect((await terminalProbes(win))[0]?.fontSize).toBe(MAX);
      const callsAtMax = (await invokeCalls(app, CHANNEL)).length;
      await win.locator('.split-left .xterm').click();
      await win.keyboard.press('Meta+=');
      await expect.poll(async () => (await terminalProbes(win)).map((p) => p.fontSize), { message: 'at the max, +1 is a no-op for every terminal' }).toEqual([MAX, MAX]);
      expect(await invokeCalls(app, CHANNEL), 'no save call is issued at the bound').toHaveLength(callsAtMax);
      expect(await storedSize(win)).toBe(MAX);

      // Same at the minimum.
      await win.keyboard.press('Meta+0');
      await expect.poll(async () => (await terminalProbes(win))[0]?.fontSize, { timeout: E2E_TIMEOUT }).toBe(DEFAULT);
      for (let size = DEFAULT; size > MIN; size -= 1) {
        await win.keyboard.press('Meta+-');
        await expect.poll(async () => (await terminalProbes(win))[0]?.fontSize, { timeout: E2E_TIMEOUT }).toBe(size - 1);
      }
      expect((await terminalProbes(win))[0]?.fontSize).toBe(MIN);
      const callsAtMin = (await invokeCalls(app, CHANNEL)).length;
      await win.keyboard.press('Meta+-');
      await expect.poll(async () => (await terminalProbes(win))[0]?.fontSize, { message: 'at the min, -1 is a no-op' }).toBe(MIN);
      expect(await invokeCalls(app, CHANNEL), 'no save call is issued at the bound').toHaveLength(callsAtMin);
      expect(await storedSize(win)).toBe(MIN);
    } finally {
      await harness.close();
    }
  });

  test('AC8: Meta+0 resets every terminal and Settings to the default', async () => {
    const harness = await launchHarness();
    try {
      const { win } = harness;
      await openProject(win);
      await win.getByTestId('tabbar-split').click();
      await expect(win.getByTestId('split-right').locator('.xterm')).toBeVisible({ timeout: E2E_TIMEOUT });
      await win.locator('.split-left .xterm').click();
      // Positive control: move away from the default first, so Meta+0 is observed to act.
      await win.keyboard.press('Meta+=');
      await win.keyboard.press('Meta+=');
      await expect.poll(async () => (await terminalProbes(win)).map((p) => p.fontSize), { timeout: E2E_TIMEOUT }).toEqual([DEFAULT + 2, DEFAULT + 2]);

      await win.keyboard.press('Meta+0');
      await expect.poll(async () => (await terminalProbes(win)).map((p) => p.fontSize), { timeout: E2E_TIMEOUT }).toEqual([DEFAULT, DEFAULT]);
      await openSettings(win);
      await expect(sizeInput(win)).toHaveValue(String(DEFAULT));
      expect(await storedSize(win)).toBe(DEFAULT);
    } finally {
      await harness.close();
    }
  });

  test('AC9, AC11: the size survives a restart and opens with no 14->saved jump; the dedicated setter rejects an invalid value', async () => {
    const fixture = createFixture();
    let harness = await launchHarness(fixture);
    try {
      await openProject(harness.win);
      await openSettings(harness.win);
      await sizeInput(harness.win).fill('19');
      await sizeInput(harness.win).blur();
      await expect.poll(() => storedSize(harness.win), { timeout: E2E_TIMEOUT }).toBe(19);
      await closeSettings(harness.win);
      await harness.close(false);

      harness = await launchHarness(fixture, { addRoot: false });
      expect(await storedSize(harness.win)).toBe(19);
      await openProject(harness.win);
      // Coarse sanity check (not the proof — see below): by the time a project can be
      // clicked through the UI, the store has long since loaded, so this alone cannot
      // go red for a dropped open-wait or a wrong constructor read.
      const firstProbe = (await terminalProbes(harness.win))[0];
      if (!firstProbe) throw new Error('terminal probe unavailable after restart');
      expect(firstProbe.fontSize, 'at most one font-size change between construction and open').toBe(19);

      // `shells:launch-plain` auto-picks the next unused shellIndex from the alive-shells
      // list; right after `openProject` the shellIndex-0 spawn can still be registering,
      // so wait for it to show up as alive before launching a second shell, or
      // `launch-plain` can race and try to reuse index 0 ("already spawned").
      await expect.poll(async () => harness.win.evaluate(async (projectName) => {
        const rendererWindow = window as unknown as RendererWindow;
        const { shells } = await rendererWindow.api.invoke('shells:alive-list', undefined) as {
          shells: Array<{ projectName: string; shellIndex: number }>;
        };
        return shells.some((entry) => entry.projectName === projectName && entry.shellIndex === 0);
      }, PROJECT), { timeout: E2E_TIMEOUT }).toBe(true);

      // AC11, made failable: delay the main process's `settings:get` reply for
      // `terminal_font_size`, then mount a brand-new window (a popped-out shell)
      // whose TerminalFontSizeProvider has to load the size from scratch. The delay
      // is installed on the main process *before* that window exists, so — unlike
      // seeding localStorage ahead of a renderer's first paint (AC10, which loses
      // that race) — there is no race here: the handler swap happens entirely
      // inside the main process, independent of the new window's renderer. This is
      // what goes red if the open-wait (`&& fontSizeReadyRef.current`,
      // ShellTab.tsx:263) is dropped — the terminal would open immediately, before
      // the delay resolves, at the unready default (14). A constructor that read a
      // literal 14 instead of `fontSizeRef.current` would not go red: the mount-time
      // live-apply effect sets the size before open (an equivalent mutant).
      // Checks the FIRST resize recorded for this specific shell, not the latest
      // (`latestCallsByShell` would hide either bug once the live-apply effect
      // eventually corrects the value).
      await installResizeRecorder(harness.app);
      await installDelayedGet(harness.app, SETTING_KEY, 1500);
      const poppedShell = await harness.win.evaluate(async (projectName) => {
        const rendererWindow = window as unknown as RendererWindow;
        const { projects } = await rendererWindow.api.invoke('projects:list', undefined) as {
          projects: Array<{ id: number; name: string }>;
        };
        const project = projects.find((p) => p.name === projectName);
        if (!project) throw new Error('project unavailable');
        const { shellIndex } = await rendererWindow.api.invoke('shells:launch-plain', { projectId: project.id }) as { shellIndex: number };
        return { projectId: project.id, shellIndex };
      }, PROJECT);
      const poppedIndex = poppedShell.shellIndex;
      const openedAt = Date.now();
      const [popout] = await Promise.all([
        harness.app.waitForEvent('window'),
        harness.win.evaluate(async (request) => {
          const rendererWindow = window as unknown as RendererWindow;
          await rendererWindow.api.invoke('windows:popout-shell', request);
        }, poppedShell),
      ]);
      await popout.waitForLoadState('domcontentloaded');

      // Still well inside the delay: the terminal must not have opened yet — no
      // `.xterm` in the DOM, no resize recorded for this shell. Proves the wait
      // actually holds off, rather than happening to not matter.
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      expect(await popout.locator('.xterm').count(), 'the terminal must not open before the store is ready').toBe(0);
      expect(
        (await resizeCalls(harness.app)).some((call) => call.shellIndex === poppedIndex),
        'no resize for this shell before the store is ready',
      ).toBe(false);

      await expect(popout.locator('.xterm')).toBeVisible({ timeout: E2E_TIMEOUT });
      expect(Date.now() - openedAt, 'the terminal only opened once the delayed load resolved').toBeGreaterThanOrEqual(1500);
      const popoutProbe = (await terminalProbes(popout))[0];
      if (!popoutProbe) throw new Error('popout terminal probe unavailable');
      expect(popoutProbe.fontSize, 'the first probe already matches the saved size, no 14->19 jump').toBe(19);
      const firstPoppedResize = (await resizeCalls(harness.app)).find((call) => call.shellIndex === poppedIndex);
      if (!firstPoppedResize) throw new Error('no resize recorded for the popped-out shell');
      expect(firstPoppedResize, 'the first resize for this shell already matches a 19px fit').toMatchObject({ cols: popoutProbe.cols, rows: popoutProbe.rows });
      await restoreHandler(harness.app, 'settings:get');
      await popout.close();

      // AC9: the dedicated setter rejects an out-of-range value and leaves the stored value unchanged.
      await expect(harness.win.evaluate(async () => {
        const rendererWindow = window as unknown as RendererWindow;
        await rendererWindow.api.invoke('settings:set-terminal-font-size', { value: 30 });
      })).rejects.toThrow();
      expect(await storedSize(harness.win)).toBe(19);

      // AC9: the generic settings:set channel rejects the key too, so validation cannot be bypassed.
      await expect(harness.win.evaluate(async () => {
        const rendererWindow = window as unknown as RendererWindow;
        await rendererWindow.api.invoke('settings:set', { key: 'terminal_font_size', value: 22 });
      })).rejects.toThrow();
      expect(await storedSize(harness.win)).toBe(19);
    } finally {
      await harness.close();
    }
  });

  test('AC10: migration runs at most once — a legacy value written after the size is already stored is never re-read', async () => {
    // Phase 5 finding (see the report): seeding `metaide.shellFontSize` before this
    // window's first-ever load is not reachable from outside the app. Playwright's
    // Electron `Page` for the main window only becomes available after that window's
    // first navigation has already committed (confirmed by instrumentation: a key set
    // via `addInitScript` still read back as `null` after the window had finished
    // loading), and the store's migration read runs inside a `useEffect` on that same
    // first render, so there is no external hook point before it. By the time any test
    // code can run at all, `terminal_font_size` is already non-null (the store already
    // persisted the no-legacy-found default, 14) — which is itself the fixture this
    // test needs: AC10's "already-saved size is never overwritten by migration" rule
    // is exactly as observable starting from the natural default as it would be
    // starting from an adopted legacy value. The "legacy value adopted" half of AC10
    // rests on Agent 1's `migratedTerminalFontSize` unit test and Agent 2's store test
    // (both already enumerated in the plan's checklist and already green), which inject
    // `loadStored`/`readLegacy` fakes directly and don't need a real window boot.
    const harness = await launchHarness();
    try {
      const { win } = harness;
      await openProject(win);
      await expect.poll(() => storedSize(win), { timeout: E2E_TIMEOUT }).toBe(DEFAULT);

      // A legacy value written after the size is already stored is never read: migration ran at most once.
      await win.evaluate((args: [string, string]) => window.localStorage.setItem(args[0], args[1]), [LEGACY_KEY, '22'] as [string, string]);
      await win.reload();
      await win.waitForLoadState('domcontentloaded');
      await openProject(win);
      expect(await storedSize(win), 'migration does not run again once a size is stored').toBe(DEFAULT);
      expect((await terminalProbes(win))[0]?.fontSize).toBe(DEFAULT);
    } finally {
      await harness.close();
    }
  });

  test('AC14: a failed save reverts Settings and every terminal to the stored value and shows an error toast', async () => {
    const harness = await launchHarness();
    try {
      const { app, win } = harness;
      await openProject(win);
      await win.getByTestId('tabbar-split').click();
      await expect(win.getByTestId('split-right').locator('.xterm')).toBeVisible({ timeout: E2E_TIMEOUT });
      // The store's migration already persisted the default by the time the window
      // finished connecting (same mechanism as AC1/AC3 above): the stored value is
      // 14 here, not null.
      await expect.poll(() => storedSize(win), { timeout: E2E_TIMEOUT }).toBe(DEFAULT);
      await expect.poll(async () => (await terminalProbes(win)).map((p) => p.fontSize)).toEqual([DEFAULT, DEFAULT]);

      await installFailingHandler(app, CHANNEL, 'injected terminal font size save failure');
      await installInvokeRecorder(app, CHANNEL);
      try {
        // Gate blocking finding 1: a save that fails WHILE THE FIELD STILL HAS FOCUS
        // must revert immediately (not just on blur), and blurring the now-reverted
        // field afterward must not resubmit the stale value (the regression: a
        // second failing save, a second toast). Under the AC2 amendment, Enter
        // commits without moving focus, so it is the reachable way to fail a save
        // while the field is still focused.
        await openSettings(win);
        const input = sizeInput(win);
        await input.fill('16');
        await input.press('Enter');
        await expect(win.getByTestId('toast').filter({ hasText: FONT_COPY.terminalSizeSaveFailed }).first(), 'positive control: the failure toast appeared').toBeVisible({ timeout: E2E_TIMEOUT });
        await expect(input, 'input state: the field is still focused after Enter').toBeFocused();
        await expect(input, 'the field reverts to the stored value while still focused').toHaveValue(String(DEFAULT));
        await expect.poll(async () => (await terminalProbes(win)).map((p) => p.fontSize), { message: 'every terminal reverts to the stored value' }).toEqual([DEFAULT, DEFAULT]);
        expect(await storedSize(win), 'the stored value is unchanged').toBe(DEFAULT);
        expect(await invokeCalls(app, CHANNEL), 'exactly one save call while the field was focused').toHaveLength(1);

        // Blurring the already-reverted field must not resubmit it: still 1 call, still 1 toast.
        await input.blur();
        expect(await invokeCalls(app, CHANNEL), 'blur after a focused failure issues no further save').toHaveLength(1);
        expect(await win.getByTestId('toast').filter({ hasText: FONT_COPY.terminalSizeSaveFailed }), 'still exactly one failure toast').toHaveCount(1);
        await closeSettings(win);

        // From keyboard zoom: same outcome.
        const callsBeforeZoom = (await invokeCalls(app, CHANNEL)).length;
        await win.locator('.split-left .xterm').click();
        await win.keyboard.press('Meta+=');
        await expect(win.getByTestId('toast').filter({ hasText: FONT_COPY.terminalSizeSaveFailed }).last(), 'zoom failure also toasts').toBeVisible({ timeout: E2E_TIMEOUT });
        await expect.poll(async () => (await terminalProbes(win)).map((p) => p.fontSize), { message: 'zoom reverts every terminal too' }).toEqual([DEFAULT, DEFAULT]);
        expect(await storedSize(win), 'the stored value is still unchanged').toBe(DEFAULT);
        expect(await invokeCalls(app, CHANNEL), 'zoom issues exactly one more save call').toHaveLength(callsBeforeZoom + 1);
      } finally {
        await restoreHandler(app, CHANNEL);
      }

      // Positive control: with the real handler restored, the same action now succeeds.
      await win.keyboard.press('Meta+=');
      await expect.poll(() => storedSize(win), { timeout: E2E_TIMEOUT }).toBe(DEFAULT + 1);
    } finally {
      await harness.close();
    }
  });
});
