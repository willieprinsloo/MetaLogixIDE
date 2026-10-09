import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import electronBinaryPath from 'electron';
import { FONT_COPY, FONT_TEST_IDS, TERMINAL_FONT_WEIGHT_NAMES } from '../../src/renderer/fonts/font-contract';
import {
  TERMINAL_FONT_WEIGHTS,
  derivedBoldWeight,
  boldWeightChoices,
  type TerminalFontWeight,
} from '../../src/shared/terminal-font-weight';
import {
  terminalProbes,
  installInvokeRecorder,
  invokeCalls,
  installFailingHandler,
  installDelayedGet,
  restoreHandler,
} from './helpers/terminal-probe';

/**
 * Terminal font weight + bold weight settings (docs/specs/terminal-font-weight.md, AC1-AC14,
 * Phase 4 amendment: bold is now its own setting, no longer purely derived).
 *
 * Authored against the Phase 4 contract commit (7906b2f): `TERMINAL_FONT_WEIGHT_KEY`,
 * `TERMINAL_BOLD_WEIGHT_KEY`, `TERMINAL_FONT_WEIGHT_DEFAULT` (400), `TERMINAL_BOLD_WEIGHT_DEFAULT`
 * (700), `derivedBoldWeight` (= min(W + 200, 900)), `isValidBoldWeight`, `boldWeightChoices` and
 * `resolveTerminalWeights` in `src/shared/terminal-font-weight.ts`; the two IPC channels
 * `settings:set-terminal-font-weight` (writes both keys, returns `{weight, boldWeight,
 * changedKeys}`) and `settings:set-terminal-bold-weight` (writes only the bold key, returns
 * `{value, changed}`) in `src/shared/ipc-contract.ts`; and `FONT_TEST_IDS.terminalWeightSelect` /
 * `.terminalBoldSelect`, `FONT_COPY.terminalWeightHint` / `.terminalBoldLabel` /
 * `.terminalBoldHint` / `.terminalBoldSaveFailed` in `src/renderer/fonts/font-contract.ts`. At
 * authoring time the main-process handlers are still stubs and `TerminalBoldWeightControl` does
 * not exist yet (dev-main/dev-ui are mid-flight on the shared tree) — this suite is written
 * strictly against that settled contract and the plan's §7 "e2e" delta checklist, mirroring
 * `terminal-font-size.spec.ts`'s harness and probing conventions.
 */

const PROJECT = 'terminal-weight-e2e';
const E2E_TIMEOUT = 10_000;
const WEIGHT_CHANNEL = 'settings:set-terminal-font-weight';
const BOLD_CHANNEL = 'settings:set-terminal-bold-weight';
const WEIGHT_KEY = 'terminal_font_weight';
const BOLD_KEY = 'terminal_bold_weight';
const DEFAULT = 400;
const DEFAULT_BOLD = 700;

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
  const home = mkdtempSync(join(tmpdir(), 'metaide-termweight-home-'));
  const root = mkdtempSync(join(tmpdir(), 'metaide-termweight-root-'));
  const projectDir = join(root, PROJECT);
  mkdirSync(projectDir);
  mkdirSync(join(projectDir, '.git'));
  writeFileSync(join(projectDir, 'placeholder.txt'), 'terminal font weight E2E fixture\n');
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

function weightSelect(win: Page) {
  return win.getByTestId(FONT_TEST_IDS.terminalWeightSelect);
}

function boldSelect(win: Page) {
  return win.getByTestId(FONT_TEST_IDS.terminalBoldSelect);
}

async function storedValue(win: Page, key: string): Promise<number | null> {
  return win.evaluate(async (k: string) => {
    const rendererWindow = window as unknown as RendererWindow;
    const response = await rendererWindow.api.invoke('settings:get', { key: k }) as { value: number | null };
    return response.value;
  }, key);
}

async function storedWeight(win: Page): Promise<number | null> {
  return storedValue(win, WEIGHT_KEY);
}

async function storedBold(win: Page): Promise<number | null> {
  return storedValue(win, BOLD_KEY);
}

/**
 * Forces the WebGL addon's context to be lost so `webgl.onContextLoss` disposes it
 * (ShellTab.tsx), which — per the plan's scout research (addon-webgl's dispose
 * disposable calling `_renderService.setRenderer(_createRenderer())`) — makes xterm
 * fall back to its default DOM renderer. Finds the live WebGL context the same way a
 * real driver crash would surface it: by asking each canvas inside the xterm node for
 * its *already-created* context (`getContext` is idempotent per canvas/type and does
 * not create a new one), not by creating a fresh context of our own.
 *
 * Confirmed by a throwaway debug spec against the real addon (@xterm/addon-webgl
 * 0.18.0): the addon's own `webglcontextlost` listener waits a fixed 3000ms (in case
 * the browser restores the context on its own) before firing `onContextLoss` and
 * disposing — `.xterm-rows` does not exist until that timer fires. Callers must poll
 * for `.xterm-rows` to appear rather than assume disposal is synchronous with
 * `loseContext()`.
 */
async function loseWebglContext(win: Page): Promise<boolean> {
  return win.evaluate(() => {
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>('.xterm canvas')];
    for (const canvas of canvases) {
      const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
      const ext = gl?.getExtension('WEBGL_lose_context');
      if (ext) {
        ext.loseContext();
        return true;
      }
    }
    return false;
  });
}

/**
 * Writes raw bytes straight to the first visible xterm's own `Terminal.write`, found the
 * same way `terminalProbes` finds it (walk the React fiber for the hook ref holding the
 * live Terminal instance), bypassing the PTY entirely. Used only to get real SGR-bold text
 * onto the screen for the bold-weight repaint assertion below: the default project shell
 * runs the mock Claude CLI (scripts/mock-claude.mjs), which just echoes whatever is typed
 * as a literal line rather than interpreting `printf`'s escape sequences, so there is no
 * reachable way to get a real `\x1b[1m`...`\x1b[0m` bold run onto the screen by typing.
 */
