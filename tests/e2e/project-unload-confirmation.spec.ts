/**
 * Local shell-0 unload (approved AC1–AC7). Real Electron, main-process IPC,
 * node-pty and mock Claude; only the two race/failure tests gate an IPC handler.
 * The other journeys drive the actual row, header and palette controls.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  UNLOAD_SESSION_COPY as COPY,
  UNLOAD_SESSION_TESTIDS as IDS,
} from '../../src/renderer/unload-session-copy';
import type { PrimarySessionInspection } from '../../src/shared/unload-session-contract';
import { PALETTE_TESTIDS } from '../../src/renderer/command-palette-contract';
import { SPLIT_TESTIDS } from '../../src/renderer/split-copy';
import {
  launchStatus,
  projectId,
  openProject,
  sendLine,
  waitForShell,
  expectShellState,
  launchCli,
  launchPlain,
  kill,
  type StatusHarness,
} from './helpers/agent-status-harness';
import { aliveShells } from './helpers/claude-harness';
import { chipSel, splitState } from './helpers/split';
import { ipcLog, recordIpc } from './helpers/frames';

type Api = { invoke: (channel: string, request: unknown) => Promise<unknown> };
type Handler = (event: unknown, ...args: unknown[]) => unknown;
type Entry = 'row' | 'header' | 'palette';

const dialog = (win: Page) => win.getByTestId(IDS.dialog);
const warning = (win: Page) => dialog(win).getByTestId(IDS.warning);
const keep = (win: Page) => dialog(win).getByTestId(IDS.keep);
const confirm = (win: Page) => dialog(win).getByTestId(IDS.unload);
const inUseRow = (win: Page, name: string) =>
  win
    .getByTestId('section-in-use')
    .locator('[data-testid="project-row"]')
    .filter({ has: win.getByText(name, { exact: true }) });
const rowUnload = (win: Page, name: string) =>
  inUseRow(win, name).locator('..').getByTestId('row-unload');

async function withApp(names: string[], run: (h: StatusHarness) => Promise<void>): Promise<void> {
  const h = await launchStatus(names);
  try {
    await run(h);
  } finally {
    await h.close();
  }
}

async function inspect(win: Page, id: number): Promise<PrimarySessionInspection> {
  const result: unknown = await win.evaluate(
    async (projectId: number) =>
      (window as unknown as { api: Api }).api.invoke('shells:inspect-primary', { projectId }),
    id,
  );
  if (result && typeof result === 'object' && 'kind' in result) {
    if (result.kind === 'gone') return { kind: 'gone' };
    if (
      result.kind === 'live' &&
      'generation' in result &&
      typeof result.generation === 'string' &&
      'agent' in result &&
      'state' in result
    ) {
      if (
        result.state !== null &&
        result.state !== 'idle' &&
        result.state !== 'busy' &&
        result.state !== 'blocked'
      )
        throw new Error('inspect-primary returned invalid state');
      if (result.agent !== null && result.agent !== 'claude' && result.agent !== 'omp')
        throw new Error('inspect-primary returned invalid agent');
      return {
        kind: 'live',
        generation: result.generation,
        agent: result.agent,
        state: result.state,
      };
    }
  }
  throw new Error('inspect-primary returned an invalid response');
}

async function generation(win: Page, id: number): Promise<string> {
  const state = await inspect(win, id);
  if (state.kind !== 'live') throw new Error(`project ${id} has no primary shell`);
  return state.generation;
}

async function indices(win: Page, id: number): Promise<number[]> {
  return (await aliveShells(win))
    .filter((s) => s.projectId === id)
    .map((s) => s.shellIndex)
    .sort((a, b) => a - b);
}

async function expectLive(win: Page, id: number, expected: number[]): Promise<void> {
  await expect
    .poll(() => indices(win, id), { message: `live PTYs for project ${id}` })
    .toEqual(expected);
}

async function openUnload(win: Page, entry: Entry, name: string): Promise<void> {
  if (entry === 'row') await rowUnload(win, name).click();
  else if (entry === 'header') await win.getByTestId('unload-current').click();
  else {
    await win.keyboard.press('ControlOrMeta+Shift+P');
    const palette = win.getByTestId(PALETTE_TESTIDS.root);
    await expect(palette).toBeVisible();
    await palette.getByTestId(PALETTE_TESTIDS.input).fill('>Unload current session');
    await palette.getByRole('option', { name: /Unload current session/ }).click();
    await expect(palette).toHaveCount(0);
  }
  await expect(dialog(win)).toBeVisible();
  const panel = dialog(win).getByRole('dialog', { name: COPY.title });
  await expect(panel).toHaveAttribute('aria-modal', 'true');
  await expect(panel).toHaveAttribute('aria-describedby', /.+/);
  await expect(dialog(win).getByTestId(IDS.description)).toContainText(COPY.consequence(name));
  await expect(keep(win)).toBeFocused();
  await expect(confirm(win)).toBeVisible();
}

async function replacePrimary(win: Page, id: number): Promise<string> {
  await kill(win, id, 0);
  await expectLive(win, id, []);
  const index = await win.evaluate(async (projectId: number) => {
    const result = await (window as unknown as { api: Api }).api.invoke('shells:launch', {
      projectId,
    });
    if (
      !result ||
      typeof result !== 'object' ||
      !('shellIndex' in result) ||
      typeof result.shellIndex !== 'number'
    )
      throw new Error('replacement launch did not return shellIndex');
    return result.shellIndex;
  }, id);
  expect(index, 'a new launch reuses the old primary index').toBe(0);
  await waitForShell(win, id, 0, 'mock-claude resumed');
  return generation(win, id);
}

/** Gated wrapper delegates to the real handler after release, never fabricating a stop result. */
async function gateStop(
  app: ElectronApplication,
): Promise<{ calls: () => Promise<number>; release: () => Promise<void> }> {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })
      ._invokeHandlers;
    const original = handlers?.get('shells:stop-primary');
    if (!original) throw new Error('missing real shells:stop-primary IPC handler');
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = { calls: 0, release };
    (globalThis as unknown as { __e2eStopGate: typeof state }).__e2eStopGate = state;
    ipcMain.removeHandler('shells:stop-primary');
    ipcMain.handle('shells:stop-primary', async (event, ...args: unknown[]) => {
      state.calls++;
      await gate;
      return original(event, ...args);
    });
  });
  return {
    calls: () =>
      app.evaluate(() => {
        // Test seam installed by gateStop in the same Electron main process.
        const state = globalThis as unknown as { __e2eStopGate: { calls: number } };
        return state.__e2eStopGate.calls;
      }),
    release: () =>
      app.evaluate(() => {
        const state = globalThis as unknown as { __e2eStopGate: { release: () => void } };
        state.__e2eStopGate.release();
      }),
  };
}

