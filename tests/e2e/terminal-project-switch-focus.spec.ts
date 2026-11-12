/**
 * Focus the target project's terminal on an in-app project switch.
 *
 * Spec: docs/specs/focus-terminal-on-project-switch.md (AC1–AC15)
 * Plan: docs/plan/focus-terminal-on-project-switch.md (§6 Agent 2)
 *
 * Drives the real Electron app with real ptys (mock-claude for shell 0,
 * `/bin/sh` for Terminal tabs and split shells — see `launch` in helpers/focus.ts).
 * Owns no source under src/.
 *
 * "Terminal is focused" (spec): the target shell's xterm helper textarea is
 * `document.activeElement` AND text typed afterwards reaches that shell's
 * pty. The DOM does not say which (project, shell) a ShellTab belongs to, so
 * the suite identifies it by:
 *   - the window title (`<name> — MetaLogix IDE`) for the selected project,
 *     read in the same task as `activeElement` (`primaryTerminalFocusedFor`);
 *   - `.split-left` for the primary (active-tab) pane;
 *   - typing a unique marker and reading it back from `shells:snapshot` of
 *     the expected shell, and not from its sibling shell 0;
 *   - the persisted `metaide.projectStates` blob for "which shell index the
 *     Shell tab shows" (the tab strip carries no test id or index).
 *
 * Race construction (AC7, AC8): sidebar rows are clicked with
 * `HTMLElement.click()` inside one `win.evaluate`, followed in the same task
 * by the "user moves on" action, so every step lands before the
 * `projects:open` reply can arrive. No fixed sleeps anywhere: negatives are
 * asserted only after a positive control shows the target terminal has
 * opened (its `.xterm-screen` exists, which xterm creates in `open()`, the
 * same synchronous block that notifies the focus coordinator).
 *
 * AC8's second case needs beta's request issued before gamma is clicked,
 * and beta's terminal opening while gamma's switch is still in flight. It
 * holds both deterministically: terminal hosts are kept at zero size so
 * ShellTab's open gate waits, and gamma's `projects:open` reply is held in
 * the main process (`holdProjectOpen`); a capturing `focusin` recorder
 * proves beta's textarea never took focus.
 *
 * Not covered here, by design (plan §7): AC9 (TTL) and AC13 (single
 * `focus()` call) are unit-level; AC14 is the unmodified existing specs.
 * AC7 uses the sidebar filter and the switcher rather than the ChatTab
 * composer, which is unreachable under METAIDE_TEST_MODE (see the header of
 * terminal-window-focus.spec.ts).
 */

import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import type {} from '../../src/renderer/api';
import {
  launch, openProject, projectRow, waitForProjectShown, blurToBody,
  terminalActiveIn, primaryTerminalFocusedFor, focusedTerminalCount,
  projectIdByName, aliveProjectNames, shellOutput, waitForShellOutput,
  typeReachesPty, marker, rememberedState, clickRowsInOneTask,
  switcherInput, switcherResult, newShellTab, sendNotificationFocusRequest,
  holdProjectOpen, hideTerminalHosts, showTerminalHosts, recordFocusins,
  rememberPrimaryTextarea, focusinsInclude,
  MOCK_CLAUDE_BANNER, PRIMARY, SIDEBAR_FILTER_INPUT,
} from './helpers/focus';
import { SIDEBAR_TESTIDS } from '../../src/renderer/sidebar-copy';

const FOCUS_TIMEOUT = 10000;