async function writeRawToTerminal(win: Page, raw: string): Promise<void> {
  await win.evaluate((text) => {
    type Hook = { memoizedState: unknown; next: Hook | null };
    type Fiber = { tag: number; memoizedState: unknown; return: Fiber | null };
    type Term = { write: (data: string, cb: () => void) => void };
    const isTerm = (value: unknown): value is Term => !!value && typeof value === 'object' && typeof (value as Partial<Term>).write === 'function';
    const node = [...document.querySelectorAll<HTMLElement>('.xterm')].find((n) => n.offsetParent !== null);
    if (!node) throw new Error('no visible xterm to write to');
    let element: HTMLElement | null = node;
    let fiber: Fiber | null = null;
    while (element && !fiber) {
      const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'));
      if (key) fiber = (element as unknown as Record<string, Fiber>)[key] ?? null;
      element = element.parentElement;
    }
    let term: Term | null = null;
    for (let current = fiber; current && !term; current = current.return) {
      if (current.tag !== 0) continue;
      for (let hook = current.memoizedState as Hook | null; hook; hook = hook.next) {
        const ref = hook.memoizedState as { current?: unknown } | null;
        if (ref && typeof ref === 'object' && 'current' in ref && isTerm(ref.current)) { term = ref.current; break; }
      }
    }
    if (!term) throw new Error('visible xterm has no discoverable Terminal ref');
    return new Promise<void>((resolve) => term!.write(text, resolve));
  }, raw);
}