for (const entry of ['row', 'header', 'palette'] as const) {
  test(`AC1/AC2/AC5: ${entry} keeps the named primary alive on cancel, then stops only that primary after confirmation`, async () => {
    await withApp(['alpha', 'beta'], async ({ app, win }) => {
      await openProject(win, 'alpha');
      const alpha = await projectId(win, 'alpha');
      await openProject(win, 'beta');
      const beta = await projectId(win, 'beta');
      const targetName = entry === 'row' ? 'alpha' : 'beta';
      const target = entry === 'row' ? alpha : beta;
      const other = entry === 'row' ? beta : alpha;
      const sibling = await launchPlain(win, target);
      expect(sibling).toBe(1);
      await expectLive(win, target, [0, sibling]);
      const original = await generation(win, target);
      const otherGeneration = await generation(win, other);
      const title = await win.title();
      await recordIpc(app);
      await openUnload(win, entry, targetName);
      await expectLive(win, target, [0, sibling]);
      expect(await generation(win, target)).toBe(original);
      expect(await win.title(), 'opening the dialog does not change selection').toBe(title);
      await win.keyboard.press('Enter'); // safe initial focus
      await expect(dialog(win)).toHaveCount(0);
      await expectLive(win, target, [0, sibling]);
      expect(await generation(win, target)).toBe(original);
      await openUnload(win, entry, targetName);
      await keep(win).click();
      await expect(dialog(win)).toHaveCount(0);
      await expectLive(win, target, [0, sibling]);
      expect(
        (await ipcLog(app)).filter(
          (call) => call.ch === 'shells:stop-primary' || call.ch === 'shells:kill',
        ),
        'opening and canceling do not send a stop or a legacy kill',
      ).toEqual([]);
      await openUnload(win, entry, targetName);
      await confirm(win).click();
      await expect(dialog(win)).toHaveCount(0);
      await expectLive(win, target, [sibling]);
      expect(await inspect(win, target)).toEqual({ kind: 'gone' });
      await expect(
        inUseRow(win, targetName),
        'nonzero survivor keeps the project In use',
      ).toHaveCount(1);
      await expect(rowUnload(win, targetName)).toHaveCount(0);
      await expectLive(win, other, [0]);
      expect(await generation(win, other), 'other project PTY generation survives').toBe(
        otherGeneration,
      );
      const stops = (await ipcLog(app)).filter((call) => call.ch === 'shells:stop-primary');
      expect(stops, 'one generation-bound stop for the selected target').toHaveLength(1);
      expect(stops[0]?.req).toEqual(
        expect.objectContaining({ projectId: target, generation: original }),
      );
      expect(
        (await ipcLog(app)).filter((call) => call.ch === 'shells:kill'),
        'unload does not fall back to legacy index-based kill',
      ).toEqual([]);
      expect(await win.title(), 'selection remains unchanged').toBe(title);
    });
  });
}