test.describe('project switch focus', () => {
  test('AC1/AC12: sidebar click — the target terminal takes focus once it opens, and typed text reaches its pty', async () => {
    const { app, win, cleanup } = await launch(['alpha', 'beta']);
    try {
      await openProject(win, 'alpha');
      expect(await aliveProjectNames(win), 'positive control (AC12): beta has no live pty before the switch').not.toContain('beta');

      await projectRow(win, 'beta').click();

      await expect.poll(() => primaryTerminalFocusedFor(win, 'beta'), { timeout: FOCUS_TIMEOUT }).toBe(true);
      await waitForShellOutput(win, 'beta', 0, MOCK_CLAUDE_BANNER);
      await typeReachesPty(win, 'beta', 0, 'hi', 'echo: hi');
    } finally {
      await app.close();
      cleanup();
    }
  });

  test.describe('AC2: project switcher', () => {
    test('select with Enter — the target is focused after the switcher closes', async () => {
      const { app, win, cleanup } = await launch(['alpha', 'beta']);
      try {
        await openProject(win, 'alpha');
        await blurToBody(win);
        await win.keyboard.press('ControlOrMeta+k');
        await expect(switcherInput(win)).toBeFocused({ timeout: 2000 });
        await switcherInput(win).fill('beta');
        await expect(switcherResult(win, 'beta'), 'positive control: beta is the listed result').toBeVisible();

        await win.keyboard.press('Enter');

        await expect(switcherInput(win)).toHaveCount(0);
        await expect.poll(() => primaryTerminalFocusedFor(win, 'beta'), { timeout: FOCUS_TIMEOUT }).toBe(true);
        await waitForShellOutput(win, 'beta', 0, MOCK_CLAUDE_BANNER);
        await typeReachesPty(win, 'beta', 0, 'hi', 'echo: hi');
      } finally {
        await app.close();
        cleanup();
      }
    });

    test('select with a mouse click — the target is focused after the switcher closes', async () => {
      const { app, win, cleanup } = await launch(['alpha', 'beta']);
      try {
        await openProject(win, 'alpha');
        await blurToBody(win);
        await win.keyboard.press('ControlOrMeta+k');
        await expect(switcherInput(win)).toBeFocused({ timeout: 2000 });

        await switcherResult(win, 'beta').click();

        await expect(switcherInput(win)).toHaveCount(0);
        await expect.poll(() => primaryTerminalFocusedFor(win, 'beta'), { timeout: FOCUS_TIMEOUT }).toBe(true);
        await waitForShellOutput(win, 'beta', 0, MOCK_CLAUDE_BANNER);
        await typeReachesPty(win, 'beta', 0, 'hi', 'echo: hi');
      } finally {
        await app.close();
        cleanup();
      }
    });

    test('select the already-selected project — its open terminal is focused, with no remount (AC2 + D13)', async () => {
      // Spec risk "overlay still open at request time": the target is already
      // open, so the request is decided when issued, which must be after the
      // switcher's overlay flag has cleared.
      const { app, win, cleanup } = await launch(['alpha']);
      try {
        await openProject(win, 'alpha');
        const token = await markXterm(win);
        await blurToBody(win);
        await win.keyboard.press('ControlOrMeta+k');
        await expect(switcherInput(win)).toBeFocused({ timeout: 2000 });
        await switcherInput(win).fill('alpha');
        await expect(switcherResult(win, 'alpha')).toBeVisible();

        await win.keyboard.press('Enter');

        await expect(switcherInput(win)).toHaveCount(0);
        await expect.poll(() => primaryTerminalFocusedFor(win, 'alpha'), { timeout: FOCUS_TIMEOUT }).toBe(true);
        expect(await xtermStillMarked(win, token), 'same xterm element: the terminal did not remount').toBe(true);
      } finally {
        await app.close();
        cleanup();
      }
    });
  });

  test('AC3/AC12: new-project dialog — the new project\'s terminal takes focus after the dialog closes', async () => {
    const { app, win, cleanup } = await launch(['alpha']);
    try {
      await openProject(win, 'alpha');
      await win.getByTestId(SIDEBAR_TESTIDS.addButton).click();
      await win.getByTestId(SIDEBAR_TESTIDS.menuNewProject).click();
      const dialog = win.getByTestId('new-project-dialog');
      await expect(dialog).toBeVisible();
      await win.getByTestId('new-project-name').fill('gamma');

      await win.getByTestId('new-project-create').click();

      await expect(dialog).toHaveCount(0);
      await expect.poll(() => primaryTerminalFocusedFor(win, 'gamma'), { timeout: FOCUS_TIMEOUT }).toBe(true);
      await waitForShellOutput(win, 'gamma', 0, MOCK_CLAUDE_BANNER);
      await typeReachesPty(win, 'gamma', 0, 'hi', 'echo: hi');
    } finally {
      await app.close();
      cleanup();
    }
  });

  test('AC4: scrollback-search match in another project\'s shell 0 — that project and shell show and take focus after the overlay closes', async () => {
    const { app, win, cleanup } = await launch(['alpha', 'beta']);
    try {
      const needle = marker('needle');
      await openProject(win, 'beta');
      await waitForShellOutput(win, 'beta', 0, MOCK_CLAUDE_BANNER);
      await win.locator(`${PRIMARY} .xterm`).click();
      await typeReachesPty(win, 'beta', 0, needle, `echo: ${needle}`);
      await openProject(win, 'alpha');
      expect(await shellOutput(win, 'alpha', 0), 'positive control: only beta holds the needle').not.toContain(needle);

      await blurToBody(win);
      await win.keyboard.press('ControlOrMeta+Shift+O');
      const overlay = win.getByTestId('scrollback-search');
      await expect(overlay).toBeVisible({ timeout: 2000 });
      await overlay.locator('input[placeholder^="Search live scrollback"]').fill(needle);
      const match = overlay.locator('button', { hasText: needle }).first();
      await expect(match).toBeVisible({ timeout: 5000 });
      await expect(match, 'positive control: the match is in beta').toContainText('beta');

      await match.click();

      await expect(overlay).toHaveCount(0);
      await expect.poll(() => primaryTerminalFocusedFor(win, 'beta'), { timeout: FOCUS_TIMEOUT }).toBe(true);
      await typeReachesPty(win, 'beta', 0, 'hi', 'echo: hi');
    } finally {
      await app.close();
      cleanup();
    }
  });

  test.describe('AC5: target shell', () => {
    test('remembered shell N > 0 — shell N is focused, not shell 0', async () => {
      const { app, win, cleanup } = await launch(['alpha', 'beta']);
      try {
        await openProject(win, 'beta');
        const n = await newShellTab(win, 'beta');
        expect(n, 'positive control: the new tab is not shell 0').toBeGreaterThan(0);
        await openProject(win, 'alpha');
        const betaId = await projectIdByName(win, 'beta');

        await projectRow(win, 'beta').click();

        await expect.poll(() => primaryTerminalFocusedFor(win, 'beta'), { timeout: FOCUS_TIMEOUT }).toBe(true);
        expect((await rememberedState(win, betaId))?.activeShellIndex, 'beta shows its remembered shell N').toBe(n);
        const m = marker('shell-n');
        await typeReachesPty(win, 'beta', n, `echo ${m}`, m);
        expect(await shellOutput(win, 'beta', 0), 'typed text did not go to shell 0').not.toContain(m);
      } finally {
        await app.close();
        cleanup();
      }
    });

    test('split restored — the left (active-tab) pane is focused, not the right', async () => {
      const { app, win, cleanup } = await launch(['alpha', 'beta']);
      try {
        await openProject(win, 'beta');
        await win.getByTestId('tabbar-split').click();
        await expect(win.getByTestId('split-right')).toBeVisible();
        const betaId = await projectIdByName(win, 'beta');
        await expect.poll(async () => (await rememberedState(win, betaId))?.rightShellIndex ?? null, { timeout: 8000 }).not.toBeNull();
        await openProject(win, 'alpha');

        await projectRow(win, 'beta').click();

        await expect(win.locator('[data-testid="split-right"] .xterm-screen'), 'positive control: the split is restored and its right terminal opened')
          .toBeVisible({ timeout: FOCUS_TIMEOUT });
        await expect.poll(() => primaryTerminalFocusedFor(win, 'beta'), { timeout: FOCUS_TIMEOUT }).toBe(true);
        expect(await terminalActiveIn(win, '[data-testid="split-right"]'), 'the right pane is not the target').toBe(false);
        expect(await focusedTerminalCount(win)).toBe(1);
      } finally {
        await app.close();
        cleanup();
      }
    });
  });

  test('AC6: switch while on the Files tab — stays on Files, focuses nothing, logs no error; a later Files → Shell does not auto-focus', async () => {
    const { app, win, cleanup } = await launch(['alpha', 'beta']);
    try {
      await openProject(win, 'alpha');
      await win.getByRole('button', { name: 'Files', exact: true }).click();
      await expect(win.locator('[data-testid="shell-tab"]')).toHaveCount(0);
      const errors: string[] = [];
      win.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
      win.on('pageerror', (err) => { errors.push(String(err)); });

      await projectRow(win, 'beta').click();

      await waitForProjectShown(win, 'beta');
      await expect(win.locator('[data-testid="file-entry"]', { hasText: 'notes.txt' }), 'positive control: beta\'s Files tab rendered')
        .toBeVisible({ timeout: 5000 });
      await expect(win.locator('[data-testid="shell-tab"]'), 'main tab stays Files: no terminal mounts').toHaveCount(0);
      expect(await focusedTerminalCount(win), 'no xterm textarea is active').toBe(0);
      expect(errors, 'no error logged by the switch').toEqual([]);

      await win.getByRole('button', { name: 'Shell', exact: true }).click();

      await expect(win.locator(`${PRIMARY} .xterm-screen`), 'positive control: beta\'s terminal opened').toBeVisible({ timeout: FOCUS_TIMEOUT });
      expect(await focusedTerminalCount(win), 'a switch that landed on Files issued no request, so Files → Shell does not focus').toBe(0);
    } finally {
      await app.close();
      cleanup();
    }
  });

  test.describe('AC7: user moved on during the switch', () => {
    test('sidebar filter focused before the target opens keeps focus', async () => {
      const { app, win, cleanup } = await launch(['alpha', 'beta']);
      try {
        await openProject(win, 'alpha');
        const filter = win.locator(SIDEBAR_FILTER_INPUT);

        await clickRowsInOneTask(win, ['beta'], 'focus-sidebar-filter');

        await waitForProjectShown(win, 'beta');
        await expect(win.locator(`${PRIMARY} .xterm-screen`), 'positive control: beta\'s terminal opened').toBeVisible({ timeout: FOCUS_TIMEOUT });
        await expect(filter, 'the text-entry element keeps focus').toBeFocused();
        expect(await focusedTerminalCount(win), 'no terminal stole focus').toBe(0);
      } finally {
        await app.close();
        cleanup();
      }
    });

    test('switcher opened before the target opens keeps focus', async () => {
      const { app, win, cleanup } = await launch(['alpha', 'beta']);
      try {
        await openProject(win, 'alpha');

        // Keep click and palette shortcut in one task, using the actual
        // platform modifier (Ctrl on Linux/Windows, Meta on macOS).
        await win.evaluate((mac) => {
          const row = [...document.querySelectorAll<HTMLElement>('[data-testid="project-row"]')]
            .find((candidate) => candidate.textContent?.trim() === 'beta');
          if (!row) throw new Error('beta row missing');
          row.click();
          window.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'k', ctrlKey: !mac, metaKey: mac, bubbles: true,
          }));
        }, process.platform === 'darwin');

        await waitForProjectShown(win, 'beta');
        await expect(win.locator(`${PRIMARY} .xterm-screen`), 'positive control: beta\'s terminal opened').toBeVisible({ timeout: FOCUS_TIMEOUT });
        await expect(switcherInput(win), 'positive control: the overlay is still open').toBeVisible();
        await expect(switcherInput(win), 'the overlay keeps focus').toBeFocused();
        expect(await focusedTerminalCount(win), 'no terminal stole focus').toBe(0);
      } finally {
        await app.close();
        cleanup();
      }
    });
  });

  test('AC8: rapid switch alpha → beta → gamma — only gamma is focused', async () => {
    const { app, win, cleanup } = await launch(['alpha', 'beta', 'gamma']);
    try {
      await openProject(win, 'alpha');

      await clickRowsInOneTask(win, ['beta', 'gamma']);

      await expect.poll(() => primaryTerminalFocusedFor(win, 'gamma'), { timeout: FOCUS_TIMEOUT }).toBe(true);
      expect(await focusedTerminalCount(win)).toBe(1);
      await waitForShellOutput(win, 'gamma', 0, MOCK_CLAUDE_BANNER);
      await typeReachesPty(win, 'gamma', 0, 'hi', 'echo: hi');
      // Here beta's pick is superseded before its reply, so beta never
      // shows; the next test covers a beta that shows and opens first.
      expect(await aliveProjectNames(win), 'the superseded switch launched nothing').not.toContain('beta');
    } finally {
      await app.close();
      cleanup();
    }
  });

  test('AC8: beta\'s request issued, then gamma clicked before beta\'s terminal opens — beta never takes focus even though it opens first', async () => {
    // beta's `projects:open` resolves (its request is issued and it shows),
    // but its terminal is held at the open gate; gamma is clicked and its
    // `projects:open` is held in flight; only then does beta's terminal
    // open. The newer switch must have cancelled beta's request, so beta's
    // `opened()` focuses nothing.
    const { app, win, cleanup } = await launch(['alpha', 'beta', 'gamma']);
    try {
      await openProject(win, 'alpha');
      const hold = await holdProjectOpen(app, await projectIdByName(win, 'gamma'));
      const primaryScreen = win.locator(`${PRIMARY} .xterm-screen`);
      await hideTerminalHosts(win);
      await recordFocusins(win);

      await projectRow(win, 'beta').click();
      await waitForProjectShown(win, 'beta');
      await expect(win.locator(`${PRIMARY} [data-testid="shell-tab"]`), 'positive control: beta\'s terminal is mounted').toHaveCount(1);
      await expect(primaryScreen, 'positive control: beta\'s terminal has not opened yet').toHaveCount(0);

      await projectRow(win, 'gamma').click();
      await hold.waitReceived();
      await expect(primaryScreen, 'setup: beta still unopened once gamma\'s open is in flight (open gate bails after ~2 s)').toHaveCount(0);

      await showTerminalHosts(win);
      await expect(primaryScreen, 'positive control: beta\'s terminal opened while gamma\'s switch was in flight').toBeVisible({ timeout: FOCUS_TIMEOUT });
      expect(await win.title(), 'positive control: still showing beta').toBe('beta — MetaLogix IDE');
      await rememberPrimaryTextarea(win, 'beta');

      await hold.release();

      await expect.poll(() => primaryTerminalFocusedFor(win, 'gamma'), { timeout: FOCUS_TIMEOUT }).toBe(true);
      await rememberPrimaryTextarea(win, 'gamma');
      expect(await focusinsInclude(win, 'gamma'), 'positive control: the focusin recorder saw gamma\'s terminal take focus').toBe(true);
      expect(await focusinsInclude(win, 'beta'), 'beta\'s terminal never became document.activeElement').toBe(false);
      await typeReachesPty(win, 'gamma', 0, 'hi', 'echo: hi');
    } finally {
      await app.close();
      cleanup();
    }
  });

  test('AC10: clicking the already-selected project focuses its open terminal, with no remount', async () => {
    const { app, win, cleanup } = await launch(['alpha']);
    try {
      await openProject(win, 'alpha');
      const token = await markXterm(win);
      await blurToBody(win);
      expect(await focusedTerminalCount(win), 'positive control: the terminal is not focused before the click').toBe(0);

      await projectRow(win, 'alpha').click();

      await expect.poll(() => primaryTerminalFocusedFor(win, 'alpha'), { timeout: FOCUS_TIMEOUT }).toBe(true);
      expect(await xtermStillMarked(win, token), 'same xterm element: the terminal did not remount').toBe(true);
    } finally {
      await app.close();
      cleanup();
    }
  });

  test('AC11: switch to a project whose shell 0 is popped out — no main-window terminal focuses, the popout keeps its focus', async () => {
    const { app, win, cleanup } = await launch(['alpha', 'beta']);
    try {
      await openProject(win, 'beta');
      const [popout] = await Promise.all([
        app.waitForEvent('window'),
        win.getByTestId('popout-shell').click(),
      ]);
      await popout.waitForLoadState('domcontentloaded');
      await expect(popout.locator('[data-testid="shell-tab"] .xterm-screen')).toBeVisible({ timeout: 8000 });
      await expect.poll(() => terminalActiveIn(popout, '[data-testid="shell-tab"]'), { timeout: 3000 }).toBe(true);
      await expect(win.getByTestId('return-popout'), 'positive control: main window shows the placeholder').toBeVisible();

      await projectRow(win, 'alpha').click();
      await expect.poll(() => primaryTerminalFocusedFor(win, 'alpha'), { timeout: FOCUS_TIMEOUT }).toBe(true);

      await projectRow(win, 'beta').click();

      await waitForProjectShown(win, 'beta');
      await expect(win.getByTestId('return-popout'), 'positive control: beta\'s left pane is the popped placeholder').toBeVisible();
      await expect(win.locator('[data-testid="shell-tab"]'), 'no terminal mounted in the main window').toHaveCount(0);
      expect(await focusedTerminalCount(win), 'no main-window terminal focused').toBe(0);
      expect(await terminalActiveIn(popout, '[data-testid="shell-tab"]'), 'the popout\'s focus is unchanged').toBe(true);
    } finally {
      await app.close();
      cleanup();
    }
  });

  test.describe('AC15 (D14): a jump to shell N > 0 in another project shows and focuses shell N', () => {
    test('notification click (shell:focus-request)', async () => {
      const { app, win, cleanup } = await launch(['alpha', 'beta']);
      try {
        const { n, alphaId, betaId } = await betaWithShellNThenAlpha(win);

        await sendNotificationFocusRequest(app, { projectId: betaId, shellIndex: n });

        await assertJumpLandedOnShellN(win, { n, alphaId, betaId });
      } finally {
        await app.close();
        cleanup();
      }
    });

    test('scrollback-search jump (Enter)', async () => {
      const { app, win, cleanup } = await launch(['alpha', 'beta']);
      try {
        const needle = marker('needle');
        const { n, alphaId, betaId } = await betaWithShellNThenAlpha(win, needle);

        await blurToBody(win);
        await win.keyboard.press('ControlOrMeta+Shift+O');
        const overlay = win.getByTestId('scrollback-search');
        await expect(overlay).toBeVisible({ timeout: 2000 });
        const input = overlay.locator('input[placeholder^="Search live scrollback"]');
        await expect(input).toBeFocused({ timeout: 2000 });
        await input.fill(needle);
        const first = overlay.locator('button', { hasText: needle }).first();
        await expect(first).toBeVisible({ timeout: 5000 });
        await expect(first, 'positive control: the selected match is in beta').toContainText('beta');
        await win.keyboard.press('Enter');

        await expect(overlay).toHaveCount(0);
        await assertJumpLandedOnShellN(win, { n, alphaId, betaId });
      } finally {
        await app.close();
        cleanup();
      }
    });
  });
});