test.describe.serial('terminal font weight + bold weight settings', () => {
  test('AC1, AC3, AC12: Settings shows both controls after Terminal font size, at the defaults, with the right options, exact hints and names, keyboard reachable', async () => {
    const harness = await launchHarness();
    try {
      const { win } = harness;
      await openProject(win);

      // AC3: nothing is written to the store just by launching the app.
      expect(await storedWeight(win)).toBeNull();
      expect(await storedBold(win)).toBeNull();
      const firstProbe = (await terminalProbes(win))[0];
      if (!firstProbe) throw new Error('terminal probe unavailable');
      expect(firstProbe.fontWeight).toBe(DEFAULT);
      expect(firstProbe.fontWeightBold).toBe(DEFAULT_BOLD);

      await openSettings(win);
      const wSelect = weightSelect(win);
      const bSelect = boldSelect(win);

      // AC12: accessible names.
      await expect(wSelect).toHaveAccessibleName(FONT_COPY.terminalWeightLabel);
      await expect(bSelect).toHaveAccessibleName(FONT_COPY.terminalBoldLabel);
      expect(FONT_COPY.terminalWeightLabel).toBe('Terminal font weight');
      expect(FONT_COPY.terminalBoldLabel).toBe('Terminal bold weight');
      await expect(wSelect).toHaveValue(String(DEFAULT));
      await expect(bSelect).toHaveValue(String(DEFAULT_BOLD));

      // AC1: the weight control has exactly nine options, in order, each "Name (W)".
      const wOptions = wSelect.locator('option');
      await expect(wOptions).toHaveCount(TERMINAL_FONT_WEIGHTS.length);
      for (const [index, weight] of TERMINAL_FONT_WEIGHTS.entries()) {
        const option = wOptions.nth(index);
        await expect(option).toHaveAttribute('value', String(weight));
        await expect(option).toHaveText(`${TERMINAL_FONT_WEIGHT_NAMES[weight]} (${weight})`);
      }
      expect(FONT_COPY.terminalWeightOptionLabel(500)).toBe('Medium (500)');

      // AC1: the bold control offers exactly the weights heavier than the current weight (400).
      const expectedBoldChoices = boldWeightChoices(DEFAULT);
      expect(expectedBoldChoices).toEqual([500, 600, 700, 800, 900]);
      const bOptions = bSelect.locator('option');
      await expect(bOptions).toHaveCount(expectedBoldChoices.length);
      for (const [index, weight] of expectedBoldChoices.entries()) {
        const option = bOptions.nth(index);
        await expect(option).toHaveAttribute('value', String(weight));
        await expect(option).toHaveText(`${TERMINAL_FONT_WEIGHT_NAMES[weight]} (${weight})`);
      }
      await expect(bSelect).toBeEnabled();

      // AC1: exact hint text for both.
      await expect(win.getByText(FONT_COPY.terminalWeightHint, { exact: true })).toBeVisible();
      expect(FONT_COPY.terminalWeightHint).toBe(
        'Changing this also sets bold to 200 heavier, up to 900. Fonts without this weight use the nearest one.',
      );
      await expect(win.getByText(FONT_COPY.terminalBoldHint, { exact: true })).toBeVisible();
      expect(FONT_COPY.terminalBoldHint).toBe('Bold text is drawn at this weight. It must be heavier than the font weight.');

      // AC1: weight control directly after Terminal font size; bold control directly after weight.
      const sizeInput = win.getByTestId(FONT_TEST_IDS.terminalSizeInput);
      const sizeBox = await sizeInput.boundingBox();
      const wBox = await wSelect.boundingBox();
      const bBox = await bSelect.boundingBox();
      if (!sizeBox || !wBox || !bBox) throw new Error('font row geometry unavailable');
      expect(wBox.y).toBeGreaterThan(sizeBox.y);
      expect(bBox.y).toBeGreaterThan(wBox.y);

      // AC12: Tab from the size control reaches the weight select, then the bold select
      // (only reachable while weight < 900, where the bold select is enabled/focusable).
      // The size row has its own "+" stepper button after the input (TerminalFontSizeControl.tsx),
      // so the size input's own Tab stop is followed by that button before the next row.
      await sizeInput.focus();
      await win.keyboard.press('Tab');
      await expect(win.getByRole('button', { name: 'Increase terminal font size' }), 'Tab from the size input lands on its own "+" stepper first').toBeFocused();
      await win.keyboard.press('Tab');
      await expect(wSelect, 'Tab from the "+" stepper lands on Terminal font weight').toBeFocused();
      await win.keyboard.press('Tab');
      await expect(bSelect, 'Tab from Terminal font weight lands on Terminal bold weight').toBeFocused();

      // AC12: selecting a value through the real control applies it.
      await wSelect.selectOption(String(500));
      await expect.poll(() => storedWeight(win), { timeout: E2E_TIMEOUT }).toBe(500);
      await expect.poll(async () => (await terminalProbes(win))[0]?.fontWeight, { timeout: E2E_TIMEOUT }).toBe(500);

      // AC1: at weight 900, the bold control shows Black (900) and is disabled.
      await wSelect.selectOption(String(900));
      await expect(bSelect).toHaveValue(String(900));
      await expect(bSelect.locator('option')).toHaveCount(1);
      await expect(bSelect).toBeDisabled();
    } finally {
      await harness.close();
    }
  });

  test('AC2: choosing the already-selected value on either control saves nothing; a genuine change does', async () => {
    const harness = await launchHarness();
    try {
      const { app, win } = harness;
      await openProject(win);
      await openSettings(win);
      const wSelect = weightSelect(win);
      const bSelect = boldSelect(win);
      await expect(wSelect).toHaveValue(String(DEFAULT));
      await expect(bSelect).toHaveValue(String(DEFAULT_BOLD));

      await installInvokeRecorder(app, WEIGHT_CHANNEL);
      await installInvokeRecorder(app, BOLD_CHANNEL);
      const weightBaseline = (await invokeCalls(app, WEIGHT_CHANNEL)).length;
      const boldBaseline = (await invokeCalls(app, BOLD_CHANNEL)).length;

      await wSelect.selectOption(String(DEFAULT));
      expect(await invokeCalls(app, WEIGHT_CHANNEL), 're-selecting the current weight issues no save').toHaveLength(weightBaseline);
      await bSelect.selectOption(String(DEFAULT_BOLD));
      expect(await invokeCalls(app, BOLD_CHANNEL), 're-selecting the current bold weight issues no save').toHaveLength(boldBaseline);
      expect(await storedWeight(win)).toBeNull();
      expect(await storedBold(win)).toBeNull();

      // Positive controls: a real change on each does save.
      await wSelect.selectOption(String(600));
      expect(await invokeCalls(app, WEIGHT_CHANNEL), 'a genuine weight change saves immediately').toHaveLength(weightBaseline + 1);
      await expect.poll(() => storedWeight(win), { timeout: E2E_TIMEOUT }).toBe(600);

      await bSelect.selectOption(String(900));
      expect(await invokeCalls(app, BOLD_CHANNEL), 'a genuine bold change saves immediately').toHaveLength(boldBaseline + 1);
      await expect.poll(() => storedBold(win), { timeout: E2E_TIMEOUT }).toBe(900);
    } finally {
      await harness.close();
    }
  });

  test('AC4: choosing a font weight saves it and resets bold to min(W + 200, 900), replacing a hand-set bold; choosing bold alone leaves the weight untouched', async () => {
    const harness = await launchHarness();
    try {
      const { win } = harness;
      await openProject(win);
      await openSettings(win);
      const wSelect = weightSelect(win);
      const bSelect = boldSelect(win);

      // For every one of the nine weights: choosing it saves W and derivedBoldWeight(W) together.
      for (const weight of TERMINAL_FONT_WEIGHTS) {
        await wSelect.selectOption(String(weight));
        const expectedBold = derivedBoldWeight(weight);
        await expect.poll(() => storedWeight(win), { timeout: E2E_TIMEOUT }).toBe(weight);
        await expect.poll(() => storedBold(win), { timeout: E2E_TIMEOUT }).toBe(expectedBold);
        await expect.poll(async () => (await terminalProbes(win))[0]?.fontWeight, { timeout: E2E_TIMEOUT }).toBe(weight);
        expect((await terminalProbes(win))[0]?.fontWeightBold).toBe(expectedBold);
      }
      // Table-driven corners named explicitly, matching the spec's own examples.
      expect(derivedBoldWeight(100)).toBe(300);
      expect(derivedBoldWeight(400)).toBe(600);
      expect(derivedBoldWeight(700)).toBe(900);
      expect(derivedBoldWeight(800)).toBe(900);
      expect(derivedBoldWeight(900)).toBe(900);

      // Setting bold on its own changes only the bold weight.
      await wSelect.selectOption(String(400));
      await expect.poll(() => storedBold(win), { timeout: E2E_TIMEOUT }).toBe(600);
      await bSelect.selectOption(String(900));
      await expect.poll(() => storedBold(win), { timeout: E2E_TIMEOUT }).toBe(900);
      expect(await storedWeight(win), 'setting bold alone does not touch the font weight').toBe(400);
      expect((await terminalProbes(win))[0]?.fontWeight).toBe(400);
      expect((await terminalProbes(win))[0]?.fontWeightBold).toBe(900);

      // Choosing a new font weight resets the hand-set bold, even though the user set it by hand.
      await wSelect.selectOption(String(300));
      await expect.poll(() => storedBold(win), { timeout: E2E_TIMEOUT }).toBe(derivedBoldWeight(300));
      expect(await storedBold(win), 'a hand-set bold is replaced, not preserved').toBe(500);
    } finally {
      await harness.close();
    }
  });

  test('AC5, AC6, AC11: a Settings change live-applies to every open terminal without recreating it, and a later shell opens at the current pair', async () => {
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
      const [popout] = await Promise.all([
        app.waitForEvent('window'),
        win.evaluate(async (request) => {
          const rendererWindow = window as unknown as RendererWindow;
          await rendererWindow.api.invoke('windows:popout-shell', request);
        }, poppedShell),
      ]);
      await popout.waitForLoadState('domcontentloaded');
      await expect(popout.locator('.xterm')).toBeVisible({ timeout: E2E_TIMEOUT });

      const mainBefore = await terminalProbes(win);
      const popoutBefore = await terminalProbes(popout);
      expect(mainBefore).toHaveLength(2);
      expect(popoutBefore).toHaveLength(1);

      // A font-weight change (also moves bold) live-applies everywhere, same identity tokens.
      await openSettings(win);
      await weightSelect(win).selectOption(String(300));
      await closeSettings(win);
      await expect.poll(async () => (await terminalProbes(win)).map((p) => p.fontWeight), { timeout: E2E_TIMEOUT }).toEqual([300, 300]);
      await expect.poll(async () => (await terminalProbes(win)).map((p) => p.fontWeightBold), { timeout: E2E_TIMEOUT }).toEqual([500, 500]);
      await expect.poll(async () => (await terminalProbes(popout))[0]?.fontWeight, { timeout: E2E_TIMEOUT }).toBe(300);
      await expect.poll(async () => (await terminalProbes(popout))[0]?.fontWeightBold, { timeout: E2E_TIMEOUT }).toBe(500);

      // A bold-only change also live-applies everywhere, without touching the weight.
      await openSettings(win);
      await boldSelect(win).selectOption(String(900));
      await closeSettings(win);
      await expect.poll(async () => (await terminalProbes(win)).map((p) => p.fontWeightBold), { timeout: E2E_TIMEOUT }).toEqual([900, 900]);
      await expect.poll(async () => (await terminalProbes(popout))[0]?.fontWeightBold, { timeout: E2E_TIMEOUT }).toBe(900);
      expect((await terminalProbes(win)).map((p) => p.fontWeight)).toEqual([300, 300]);

      const mainAfter = await terminalProbes(win);
      const popoutAfter = await terminalProbes(popout);
      expect(mainAfter.map((p) => p.token), 'terminals are not recreated').toEqual(mainBefore.map((p) => p.token));
      expect(popoutAfter.map((p) => p.token)).toEqual(popoutBefore.map((p) => p.token));
      expect(mainAfter.map((p) => ({ cols: p.cols, rows: p.rows }))).toEqual(mainBefore.map((p) => ({ cols: p.cols, rows: p.rows })));
      expect(mainAfter.map((p) => p.bufferLength)).toEqual(mainBefore.map((p) => p.bufferLength));

      // AC13: untouched by the weight/bold changes.
      expect(mainAfter.map((p) => p.fontSize)).toEqual(mainBefore.map((p) => p.fontSize));
      expect(mainAfter.map((p) => p.fontFamily)).toEqual(mainBefore.map((p) => p.fontFamily));

      // AC6, AC11: a shell not mounted at change time, and its popped-out window, open at the current pair.
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
      const secondProbe = (await terminalProbes(secondPopout))[0];
      expect(secondProbe?.fontWeight, 'opens at the current weight, not the default').toBe(300);
      expect(secondProbe?.fontWeightBold, 'opens at the current bold weight, not the derived default').toBe(900);

      // AC11: the popout's own Settings view (same provider tree, main window only hosts the modal;
      // reflected value checked through the shared store instead) shows the same pair.
      await openSettings(win);
      await expect(weightSelect(win)).toHaveValue('300');
      await expect(boldSelect(win)).toHaveValue('900');
      await closeSettings(win);
      await secondPopout.close();
    } finally {
      await harness.close();
    }
  });

  test('AC5: already-rendered text repaints at the new weight with no new output, under WebGL and under the DOM fallback', async () => {
    const harness = await launchHarness();
    try {
      const { win } = harness;
      await openProject(win);

      // Put real glyphs on screen (no further output after this), using the default font
      // stack's first available face (SF Mono / Menlo on macOS CI), which has visually
      // distinct Regular and Black faces. A real SGR-bold run is included (written
      // directly to the Terminal instance, see writeRawToTerminal's own comment) so the
      // DOM-fallback bold-only assertion below has an actual `.xterm-bold` span to repaint
      // — typed/echoed text alone is never bold, so a bold-weight-only change would be
      // invisible against it.
      await win.locator('.xterm').first().click();
      await writeRawToTerminal(win, '\x1b[1mBOLD\x1b[0m plain 0123456789');
      await expect.poll(async () => (await terminalProbes(win))[0]?.screen, { timeout: E2E_TIMEOUT })
        .toContain('BOLD plain 0123456789');

      const host = win.locator('[data-testid="shell-tab"] .xterm-screen').first();
      await expect(host).toBeVisible();

      // Settle focus state before the first screenshot: the click above left the terminal
      // focused (blinking cursor), and a focus-state change alone — not a repaint — can
      // make two screenshots differ. One no-op Settings open/close moves focus into the
      // modal and back out, so every "before" screenshot below starts from the same
      // (settled) focus state as its "after" counterpart.
      await openSettings(win);
      await closeSettings(win);

      // Same-state control: two screenshots taken around a no-op Settings cycle (no weight
      // or bold change) must be pixel-identical. Without this, the real comparisons below
      // could pass on a focus/paint artifact of opening and closing Settings, independent
      // of any actual font-weight repaint.
      const controlBefore = await host.screenshot();
      await openSettings(win);
      await closeSettings(win);
      const controlAfter = await host.screenshot();
      expect(Buffer.compare(controlBefore, controlAfter), 'control: a no-op Settings cycle changes no pixels').toBe(0);

      // WebGL path: from the settled default (400/700), change weight to 900 (bold follows
      // to 900 too) with no new output or scroll, screenshot again.
      const beforeWebgl = controlAfter;
      await openSettings(win);
      await weightSelect(win).selectOption(String(900));
      await closeSettings(win);
      await expect.poll(async () => (await terminalProbes(win))[0]?.fontWeight, { timeout: E2E_TIMEOUT }).toBe(900);
      const afterWebgl = await host.screenshot();
      expect(Buffer.compare(beforeWebgl, afterWebgl), 'WebGL: the repaint changes the rendered pixels with no new output').not.toBe(0);

      // WebGL bold-only repaint: font weight 300 (left alone from here on), bold moved from
      // 400 (its nearest "Regular" face) to 900 (its "Bold" face) — a pair that does render
      // differently on the installed stack, isolating a bold-only change from the
      // weight+bold change exercised above.
      await openSettings(win);
      await weightSelect(win).selectOption(String(300));
      await boldSelect(win).selectOption(String(400));
      await closeSettings(win);
      await expect.poll(async () => (await terminalProbes(win))[0]?.fontWeight, { timeout: E2E_TIMEOUT }).toBe(300);
      await expect.poll(async () => (await terminalProbes(win))[0]?.fontWeightBold, { timeout: E2E_TIMEOUT }).toBe(400);

      // Same-state control for the bold-only check.
      const boldControlBefore = await host.screenshot();
      await openSettings(win);
      await closeSettings(win);
      const boldControlAfter = await host.screenshot();
      expect(Buffer.compare(boldControlBefore, boldControlAfter), 'control: a no-op Settings cycle changes no pixels (bold-only baseline)').toBe(0);

      const beforeBoldWebgl = boldControlAfter;
      await openSettings(win);
      await boldSelect(win).selectOption(String(900));
      await closeSettings(win);
      await expect.poll(async () => (await terminalProbes(win))[0]?.fontWeightBold, { timeout: E2E_TIMEOUT }).toBe(900);
      const afterBoldWebgl = await host.screenshot();
      expect(Buffer.compare(beforeBoldWebgl, afterBoldWebgl), 'WebGL: a bold-only repaint changes the rendered pixels with no new output').not.toBe(0);
      expect((await terminalProbes(win))[0]?.fontWeight, 'the bold-only change leaves the font weight alone').toBe(300);

      // Back to the 900/900 baseline the DOM-fallback section below was written against.
      await openSettings(win);
      await weightSelect(win).selectOption(String(900));
      await closeSettings(win);
      await expect.poll(async () => (await terminalProbes(win))[0]?.fontWeight, { timeout: E2E_TIMEOUT }).toBe(900);
      await expect.poll(async () => (await terminalProbes(win))[0]?.fontWeightBold, { timeout: E2E_TIMEOUT }).toBe(900);

      // DOM fallback path: lose the WebGL context so the addon disposes and xterm falls back
      // to its DOM renderer, then prove the same repaint-with-no-output property there.
      const lostContext = await loseWebglContext(win);
      expect(lostContext, 'a live WebGL context was found to force-lose').toBe(true);
      // The addon waits a fixed 3000ms after `webglcontextlost` (in case the browser
      // restores it) before disposing and letting xterm fall back to `.xterm-rows`
      // (confirmed against the real @xterm/addon-webgl 0.18.0 source), so poll for that
      // fallback container rather than assume disposal is synchronous with loseContext().
      await expect.poll(
        () => win.evaluate(() => !!document.querySelector('.xterm-rows')),
        { timeout: 6000, message: 'the DOM renderer fallback (.xterm-rows) appears once the addon disposes' },
      ).toBe(true);

      // Normal-weight repaint under the DOM fallback: 900 (carried over from the WebGL
      // step above) down to 300 is a pairing the installed stack renders as visibly
      // different glyphs (same reasoning as the WebGL pairing above), so this is a real
      // pixel-diff check of the DOM renderer's own repaint path.
      const beforeDomWeight = await host.screenshot();
      await openSettings(win);
      await weightSelect(win).selectOption(String(300));
      await closeSettings(win);
      await expect.poll(async () => (await terminalProbes(win))[0]?.fontWeight, { timeout: E2E_TIMEOUT }).toBe(300);
      const afterDomWeight = await host.screenshot();
      expect(Buffer.compare(beforeDomWeight, afterDomWeight), 'DOM fallback: a weight repaint changes the rendered pixels with no new output').not.toBe(0);

      // Bold-only repaint under the DOM fallback: verified via the DOM renderer's own
      // computed style on the real `.xterm-bold` span written above, not a pixel diff. The
      // WebGL bold-only check above already proves a real bold-face pixel diff exists on
      // this stack (300/400 -> 300/900); the computed-style assertion here additionally
      // pins the DOM renderer's own per-node bold handling, which a canvas-level pixel
      // diff could never localize to the bold span specifically.
      await openSettings(win);
      await boldSelect(win).selectOption(String(900));
      await closeSettings(win);
      await expect.poll(async () => (await terminalProbes(win))[0]?.fontWeightBold, { timeout: E2E_TIMEOUT }).toBe(900);
      const boldSpanWeight = await win.evaluate(() => {
        const span = document.querySelector('.xterm-bold');
        return span ? getComputedStyle(span).fontWeight : null;
      });
      expect(boldSpanWeight, 'the DOM fallback renderer writes the new bold weight onto the real bold span, with no new output').toBe('900');
      // Confirmed by direct inspection: `.xterm-rows > div` (the row container) always
      // reports the browser's initial font-weight ('400') regardless of the configured
      // weight — xterm's injected stylesheet rule targets descendant `span` elements, not
      // the row div itself — so the real per-weight signal is on a normal-text span.
      const normalSpanWeight = await win.evaluate(() => {
        const span = document.querySelector('.xterm-rows span:not(.xterm-bold)');
        return span ? getComputedStyle(span).fontWeight : null;
      });
      expect(normalSpanWeight, 'AC13: a bold-only change leaves the normal weight (300) alone').toBe('300');
    } finally {
      await harness.close();
    }
  });

  test('AC7, AC8: a hand-set pair survives a restart with no visible extra jump; both dedicated setters reject invalid values and the generic channel rejects both keys', async () => {
    const fixture = createFixture();
    let harness = await launchHarness(fixture);
    try {
      await openProject(harness.win);
      await openSettings(harness.win);
      await weightSelect(harness.win).selectOption(String(300));
      await expect.poll(() => storedBold(harness.win), { timeout: E2E_TIMEOUT }).toBe(500);
      await boldSelect(harness.win).selectOption(String(800));
      await expect.poll(() => storedBold(harness.win), { timeout: E2E_TIMEOUT }).toBe(800);
      expect(await storedWeight(harness.win)).toBe(300);
      await closeSettings(harness.win);
      await harness.close(false);

      harness = await launchHarness(fixture, { addRoot: false });
      expect(await storedWeight(harness.win)).toBe(300);
      expect(await storedBold(harness.win)).toBe(800);
      await openProject(harness.win);
      const firstProbe = (await terminalProbes(harness.win))[0];
      if (!firstProbe) throw new Error('terminal probe unavailable after restart');
      expect(firstProbe.fontWeight, 'terminals open at the saved pair, no visible jump').toBe(300);
      expect(firstProbe.fontWeightBold).toBe(800);

      // AC7, made failable: delay the main process's `settings:get` reply for
      // `terminal_font_weight`, then mount a brand-new window (a popped-out shell) whose
      // TerminalFontWeightProvider has to load the pair from scratch. The delay is
      // installed before that window exists, so there is no race (same technique as
      // terminal-font-size.spec.ts's AC11 delayed-load test). This is what goes red if the
      // open-wait (`&& fontWeightReadyRef.current`, ShellTab.tsx:270) is dropped: the
      // terminal would open immediately, before the delay resolves, at the unready default
      // (400/700) instead of the saved pair (300/800).
      await expect.poll(async () => harness.win.evaluate(async (projectName) => {
        const rendererWindow = window as unknown as RendererWindow;
        const { shells } = await rendererWindow.api.invoke('shells:alive-list', undefined) as {
          shells: Array<{ projectName: string; shellIndex: number }>;
        };
        return shells.some((entry) => entry.projectName === projectName && entry.shellIndex === 0);
      }, PROJECT), { timeout: E2E_TIMEOUT }).toBe(true);

      await installDelayedGet(harness.app, WEIGHT_KEY, 1500);
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
      const openedAt = Date.now();
      const [popout] = await Promise.all([
        harness.app.waitForEvent('window'),
        harness.win.evaluate(async (request) => {
          const rendererWindow = window as unknown as RendererWindow;
          await rendererWindow.api.invoke('windows:popout-shell', request);
        }, poppedShell),
      ]);
      await popout.waitForLoadState('domcontentloaded');

      // Still well inside the delay: the terminal must not have opened yet. Proves the
      // wait actually holds off, rather than happening to not matter.
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      expect(await popout.locator('.xterm').count(), 'the terminal must not open before the store is ready').toBe(0);

      await expect(popout.locator('.xterm')).toBeVisible({ timeout: E2E_TIMEOUT });
      expect(Date.now() - openedAt, 'the terminal only opened once the delayed load resolved').toBeGreaterThanOrEqual(1500);
      const popoutProbe = (await terminalProbes(popout))[0];
      if (!popoutProbe) throw new Error('popout terminal probe unavailable');
      expect(popoutProbe.fontWeight, 'the first probe already matches the saved weight, no 400->300 jump').toBe(300);
      expect(popoutProbe.fontWeightBold, 'the first probe already matches the saved bold weight, no 700->800 jump').toBe(800);
      await restoreHandler(harness.app, 'settings:get');
      await popout.close();

      // AC8: the font-weight setter rejects out-of-set values; neither stored value changes.
      for (const invalid of [450, 1000, 0, 'bold', null]) {
        await expect(harness.win.evaluate(async (value) => {
          const rendererWindow = window as unknown as RendererWindow;
          await rendererWindow.api.invoke('settings:set-terminal-font-weight', { value });
        }, invalid)).rejects.toThrow();
        expect(await storedWeight(harness.win), `font weight ${String(invalid)} must not change the stored weight`).toBe(300);
        expect(await storedBold(harness.win), `font weight ${String(invalid)} must not change the stored bold weight`).toBe(800);
      }

      // AC8: the bold-weight setter rejects an invalid value and a value not heavier than the
      // in-use font weight (300); the stored weight is never touched by this setter.
      for (const invalid of [450, 1000, 0, 'bold', null, 300, 200]) {
        await expect(harness.win.evaluate(async (value) => {
          const rendererWindow = window as unknown as RendererWindow;
          await rendererWindow.api.invoke('settings:set-terminal-bold-weight', { value });
        }, invalid)).rejects.toThrow();
        expect(await storedBold(harness.win), `bold weight ${String(invalid)} must not change the stored bold weight`).toBe(800);
      }
      expect(await storedWeight(harness.win), 'the bold setter never touches the stored weight').toBe(300);

      // AC8: the generic settings:set channel rejects both keys too, so validation cannot be bypassed.
      await expect(harness.win.evaluate(async () => {
        const rendererWindow = window as unknown as RendererWindow;
        await rendererWindow.api.invoke('settings:set', { key: 'terminal_font_weight', value: 500 });
      })).rejects.toThrow();
      await expect(harness.win.evaluate(async () => {
        const rendererWindow = window as unknown as RendererWindow;
        await rendererWindow.api.invoke('settings:set', { key: 'terminal_bold_weight', value: 900 });
      })).rejects.toThrow();
      expect(await storedWeight(harness.win)).toBe(300);
      expect(await storedBold(harness.win)).toBe(800);
    } finally {
      await harness.close();
    }
  });

  test('AC9: an invalid stored weight or bold weight falls back per resolveTerminalWeights, is logged, and is not silently rewritten', async () => {
    async function seedAndCheck(
      seed: { weight: number | null; bold: number | null },
      expected: { weight: TerminalFontWeight; bold: TerminalFontWeight },
      label: string,
    ): Promise<void> {
      const fixture = createFixture();
      const firstRun = await launchHarness(fixture);
      await openProject(firstRun.win);

      // `buildServices` (src/main/services.ts) resolves the DB at
      // `<homeDir>/.metaide/metaide.db`, and the harness points HOME at `fixture.home`
      // (not Electron's own `--user-data-dir`), so that is where the running app's
      // settings actually live. The generic `settings:set` channel is itself guarded
      // against both keys (AC8), so there is no first-party IPC path to get an invalid
      // pair stored — seed directly through sqlite, the same way a hand-edit would land.
      // Done inside the still-running app's own main process (`app.evaluate`, `require`d
      // there, not imported into this test process): better-sqlite3 ships a native binding
      // rebuilt against Electron's own Node ABI, which does not load under the plain
      // Node.js the Playwright test runner uses (confirmed: a direct `import('better-sqlite3')`
      // here throws "NODE_MODULE_VERSION 128 ... requires ... 115").
      const dbPath = join(fixture.home, '.metaide', 'metaide.db');
      await firstRun.close(false);
      // Seed the invalid pair by running a one-line CommonJS script through the project's
      // own Electron binary in `ELECTRON_RUN_AS_NODE=1` mode — the same technique
      // `tests/unit/main/claude-hooks/receiver.test.ts` uses, and the same mode
      // `pnpm test` itself runs under (package.json's `test` script). Two things rule out
      // the simpler alternatives: a plain `import('better-sqlite3')` from this Playwright
      // test process throws (its native binding is rebuilt against Electron's own Node
      // ABI, not the plain Node.js the test runner uses — confirmed: NODE_MODULE_VERSION
      // 128 vs the required 115); and neither `require` nor dynamic `import()` is available
      // inside `electronApplication.evaluate`'s injected script (confirmed: "require is not
      // defined", then "A dynamic import callback was not specified"). Running the Electron
      // binary itself as plain Node sidesteps both: same ABI as the app, real `require`.
      const seedScript = `const Database = require('better-sqlite3'); const db = new Database(${JSON.stringify(dbPath)}); const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');`
        + (seed.weight !== null ? `upsert.run(${JSON.stringify(WEIGHT_KEY)}, ${JSON.stringify(JSON.stringify(seed.weight))});` : '')
        + (seed.bold !== null ? `upsert.run(${JSON.stringify(BOLD_KEY)}, ${JSON.stringify(JSON.stringify(seed.bold))});` : '')
        + 'db.close();';
      await promisify(execFile)(electronBinaryPath as unknown as string, ['-e', seedScript], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });

      const consoleErrors: string[] = [];
      const harness = await launchHarness(fixture, { addRoot: false });
      harness.win.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      try {
        await openProject(harness.win);
        const probe = (await terminalProbes(harness.win))[0];
        expect(probe?.fontWeight, `${label}: resolved weight in use`).toBe(expected.weight);
        expect(probe?.fontWeightBold, `${label}: resolved bold weight in use`).toBe(expected.bold);
        await openSettings(harness.win);
        await expect(weightSelect(harness.win)).toHaveValue(String(expected.weight));
        await expect(boldSelect(harness.win)).toHaveValue(String(expected.bold));
        await closeSettings(harness.win);
        if (seed.weight !== null) {
          expect(await storedWeight(harness.win), `${label}: the invalid stored weight is not rewritten`).toBe(seed.weight);
        }
        if (seed.bold !== null) {
          expect(await storedBold(harness.win), `${label}: the invalid stored bold weight is not rewritten`).toBe(seed.bold);
        }
        // Filter on the store's actual load-error context (terminal-font-weight-store.ts:74,
        // `ports.reportError('terminal font weight load', ...)`), not just "any console.error" —
        // the app logs plenty of unrelated console noise, so an unfiltered count could pass for
        // the wrong reason. Each present-but-invalid seeded field produces exactly one such
        // error; a seed with no invalid field (the positive control below) must produce none,
        // proving the filter is actually selective rather than vacuously true.
        const expectedWeightLoadErrors =
          (seed.weight !== null && seed.weight !== expected.weight ? 1 : 0) +
          (seed.bold !== null && seed.bold !== expected.bold ? 1 : 0);
        if (expectedWeightLoadErrors > 0) {
          await expect.poll(
            () => consoleErrors.filter((text) => text.includes('terminal font weight load')).length,
            { timeout: E2E_TIMEOUT, message: `${label}: the weight-load error is reported via console.error` },
          ).toBe(expectedWeightLoadErrors);
        } else {
          // Positive control: give the app a moment to have logged anything it was going
          // to log, then confirm a fully valid stored pair reports zero weight-load errors.
          await new Promise((resolveWait) => setTimeout(resolveWait, 500));
          expect(
            consoleErrors.filter((text) => text.includes('terminal font weight load')),
            `${label}: a valid stored pair reports no weight-load error`,
          ).toHaveLength(0);
        }
      } finally {
        await harness.close();
      }
    }

    // Invalid font weight (450): falls back to 400; bold has no stored value, so it falls
    // back silently to the default-or-derived rule (700 is valid for weight 400, so 700).
    await seedAndCheck({ weight: 450, bold: null }, { weight: 400, bold: 700 }, 'invalid weight 450');

    // Valid weight 500, stored bold 500 (not heavier than 500): falls back to 700 (valid for 500).
    await seedAndCheck({ weight: 500, bold: 500 }, { weight: 500, bold: 700 }, 'bold 500 not heavier than weight 500');

    // Valid weight 800, stored bold 700 (not heavier than 800): falls back to min(800+200,900) = 900.
    await seedAndCheck({ weight: 800, bold: 700 }, { weight: 800, bold: 900 }, 'bold 700 not heavier than weight 800');

    // Positive control for the console-error filter above: both values valid and
    // unchanged by resolution, so no weight-load error should be reported at all.
    await seedAndCheck({ weight: 400, bold: 700 }, { weight: 400, bold: 700 }, 'valid pair (positive control for the console filter)');
  });

  test('AC10: a failed save reverts both controls and every terminal to the stored weights and shows the exact error toast for whichever channel failed', async () => {
    const harness = await launchHarness();
    try {
      const { app, win } = harness;
      await openProject(win);
      await win.getByTestId('tabbar-split').click();
      await expect(win.getByTestId('split-right').locator('.xterm')).toBeVisible({ timeout: E2E_TIMEOUT });
      expect(await storedWeight(win)).toBeNull();
      expect(await storedBold(win)).toBeNull();
      await expect.poll(async () => (await terminalProbes(win)).map((p) => p.fontWeight)).toEqual([DEFAULT, DEFAULT]);

      // Font-weight channel fails: both the weight control and the bold control revert
      // (bold moves with weight), every terminal reverts, and the weight toast appears.
      await installFailingHandler(app, WEIGHT_CHANNEL, 'injected terminal font weight save failure');
      await installInvokeRecorder(app, WEIGHT_CHANNEL);
      try {
        await openSettings(win);
        await weightSelect(win).selectOption(String(600));
        await expect(
          win.getByTestId('toast').filter({ hasText: FONT_COPY.terminalWeightSaveFailed }).first(),
          'positive control: the weight failure toast appeared',
        ).toBeVisible({ timeout: E2E_TIMEOUT });
        expect(FONT_COPY.terminalWeightSaveFailed).toBe(
          'Could not save the terminal font weight. Your previous weight remains active.',
        );
        await expect(weightSelect(win), 'the weight control reverts to the stored weight').toHaveValue(String(DEFAULT));
        await expect(boldSelect(win), 'the bold control reverts too').toHaveValue(String(DEFAULT_BOLD));
        await expect.poll(async () => (await terminalProbes(win)).map((p) => p.fontWeight), {
          message: 'every terminal reverts to the stored weight',
        }).toEqual([DEFAULT, DEFAULT]);
        expect(await storedWeight(win), 'the stored weight is unchanged').toBeNull();
        expect(await storedBold(win), 'the stored bold weight is unchanged').toBeNull();
        expect(await invokeCalls(app, WEIGHT_CHANNEL), 'exactly one save call').toHaveLength(1);
        await closeSettings(win);
      } finally {
        await restoreHandler(app, WEIGHT_CHANNEL);
      }

      // Bold channel fails: only the bold control and bold weight revert; the font weight
      // (unaffected by this channel) stays exactly as it was, and the bold toast appears.
      await installFailingHandler(app, BOLD_CHANNEL, 'injected terminal bold weight save failure');
      await installInvokeRecorder(app, BOLD_CHANNEL);
      try {
        await openSettings(win);
        await boldSelect(win).selectOption(String(900));
        await expect(
          win.getByTestId('toast').filter({ hasText: FONT_COPY.terminalBoldSaveFailed }).first(),
          'positive control: the bold failure toast appeared',
        ).toBeVisible({ timeout: E2E_TIMEOUT });
        expect(FONT_COPY.terminalBoldSaveFailed).toBe(
          'Could not save the terminal bold weight. Your previous bold weight remains active.',
        );
        await expect(boldSelect(win), 'the bold control reverts to the stored bold weight').toHaveValue(String(DEFAULT_BOLD));
        await expect(weightSelect(win), 'the weight control is unaffected').toHaveValue(String(DEFAULT));
        await expect.poll(async () => (await terminalProbes(win)).map((p) => p.fontWeightBold), {
          message: 'every terminal reverts to the stored bold weight',
        }).toEqual([DEFAULT_BOLD, DEFAULT_BOLD]);
        expect(await storedBold(win), 'the stored bold weight is unchanged').toBeNull();
        expect(await invokeCalls(app, BOLD_CHANNEL), 'exactly one save call').toHaveLength(1);
      } finally {
        await restoreHandler(app, BOLD_CHANNEL);
      }

      // Positive control: with the real handlers restored, the same actions now succeed.
      await boldSelect(win).selectOption(String(900));
      await expect.poll(() => storedBold(win), { timeout: E2E_TIMEOUT }).toBe(900);
    } finally {
      await harness.close();
    }
  });
});