test('AC2: Escape and backdrop dismiss, restore focus, and background cannot be clicked while confirmation is open', async () => {
  await withApp(['alpha'], async ({ win }) => {
    await openProject(win, 'alpha');
    const id = await projectId(win, 'alpha');
    const first = await generation(win, id);
    const trigger = win.getByTestId('unload-current');
    await openUnload(win, 'header', 'alpha');
    await win.keyboard.press('Escape');
    await expect(dialog(win)).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await openUnload(win, 'header', 'alpha');
    await expect(dialog(win).getByRole('dialog', { name: COPY.title })).toHaveAttribute(
      'aria-modal',
      'true',
    );
    await win.keyboard.press('Tab');
    await expect
      .poll(() =>
        win.evaluate(
          () => document.activeElement?.closest('[data-testid="unload-session-dialog"]') !== null,
        ),
      )
      .toBe(true);
    await expect(
      win.getByTestId('settings-open').click({ timeout: 700 }),
      'the modal blocks background clicks',
    ).rejects.toThrow();
    await expect(dialog(win)).toBeVisible();
    const bounds = await dialog(win).boundingBox();
    if (!bounds) throw new Error('dialog has no visible bounds');
    await win.mouse.click(2, bounds.y + bounds.height / 2);
    await expect(dialog(win)).toHaveCount(0);
    await expectLive(win, id, [0]);
    expect(await generation(win, id)).toBe(first);
  });
});