test('opening an existing OMP terminal shows its newest parsed scrollback in the first visible frame', async () => {
  test.setTimeout(120_000);
  const { app, win, cleanup } = await launch(['alpha']);
  try {
    await openProject(win, 'alpha');
    const projectId = await projectIdByName(win, 'alpha');
    await win.getByTestId('tabbar-new-shell').click();
    await win.getByRole('button', { name: 'Add a custom command…' }).click();
    await win.getByPlaceholder('Name (optional, e.g. Llama)').fill('OMP');
    await win.getByPlaceholder('Command, e.g. `llama chat --model llama3`')
      .fill(`node "${resolve(process.cwd(), 'scripts/mock-omp.mjs')}"`);
    await win.getByRole('button', { name: 'Run', exact: true }).click();
    await expect.poll(async () => (await rememberedState(win, projectId))?.activeShellIndex ?? 0).toBeGreaterThan(0);
    const ompIndex = (await rememberedState(win, projectId))?.activeShellIndex;
    if (ompIndex === undefined) throw new Error('OMP tab was not selected');
    await waitForShellOutput(win, 'alpha', ompIndex, 'mock-omp ready');

    // Stream deterministic lines through the real PTY, then remount from its serialized snapshot.
    const output = Array.from({ length: 180 }, (_, i) => `omp-output-${String(i).padStart(3, '0')}`).join('\n');
    await win.evaluate(({ id, index, data }) =>
      window.api.invoke('shells:write', { projectId: id, shellIndex: index, data: `${data}\r` }),
    { id: projectId, index: ompIndex, data: output });
    const latest = marker('omp-newest');
    await win.evaluate(({ id, index, text }) =>
      window.api.invoke('shells:write', { projectId: id, shellIndex: index, data: `${text}\r` }),
    { id: projectId, index: ompIndex, text: latest });
    await waitForShellOutput(win, 'alpha', ompIndex, latest);
    expect(await shellOutput(win, 'alpha', ompIndex), 'serialized snapshot retains older OMP output')
      .toContain('omp-output-000');
    const priorViewport = win.locator(`${PRIMARY} .xterm-viewport`);
    await expect.poll(() => priorViewport.evaluate((el) => el.scrollHeight - el.clientHeight))
      .toBeGreaterThan(0);

    await win.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(win.locator(`${PRIMARY} .xterm`)).toHaveCount(0);
    // Installed before the Shell click. The first rAF in which the terminal
    // host is visible records once; later settling cannot make this pass.
    await win.evaluate(() => {
      type Viewport = { scroll: number; max: number; height: number };
      const watch: { first: Viewport | null; expired: boolean } = { first: null, expired: false };
      Object.assign(window, { __ompFirstVisible: watch });
      const deadline = performance.now() + 10_000;
      const sample = () => {
        const host = document.querySelector('.split-left [data-testid="shell-tab"] > .isolate');
        const viewport = host?.querySelector('.xterm-viewport');
        if (host instanceof HTMLElement && viewport instanceof HTMLElement &&
          getComputedStyle(host).visibility === 'visible' && host.getClientRects().length > 0) {
          watch.first = {
            scroll: viewport.scrollTop,
            max: viewport.scrollHeight - viewport.clientHeight,
            height: viewport.clientHeight,
          };
        } else if (performance.now() < deadline) requestAnimationFrame(sample);
        else watch.expired = true;
      };
      requestAnimationFrame(sample);
    });
    await win.getByRole('button', { name: 'Shell', exact: true }).click();
    await expect.poll(() => win.evaluate(() => (window as typeof window & {
      __ompFirstVisible?: { first: { scroll: number; max: number; height: number } | null; expired: boolean };
    }).__ompFirstVisible?.first ?? null), { timeout: 11_000 }).not.toBeNull();
    const first = await win.evaluate(() => (window as typeof window & {
      __ompFirstVisible?: { first: { scroll: number; max: number; height: number } | null };
    }).__ompFirstVisible?.first);
    if (!first) throw new Error('First visible OMP frame was not sampled');
    const viewport = win.locator(`${PRIMARY} .xterm-viewport`);
    await expect.poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight), {
      message: 'positive control: restored OMP terminal eventually has scrollback',
    }).toBeGreaterThan(0);
    expect(first.height, 'first visible frame has a laid-out terminal').toBeGreaterThan(0);
    expect(first.max, 'positive control: the newly parsed screen has scrollback on its first visible frame').toBeGreaterThan(0);
    expect(first.scroll, `first visible frame must start at newest content (bottom=${first.max})`)
      .toBeGreaterThanOrEqual(first.max - 1);

    await viewport.evaluate((el) => { el.scrollTop = 0; });
    expect(await viewport.evaluate((el) => el.scrollTop), 'positive control: viewport measurement detects a traversal to older content').toBe(0);
  } finally {
    await app.close();
    cleanup();
  }
});