test('AC3: busy and blocked primary warn even when Files is selected; another project may be busy without attributing that work to primary', async () => {
  await withApp(['alpha', 'beta'], async ({ win }) => {
    await openProject(win, 'alpha');
    const alpha = await projectId(win, 'alpha');
    await sendLine(win, alpha, 0, '/status-work');
    await expectShellState(win, alpha, 0, 'busy');
    await openProject(win, 'beta');
    const beta = await projectId(win, 'beta');
    await openUnload(win, 'header', 'beta');
    await expect(warning(win), 'beta must not inherit alpha busy state').not.toContainText(
      COPY.workWarning,
    );
    await keep(win).click();
    await openProject(win, 'alpha');
    await win.getByRole('button', { name: 'Files', exact: true }).click();
    await openUnload(win, 'header', 'alpha');
    await expect(warning(win)).toContainText(COPY.workWarning);
    await expect(warning(win)).not.toContainText(COPY.visibleWarning);
    await keep(win).click();
    await sendLine(win, alpha, 0, '/status-approval');
    await expectShellState(win, alpha, 0, 'blocked');
    await openUnload(win, 'header', 'alpha');
    await expect(warning(win)).toContainText(COPY.inputWarning);
    await expect(warning(win)).not.toContainText(COPY.visibleWarning);
    await keep(win).click();
    await expectLive(win, alpha, [0]);
    await expectLive(win, beta, [0]);
  });
});

test('AC3/AC4: a busy nonzero sibling does not claim primary work; hidden shell 0 stays neutral behind another shell tab', async () => {
  await withApp(['alpha'], async ({ win, claude }) => {
    await openProject(win, 'alpha');
    const id = await projectId(win, 'alpha');
    const sibling = await launchCli(win, id, 'Claude', [claude]);
    expect(sibling).toBe(1);
    await win.locator(chipSel(sibling)).click();
    await expect.poll(async () => (await splitState(win, id))?.activeShellIndex).toBe(sibling);
    await sendLine(win, id, sibling, '/status-work');
    await expectShellState(win, id, sibling, 'busy');
    await expectShellState(win, id, 0, 'idle');
    await openUnload(win, 'header', 'alpha');
    await expect(warning(win), 'idle hidden primary has no busy or visible warning').toHaveCount(0);
    await confirm(win).click();
    await expectLive(win, id, [sibling]);
    await expectShellState(win, id, sibling, 'busy');
  });
});

test('AC4: idle shell 0 visible as the active tab warns of the terminal being stopped', async () => {
  await withApp(['alpha'], async ({ win }) => {
    await openProject(win, 'alpha');
    const id = await projectId(win, 'alpha');
    await expectShellState(win, id, 0, 'idle');
    await expect(win.locator('.split-left [data-testid="shell-tab"] .xterm-screen')).toBeVisible();
    await openUnload(win, 'header', 'alpha');
    await expect(warning(win)).toContainText(COPY.visibleWarning);
    await expect(warning(win)).not.toContainText(COPY.workWarning);
    await keep(win).click();
    await expectLive(win, id, [0]);
  });
});

test('AC4: a restored split showing shell 0 in the right pane warns despite another active tab', async () => {
  await withApp(['alpha'], async ({ win }) => {
    await openProject(win, 'alpha');
    const id = await projectId(win, 'alpha');
    const sibling = await launchPlain(win, id);
    expect(sibling).toBe(1);
    // Restore a persisted layout: the real PTYs and React ShellSplit still render both panes.
    await win.evaluate(
      ({ projectId, active }) => {
        localStorage.setItem(
          'metaide.projectStates',
          JSON.stringify({
            [projectId]: { activeShellIndex: active, rightShellIndex: 0, splitRatio: 0.5 },
          }),
        );
      },
      { projectId: id, active: sibling },
    );
    await win.reload();
    await openProject(win, 'alpha');
    await expect.poll(async () => (await splitState(win, id))?.rightShellIndex).toBe(0);
    await expect(win.getByTestId(SPLIT_TESTIDS.right).locator('.xterm-screen')).toBeVisible();
    await expectLive(win, id, [0, sibling]);
    await openUnload(win, 'header', 'alpha');
    await expect(warning(win)).toContainText(COPY.visibleWarning);
    await keep(win).click();
    await expectLive(win, id, [0, sibling]);
  });
});

test('AC1/AC5: no primary disables row, header and palette unload despite live sibling retaining In use', async () => {
  await withApp(['alpha'], async ({ win }) => {
    await openProject(win, 'alpha');
    const id = await projectId(win, 'alpha');
    const sibling = await launchPlain(win, id);
    expect(sibling).toBe(1);
    await kill(win, id, 0);
    await expectLive(win, id, [sibling]);
    await expect(inUseRow(win, 'alpha')).toHaveCount(1);
    await expect(rowUnload(win, 'alpha')).toHaveCount(0);
    await expect(win.getByTestId('unload-current')).toHaveCount(0);
    await win.keyboard.press('ControlOrMeta+Shift+P');
    const palette = win.getByTestId(PALETTE_TESTIDS.root);
    await palette.getByTestId(PALETTE_TESTIDS.input).fill('>Unload current session');
    await expect(palette.getByRole('option', { name: /Unload current session/ })).toHaveCount(0);
    await win.keyboard.press('Escape');
    await expect(dialog(win)).toHaveCount(0);
    await expectLive(win, id, [sibling]);
    await kill(win, id, sibling);
    await expectLive(win, id, []);
    await expect(inUseRow(win, 'alpha')).toHaveCount(0);
  });
});

test('AC6: work starting after neutral consent warns before a newly informed confirmation', async () => {
  await withApp(['alpha'], async ({ win }) => {
    await openProject(win, 'alpha');
    const id = await projectId(win, 'alpha');
    await win.getByRole('button', { name: 'Files', exact: true }).click();
    const original = await generation(win, id);
    await openUnload(win, 'header', 'alpha');
    await expect(warning(win), 'Files hides the idle primary').toHaveCount(0);
    await sendLine(win, id, 0, '/status-work');
    await expectShellState(win, id, 0, 'busy');
    await expect(warning(win)).toContainText(COPY.workWarning);
    await confirm(win).click();
    await expect(dialog(win)).toBeVisible();
    await expect(warning(win)).toContainText(COPY.workWarning);
    await expectLive(win, id, [0]);
    expect(await generation(win, id), 'old neutral consent did not kill the new busy state').toBe(
      original,
    );
    await confirm(win).click();
    await expectLive(win, id, []);
  });
});

test('AC6: shell 0 becoming visible after neutral consent warns before a newly informed confirmation', async () => {
  await withApp(['alpha'], async ({ win }) => {
    await openProject(win, 'alpha');
    const id = await projectId(win, 'alpha');
    await win.getByRole('button', { name: 'Files', exact: true }).click();
    await openUnload(win, 'header', 'alpha');
    await expect(warning(win), 'Files hides the idle primary').toHaveCount(0);
    // A state change outside the modal models the shell becoming visible while consent is pending.
    await win.evaluate(() => {
      const tab = [...document.querySelectorAll<HTMLElement>('button')].find(
        (b) => b.textContent?.trim() === 'Shell',
      );
      if (!tab) throw new Error('missing Shell main tab');
      tab.click();
    });
    await expect(win.locator('.split-left [data-testid="shell-tab"] .xterm-screen')).toBeVisible();
    await expect(warning(win)).toContainText(COPY.visibleWarning);
    await confirm(win).click();
    await expect(dialog(win)).toBeVisible();
    await expect(warning(win)).toContainText(COPY.visibleWarning);
    await expectLive(win, id, [0]);
    await confirm(win).click();
    await expectLive(win, id, []);
  });
});

test('AC6: replacing primary before confirmation cannot transfer prior consent to the new generation', async () => {
  await withApp(['alpha'], async ({ win }) => {
    await openProject(win, 'alpha');
    const id = await projectId(win, 'alpha');
    const first = await generation(win, id);
    await openUnload(win, 'header', 'alpha');
    const next = await replacePrimary(win, id);
    expect(next).not.toBe(first);
    if (await confirm(win).isVisible()) await confirm(win).click();
    await expectLive(win, id, [0]);
    expect(await generation(win, id), 'replacement survives stale confirmation').toBe(next);
    await expect(win.getByTestId('toast').filter({ hasText: 'Session unloaded' })).toHaveCount(0);
  });
});