/** Tags the primary xterm element so a later read can tell whether it remounted. */
async function markXterm(win: Page): Promise<string> {
  const token = marker('xterm');
  await win.evaluate((t: string) => {
    const el = document.querySelector('.split-left .xterm');
    if (!el) throw new Error('no primary xterm to mark');
    (el as unknown as { __e2eMark?: string }).__e2eMark = t;
  }, token);
  return token;
}

async function xtermStillMarked(win: Page, token: string): Promise<boolean> {
  return win.evaluate((t: string) => {
    const el = document.querySelector('.split-left .xterm');
    return (el as unknown as { __e2eMark?: string } | null)?.__e2eMark === t;
  }, token);
}

/**
 * Opens beta, adds shell N (a Terminal tab; optionally echoing `needle` in it), puts
 * beta's remembered shell back to 0 — so a jump that ignores N visibly lands
 * on shell 0 — and leaves alpha showing.
 */
async function betaWithShellNThenAlpha(
  win: Page, needle?: string,
): Promise<{ n: number; alphaId: number; betaId: number }> {
  await openProject(win, 'beta');
  const betaId = await projectIdByName(win, 'beta');
  const alphaId = await projectIdByName(win, 'alpha');
  const n = await newShellTab(win, 'beta');
  expect(n, 'positive control: the new tab is not shell 0').toBeGreaterThan(0);
  if (needle) {
    await win.locator(`${PRIMARY} .xterm`).click();
    await typeReachesPty(win, 'beta', n, `echo ${needle}`, needle);
  }
  // Shell 0 runs `node mock-claude.mjs`, so its tab is labelled "Node".
  await win.getByText('Node', { exact: true }).first().click();
  await expect.poll(async () => (await rememberedState(win, betaId))?.activeShellIndex ?? 0).toBe(0);
  await openProject(win, 'alpha');
  expect((await rememberedState(win, alphaId))?.activeShellIndex ?? 0, 'positive control: alpha remembers shell 0').toBe(0);
  if (needle) expect(await shellOutput(win, 'alpha', 0), 'positive control: only beta holds the needle').not.toContain(needle);
  return { n, alphaId, betaId };
}

async function assertJumpLandedOnShellN(
  win: Page, { n, alphaId, betaId }: { n: number; alphaId: number; betaId: number },
): Promise<void> {
  await waitForProjectShown(win, 'beta');
  await expect.poll(async () => (await rememberedState(win, betaId))?.activeShellIndex, {
    timeout: FOCUS_TIMEOUT, message: 'beta shows shell N as its active tab',
  }).toBe(n);
  await expect.poll(() => primaryTerminalFocusedFor(win, 'beta'), { timeout: FOCUS_TIMEOUT }).toBe(true);
  const m = marker('jump');
  await typeReachesPty(win, 'beta', n, `echo ${m}`, m);
  expect(await shellOutput(win, 'beta', 0), 'typed text did not go to shell 0').not.toContain(m);
  expect((await rememberedState(win, alphaId))?.activeShellIndex ?? 0, 'alpha\'s remembered shell index was not overwritten').toBe(0);

  // Switching back shows alpha's own remembered shell (0), not N.
  await projectRow(win, 'alpha').click();
  await expect.poll(() => primaryTerminalFocusedFor(win, 'alpha'), { timeout: FOCUS_TIMEOUT }).toBe(true);
  await typeReachesPty(win, 'alpha', 0, 'hi', 'echo: hi');
}