test('AC6: replacement after submit but before main stop cannot be killed by a stale generation', async () => {
  await withApp(['alpha'], async ({ app, win }) => {
    await openProject(win, 'alpha');
    const id = await projectId(win, 'alpha');
    const first = await generation(win, id);
    const gate = await gateStop(app);
    let next: string;
    try {
      await openUnload(win, 'header', 'alpha');
      await confirm(win).click();
      await expect.poll(gate.calls, { message: 'stop request has reached main process' }).toBe(1);
      await expect(confirm(win)).toBeDisabled();
      next = await replacePrimary(win, id);
    } finally {
      await gate.release();
    }
    expect(next).not.toBe(first);
    await expectLive(win, id, [0]);
    expect(await generation(win, id), 'the new PTY must survive the delayed stop').toBe(next);
    await expect(win.getByTestId('toast').filter({ hasText: 'Session unloaded' })).toHaveCount(0);
    expect(await gate.calls(), 'no duplicate stop from the one click').toBe(1);
  });
});

test('AC6: rejected stop shows a retryable failure and leaves original PTY running', async () => {
  await withApp(['alpha'], async ({ app, win }) => {
    await openProject(win, 'alpha');
    const id = await projectId(win, 'alpha');
    const before = await generation(win, id);
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('shells:stop-primary');
      ipcMain.handle('shells:stop-primary', async () => {
        throw new Error('e2e: stop refused');
      });
    });
    await openUnload(win, 'header', 'alpha');
    await confirm(win).click();
    await expect(dialog(win).getByTestId(IDS.error)).toContainText(COPY.stopFailed);
    await expect(dialog(win).getByTestId(IDS.retry)).toBeVisible();
    await expectLive(win, id, [0]);
    expect(await generation(win, id), 'failure does not destroy original PTY').toBe(before);
    await keep(win).click();
    await expect(dialog(win)).toHaveCount(0);
    await expectLive(win, id, [0]);
  });
});

test('AC6: an unreadable status is not treated as idle and Retry inspects the real shell', async () => {
  await withApp(['alpha'], async ({ app, win }) => {
    await openProject(win, 'alpha');
    const id = await projectId(win, 'alpha');
    const original = await generation(win, id);
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })
        ._invokeHandlers;
      const real = handlers?.get('shells:inspect-primary');
      if (!real) throw new Error('missing inspect-primary handler');
      let calls = 0;
      ipcMain.removeHandler('shells:inspect-primary');
      ipcMain.handle('shells:inspect-primary', (event, ...args: unknown[]) => {
        if (++calls === 1) throw new Error('e2e: status unavailable');
        return real(event, ...args);
      });
    });
    await win.getByTestId('unload-current').click();
    await expect(dialog(win).getByTestId(IDS.error)).toContainText(COPY.inspectionFailed);
    await expect(confirm(win)).toHaveCount(0);
    await expectLive(win, id, [0]);
    expect(await generation(win, id)).toBe(original);
    await dialog(win).getByTestId(IDS.retry).click();
    await expect(dialog(win).getByTestId(IDS.description)).toContainText(COPY.consequence('alpha'));
    await keep(win).click();
    await expectLive(win, id, [0]);
  });
});

test('AC6: a session that exits before confirmation is not reported as unloaded', async () => {
  await withApp(['alpha'], async ({ win }) => {
    await openProject(win, 'alpha');
    const id = await projectId(win, 'alpha');
    await openUnload(win, 'header', 'alpha');
    await kill(win, id, 0);
    await expectLive(win, id, []);
    if (await confirm(win).isVisible()) await confirm(win).click();
    await expect(win.getByTestId('toast').filter({ hasText: 'Session unloaded' })).toHaveCount(0);
    await expectLive(win, id, []);
    await expect(win.getByTestId('unload-current')).toHaveCount(0);
  });
});
