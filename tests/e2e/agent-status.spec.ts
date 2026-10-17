import { test, expect, type Page } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_DOT } from '../../src/shared/agent-state';
import { PALETTE_TESTIDS } from '../../src/renderer/command-palette-contract';
import {
  launchStatus,
  openProject,
  projectId,
  sendLine,
  waitForShell,
  launchCli,
  launchPlain,
  kill,
  expectShellState,
  tabDot,
  rowDot,
  chipDot,
  inUseDot,
  expectAgentDot,
  expectInactiveAgentIdle,
  expectAggregate,
  statusSnapshot,
} from './helpers/agent-status-harness';
import {
  hookCredentials,
  postRawHook,
  installNotificationSpy,
  notifications,
  type Api,
} from './helpers/claude-harness';

async function paletteDot(win: Page, project: string) {
  await win.keyboard.press('ControlOrMeta+k');
  const palette = win.getByTestId(PALETTE_TESTIDS.root);
  await expect(palette).toBeVisible();
  return palette
    .getByRole('option')
    .filter({ has: win.getByText(project, { exact: true }) })
    .getByTestId(AGENT_DOT.testId);
}

test('AC1/AC4/AC12/AC13: undecorated app-launched Claude follows its screen through five states, not contradictory hooks', async () => {
  const h = await launchStatus(['demo'], { unavailableHooks: true });
  try {
    await openProject(h.win, 'demo');
    const id = await projectId(h.win, 'demo');
    await waitForShell(h.win, id, 0, 'mock-claude ready');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'idle');
    await sendLine(h.win, id, 0, '/hook-argv');
    await waitForShell(h.win, id, 0, 'HOOK-ARGV count=0');
    await sendLine(h.win, id, 0, '/status-work');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'busy');
    await expectAggregate(chipDot(h.win), 'busy');
    await sendLine(h.win, id, 0, '/status-approval');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'blocked');
    await expectAggregate(chipDot(h.win), 'blocked');
    await sendLine(h.win, id, 0, '/status-resume');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'busy');
    await sendLine(h.win, id, 0, '/status-ready');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'idle');
    await expectAggregate(chipDot(h.win), 'idle');
  } finally {
    await h.close();
  }
});

test('Claude terminal title, current spinner, and confirmation form drive live status dots', async () => {
  const h = await launchStatus(['demo']);
  try {
    await openProject(h.win, 'demo');
    const id = await projectId(h.win, 'demo');
    await waitForShell(h.win, id, 0, 'mock-claude ready');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'idle');
    await sendLine(h.win, id, 0, '/status-title-work');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'busy');
    await sendLine(h.win, id, 0, '/status-modern-approval');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'blocked');
    await sendLine(h.win, id, 0, '/status-modern-work');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'busy');
    await sendLine(h.win, id, 0, '/status-ready');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'idle');
  } finally {
    await h.close();
  }
});

test('AC3/AC7/AC10: exiting and relaunching Claude clears the old blocked spawn without a hook', async () => {
  const h = await launchStatus(['demo']);
  try {
    await openProject(h.win, 'demo');
    const id = await projectId(h.win, 'demo');
    await sendLine(h.win, id, 0, '/status-approval');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'blocked');
    await kill(h.win, id, 0);
    await expect
      .poll(async () =>
        (await statusSnapshot(h.win)).some((s) => s.projectId === id && s.shellIndex === 0),
      )
      .toBe(false);
    const next = await h.win.evaluate(async (projectId: number) => {
      const appWindow = window as unknown as {
        api: { invoke: (channel: string, req: unknown) => Promise<unknown> };
      };
      const result = await appWindow.api.invoke('shells:launch', { projectId });
      if (
        !result ||
        typeof result !== 'object' ||
        !('shellIndex' in result) ||
        typeof result.shellIndex !== 'number'
      )
        throw new Error('shell relaunch returned no shellIndex');
      return result.shellIndex;
    }, id);
    await waitForShell(h.win, id, next, 'mock-claude resumed');
    await expectAgentDot(tabDot(h.win, next), 'claude', 'idle');
    await sendLine(h.win, id, next, '/status-work');
    await expectAgentDot(tabDot(h.win, next), 'claude', 'busy'); // positive control: replacement can report
  } finally {
    await h.close();
  }
});

test('AC1/AC2/AC3: historic approval, scroll position, and unrelated text cannot override the live ready prompt', async () => {
  const h = await launchStatus(['demo']);
  try {
    await openProject(h.win, 'demo');
    const id = await projectId(h.win, 'demo');
    await sendLine(h.win, id, 0, '/status-approval');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'blocked'); // positive control: same approval live is recognized
    await sendLine(h.win, id, 0, '/status-history');
    await waitForShell(h.win, id, 0, 'Allow Bash command?');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'idle');
    await h.win.locator('.xterm').first().hover();
    await h.win.mouse.wheel(0, -2000);
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'idle');
    await sendLine(h.win, id, 0, '/status-work');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'busy'); // positive control after negative scrollback assertions
    await sendLine(h.win, id, 0, '/status-question');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'blocked');
    await sendLine(h.win, id, 0, '/status-ready');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'idle');
  } finally {
    await h.close();
  }
});

test('AC2/AC3: an unrelated Node foreground printing Claude-like prompts stays idle', async () => {
  const h = await launchStatus(['demo']);
  try {
    await openProject(h.win, 'demo');
    const id = await projectId(h.win, 'demo');
    const fake = await launchCli(h.win, id, 'Unrelated Node', [
      process.execPath,
      join(process.cwd(), 'scripts/mock-claude.mjs'),
    ]);
    await waitForShell(h.win, id, fake, 'mock-claude ready');
    await sendLine(h.win, id, fake, '/status-approval');
    await waitForShell(h.win, id, fake, 'Allow Bash command?');
    await expectShellState(h.win, id, fake, 'idle');
    await sendLine(h.win, id, fake, '/status-work');
    await waitForShell(h.win, id, fake, 'Esc to interrupt');
    await expectShellState(h.win, id, fake, 'idle');
    await sendLine(h.win, id, 0, '/status-work');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'busy'); // control: same spinner in recognized shell works
    await sendLine(h.win, id, 0, '/status-approval');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'blocked'); // control: same screen in recognized shell blocks
    await expectAggregate(rowDot(h.win, 'demo'), 'blocked');
  } finally {
    await h.close();
  }
});

test('AC4: user --settings Claude launch still has working screen status without app hooks', async () => {
  const h = await launchStatus(['demo']);
  try {
    await openProject(h.win, 'demo');
    const id = await projectId(h.win, 'demo');
    const settings = join(h.home, 'user-settings.json');
    writeFileSync(settings, JSON.stringify({ hooks: {} }));
    const index = await launchCli(h.win, id, 'Claude with settings', [
      h.claude,
      '--settings',
      settings,
    ]);
    await waitForShell(h.win, id, index, 'mock-claude ready');
    await sendLine(h.win, id, index, '/hook-argv');
    await waitForShell(h.win, id, index, `HOOK-ARGV count=1 path=${settings}`);
    await expectInactiveAgentIdle(h.win, id, index, 'claude');
    await sendLine(h.win, id, index, '/status-work');
    await expectAgentDot(tabDot(h.win, index), 'claude', 'busy');
    await sendLine(h.win, id, index, '/status-approval');
    await expectAgentDot(tabDot(h.win, index), 'claude', 'blocked');
    await sendLine(h.win, id, index, '/status-ready');
    await expectInactiveAgentIdle(h.win, id, index, 'claude');
  } finally {
    await h.close();
  }
});

test('AC1/AC12: authenticated contradictory Claude notification hooks never become status authority', async () => {
  const h = await launchStatus(['demo', 'other']);
  try {
    await installNotificationSpy(h.app);
    await openProject(h.win, 'demo');
    const id = await projectId(h.win, 'demo');
    const creds = await hookCredentials(h.win, h.home, id, 0);
    await sendLine(h.win, id, 0, '/status-work');
    await expectShellState(h.win, id, 0, 'busy');
    expect((await postRawHook(creds, { hook_event_name: 'Stop' })).status).toBe(204);
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'busy');
    await sendLine(h.win, id, 0, '/status-ready');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'idle');
    expect((await postRawHook(creds, { hook_event_name: 'UserPromptSubmit' })).status).toBe(204);
    expect((await postRawHook(creds, { hook_event_name: 'PermissionRequest' })).status).toBe(204);
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'idle');
    await openProject(h.win, 'other'); // background demo without relying on a window manager
    // Notification policy remains separate: an authenticated needs-input event
    // still creates an OS notification while the terminal dot remains idle.
    expect(
      (
        await postRawHook(creds, {
          hook_event_name: 'Notification',
          notification_type: 'permission_prompt',
          message: 'Approval required',
        })
      ).status,
    ).toBe(204);
    await expect
      .poll(() => notifications(h.app))
      .toContainEqual(expect.objectContaining({ body: 'Approval required' }));
    await expectShellState(h.win, id, 0, 'idle');
    await openProject(h.win, 'demo');
    await sendLine(h.win, id, 0, '/status-approval');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'blocked'); // positive blocked control
  } finally {
    await h.close();
  }
});

test('AC11/AC12: disabling both Claude notification toggles leaves Claude and OMP dots live', async () => {
  const h = await launchStatus(['demo', 'other']);
  try {
    await installNotificationSpy(h.app);
    await openProject(h.win, 'demo');
    const id = await projectId(h.win, 'demo');
    const creds = await hookCredentials(h.win, h.home, id, 0);
    await h.win.getByTestId('settings-open').click();
    const modal = h.win.getByTestId('settings-modal');
    const needsInput = modal.getByTestId('notify-needs-input-toggle');
    const finished = modal.getByTestId('notify-finished-toggle');
    await expect(needsInput).toBeChecked();
    await expect(finished).toBeChecked();
    await needsInput.click();
    await finished.click();
    await h.win.getByTestId('settings-done').click();
    await sendLine(h.win, id, 0, '/status-work');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'busy');
    await sendLine(h.win, id, 0, '/status-approval');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'blocked');
    const omp = await launchCli(h.win, id, 'OMP', [h.omp]);
    await waitForShell(h.win, id, omp, 'mock-omp ready');
    await sendLine(h.win, id, omp, '/start');
    await expectAgentDot(tabDot(h.win, omp), 'omp', 'busy');
    await expectAggregate(rowDot(h.win, 'demo'), 'blocked');
    await openProject(h.win, 'other'); // Linux Xvfb has no window manager to minimize a window
    expect(
      (
        await postRawHook(creds, {
          hook_event_name: 'Notification',
          notification_type: 'permission_prompt',
          message: 'muted',
        })
      ).status,
    ).toBe(204);
    await expectShellState(h.win, id, 0, 'blocked'); // control: live dot unaffected by toggle
    expect(await notifications(h.app)).toHaveLength(0);
    await openProject(h.win, 'demo');
    await h.win.getByTestId('settings-open').click();
    await modal.getByTestId('notify-needs-input-toggle').click();
    await expect(needsInput).toBeChecked();
    await h.win.getByTestId('settings-done').click();
    await expect
      .poll(
        async () => {
          const result = await h.win.evaluate(() =>
            (
              window as unknown as {
                api: {
                  invoke: (channel: string, args: { key: string }) => Promise<{ value: boolean }>;
                };
              }
            ).api.invoke('settings:get', { key: 'notify_claude_needs_input' }),
          );
          return result.value;
        },
        { message: 're-enabled needs-input setting persisted in main process' },
      )
      .toBe(true);
    await openProject(h.win, 'other'); // keep demo genuinely in background after reenabling
    expect(
      (
        await postRawHook(creds, {
          hook_event_name: 'Notification',
          notification_type: 'permission_prompt',
          message: 'unmuted',
        })
      ).status,
    ).toBe(204);
    await expect
      .poll(() => notifications(h.app))
      .toContainEqual(expect.objectContaining({ body: 'unmuted' }));
  } finally {
    await h.close();
  }
});

test('AC5/AC6/AC13: app-loaded OMP reports lifecycle despite inherited OMPCODE=1 from its parent app', async () => {
  const h = await launchStatus(['demo'], { defaultAgent: 'omp', inheritedOmp: true });
  try {
    expect(
      await h.app.evaluate(() => process.env.OMPCODE),
      'parent app inherited an OMP environment',
    ).toBe('1');
    await installNotificationSpy(h.app);
    await openProject(h.win, 'demo');
    const id = await projectId(h.win, 'demo');
    await waitForShell(h.win, id, 0, 'mock-omp ready');
    await sendLine(h.win, id, 0, '/env');
    await waitForShell(h.win, id, 0, 'mock-omp integration=loaded');
    await expectAgentDot(tabDot(h.win, 0), 'omp', 'idle');
    await sendLine(h.win, id, 0, '/start');
    await waitForShell(h.win, id, 0, 'mock-omp turn started');
    await expectAgentDot(tabDot(h.win, 0), 'omp', 'busy', 500);
    await sendLine(h.win, id, 0, '/approval');
    await waitForShell(h.win, id, 0, 'mock-omp approval requested');
    await expectAgentDot(tabDot(h.win, 0), 'omp', 'blocked', 500);
    await sendLine(h.win, id, 0, '/resolve');
    await waitForShell(h.win, id, 0, 'mock-omp approval resolved');
    await expectAgentDot(tabDot(h.win, 0), 'omp', 'busy', 500);
    await sendLine(h.win, id, 0, '/ask');
    await waitForShell(h.win, id, 0, 'mock-omp question open');
    await expectAgentDot(tabDot(h.win, 0), 'omp', 'blocked', 500);
    await sendLine(h.win, id, 0, '/answer');
    await waitForShell(h.win, id, 0, 'mock-omp question answered');
    await expectAgentDot(tabDot(h.win, 0), 'omp', 'busy', 500);
    await sendLine(h.win, id, 0, '/end');
    await waitForShell(h.win, id, 0, 'mock-omp turn settled');
    await expectAgentDot(tabDot(h.win, 0), 'omp', 'idle', 500);
    await sendLine(h.win, id, 0, '/start');
    await expectAgentDot(tabDot(h.win, 0), 'omp', 'busy');
    await sendLine(h.win, id, 0, '/switch');
    await expectAgentDot(tabDot(h.win, 0), 'omp', 'idle');
    await sendLine(h.win, id, 0, '/start');
    await expectAgentDot(tabDot(h.win, 0), 'omp', 'busy');
    expect(
      await notifications(h.app),
      'OMP lifecycle generates no native notification',
    ).toHaveLength(0);
    // A decorated Claude shell on the same app is the positive control for
    // the spy and notifier; its alert must not be attributed to OMP.
    const claude = await launchCli(h.win, id, 'Claude', [h.claude]);
    await waitForShell(h.win, id, claude, 'mock-claude ready');
    const creds = await hookCredentials(h.win, h.home, id, claude);
    await h.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.minimize();
    });
    expect(
      (
        await postRawHook(creds, {
          hook_event_name: 'Notification',
          notification_type: 'permission_prompt',
          message: 'Claude alone',
        })
      ).status,
    ).toBe(204);
    await expect
      .poll(() => notifications(h.app))
      .toContainEqual(
        expect.objectContaining({ title: `demo — shell ${claude}`, body: 'Claude alone' }),
      );
    expect(await notifications(h.app)).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test('AC5/AC7: an alive OMP shell loses its working dot when reports stop and regains it on heartbeat', async () => {
  const h = await launchStatus(['demo'], { defaultAgent: 'omp' });
  try {
    await openProject(h.win, 'demo');
    const id = await projectId(h.win, 'demo');
    await waitForShell(h.win, id, 0, 'mock-omp ready');
    await sendLine(h.win, id, 0, '/start');
    await expectAgentDot(tabDot(h.win, 0), 'omp', 'busy'); // positive: accepted report
    await expectAggregate(rowDot(h.win, 'demo'), 'busy');

    await sendLine(h.win, id, 0, '/pause-reports');
    await waitForShell(h.win, id, 0, 'mock-omp reports paused');
    await expectAgentDot(tabDot(h.win, 0), 'omp', 'idle', 4000);
    await expectAggregate(rowDot(h.win, 'demo'), 'idle');
    await expect
      .poll(async () =>
        (await statusSnapshot(h.win)).find(
          (entry) => entry.projectId === id && entry.shellIndex === 0,
        ),
      )
      .toEqual(expect.objectContaining({ agent: 'omp', state: 'idle' }));

    await waitForShell(h.win, id, 0, 'mock-omp reports resumed');
    await expectAgentDot(tabDot(h.win, 0), 'omp', 'busy'); // positive: same live session recovers
    await expectAggregate(rowDot(h.win, 'demo'), 'busy');
  } finally {
    await h.close();
  }
});

test('AC6/AC7: unavailable OMP integration stays runnable and idle; late report after exit cannot revive it', async () => {
  const h = await launchStatus(['demo']);
  try {
    await openProject(h.win, 'demo');
    const id = await projectId(h.win, 'demo');
    const absent = await launchCli(h.win, id, 'OMP without integration', [
      h.omp,
      '--trusted-extension',
      'missing',
    ]);
    await waitForShell(h.win, id, absent, 'mock-omp ready');
    await sendLine(h.win, id, absent, '/env');
    await waitForShell(h.win, id, absent, 'mock-omp integration=absent');
    await sendLine(h.win, id, absent, '/start');
    await waitForShell(h.win, id, absent, 'mock-omp turn started');
    await expectShellState(h.win, id, absent, 'idle');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'idle'); // active transport and comparison shell

    const live = await launchCli(h.win, id, 'OMP', [h.omp]);
    await waitForShell(h.win, id, live, 'mock-omp ready');
    await sendLine(h.win, id, live, '/start');
    await expectAgentDot(tabDot(h.win, live), 'omp', 'busy'); // reporter positive control
    const marker = join(h.home, 'send-after-exit');
    await sendLine(h.win, id, live, `/late-report ${marker}`);
    await waitForShell(h.win, id, live, 'mock-omp late report armed');
    await kill(h.win, id, live);
    await expect
      .poll(async () =>
        (await statusSnapshot(h.win)).some((s) => s.projectId === id && s.shellIndex === live),
      )
      .toBe(false);
    writeFileSync(marker, 'go');
    await expect.poll(() => existsSync(`${marker}.done`), { timeout: 5000 }).toBe(true);
    await expect
      .poll(() => readFileSync(`${marker}.done`, 'utf8'), {
        timeout: 5000,
        message: 'receiver rejects post-exit report',
      })
      .toBe('no');
    await expect
      .poll(async () =>
        (await statusSnapshot(h.win)).some((s) => s.projectId === id && s.shellIndex === live),
      )
      .toBe(false);
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'idle'); // same project remains operational
    await sendLine(h.win, id, absent, '/env');
    await waitForShell(h.win, id, absent, 'mock-omp integration=absent');
  } finally {
    await h.close();
  }
});

test('AC8/AC9/AC10/AC13: mixed Claude and OMP preserve per-shell names, generic rollups and popout/reload snapshot', async () => {
  const h = await launchStatus(['alpha', 'beta']);
  try {
    await openProject(h.win, 'alpha');
    const alpha = await projectId(h.win, 'alpha');
    const omp = await launchCli(h.win, alpha, 'OMP', [h.omp]);
    await waitForShell(h.win, alpha, omp, 'mock-omp ready');
    await sendLine(h.win, alpha, 0, '/status-work');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'busy');
    await sendLine(h.win, alpha, omp, '/start');
    await expectAgentDot(tabDot(h.win, omp), 'omp', 'busy');
    await sendLine(h.win, alpha, omp, '/approval');
    await expectAgentDot(tabDot(h.win, omp), 'omp', 'blocked');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'busy');
    await expectAggregate(chipDot(h.win), 'blocked');
    await expectAggregate(rowDot(h.win, 'alpha'), 'blocked');
    await expectAggregate(inUseDot(h.win), 'blocked');
    const palette = await paletteDot(h.win, 'alpha');
    await expectAggregate(palette, 'blocked');
    await h.win.keyboard.press('Escape');

    await h.win.locator(`[data-testid="shell-tab-button"][data-shell-index="${omp}"]`).click();
    const [popout] = await Promise.all([
      h.app.waitForEvent('window'),
      h.win.getByTestId('popout-shell').click(),
    ]);
    await popout.waitForLoadState('domcontentloaded');
    const popDot = popout.getByTestId(AGENT_DOT.testId).first();
    await expectAgentDot(popDot, 'omp', 'blocked');
    await popout.reload();
    await expectAgentDot(popout.getByTestId(AGENT_DOT.testId).first(), 'omp', 'blocked');
    await h.win.reload();
    await expectAggregate(rowDot(h.win, 'alpha'), 'blocked');
    await expectAggregate(inUseDot(h.win), 'blocked');
    await sendLine(h.win, alpha, omp, '/resolve');
    await expectAgentDot(popout.getByTestId(AGENT_DOT.testId).first(), 'omp', 'busy', 500);
    await expectAggregate(rowDot(h.win, 'alpha'), 'busy', 500);

    await openProject(h.win, 'beta');
    await expectAggregate(rowDot(h.win, 'beta'), 'idle'); // positive control: beta has a live idle shell
    await expectAggregate(inUseDot(h.win), 'busy');
    // The global busy rollup above can come from OMP alone. Prove Claude's
    // *current* live screen still says working after remount/project change,
    // immediately before OMP ends, to isolate this shell transition.
    await expectShellState(h.win, alpha, 0, 'busy');
    // Request narrow PTY geometry through IPC; later layout changes may resize it again.
    const resized: unknown = await h.win.evaluate(
      (projectId: number) =>
        (window as unknown as { api: Api }).api.invoke('shells:resize', {
          projectId,
          shellIndex: 0,
          cols: 9,
          rows: 11,
        }),
      alpha,
    );
    expect(resized).toEqual({ ok: true });
    // Force a real idle → working redraw at the narrow size so a cached
    // pre-resize busy value cannot make the assertion below vacuous.
    await sendLine(h.win, alpha, 0, '/status-ready');
    await expectShellState(h.win, alpha, 0, 'idle');
    await expectAgentDot(popout.getByTestId(AGENT_DOT.testId).first(), 'omp', 'busy');
    await sendLine(h.win, alpha, 0, '/status-work');
    await expect
      .poll(
        async () => {
          const output = await h.win.evaluate(async (projectId: number) => {
            const { output } = await (
              window as unknown as {
                api: {
                  invoke: (
                    channel: string,
                    request: { projectId: number; shellIndex: number },
                  ) => Promise<{ output: string }>;
                };
              }
            ).api.invoke('shells:snapshot', { projectId, shellIndex: 0 });
            return output;
          }, alpha);
          return output.slice(-80);
        },
        { message: 'Claude PTY redraws its working screen after narrow resize' },
      )
      .toMatch(/✻ Thinking…\s+Esc to interrupt/);
    await expectShellState(h.win, alpha, 0, 'busy');
    await sendLine(h.win, alpha, omp, '/end');
    await expectAgentDot(popout.getByTestId(AGENT_DOT.testId).first(), 'omp', 'idle', 500);
    await expectShellState(h.win, alpha, 0, 'busy');
    await expectAggregate(rowDot(h.win, 'alpha'), 'busy'); // Claude still working
    await expectAggregate(inUseDot(h.win), 'busy');
    await sendLine(h.win, alpha, 0, '/status-ready');
    await expectAggregate(rowDot(h.win, 'alpha'), 'idle');
    await expectAggregate(inUseDot(h.win), 'idle');
  } finally {
    await h.close();
  }
});

test('AC3/AC4/AC13: manually typed Claude follows reliable POSIX foreground; Windows screen-only evidence stays idle', async () => {
  const h = await launchStatus(['demo']);
  try {
    await openProject(h.win, 'demo');
    const id = await projectId(h.win, 'demo');
    const plain = await launchPlain(h.win, id);
    await sendLine(
      h.win,
      id,
      plain,
      process.platform === 'win32' ? `& "${h.claude}"` : `"${h.claude}"`,
    );
    await waitForShell(h.win, id, plain, 'mock-claude ready');
    await sendLine(h.win, id, plain, '/status-work');
    if (process.platform === 'win32') {
      // Windows has no reliable foreground evidence for a manually typed CLI.
      await expectShellState(h.win, id, plain, 'idle');
      await sendLine(h.win, id, plain, '/status-approval');
      await waitForShell(h.win, id, plain, 'Allow Bash command?');
      await expectShellState(h.win, id, plain, 'idle');
      const launched = await launchCli(h.win, id, 'Claude', [h.claude]);
      await sendLine(h.win, id, launched, '/status-work');
      await expectAgentDot(tabDot(h.win, launched), 'claude', 'busy'); // positive platform control
    } else {
      await expectAgentDot(tabDot(h.win, plain), 'claude', 'busy');
      await sendLine(h.win, id, plain, '/status-approval');
      await expectAgentDot(tabDot(h.win, plain), 'claude', 'blocked');
      await sendLine(h.win, id, plain, '/status-ready');
      await expectInactiveAgentIdle(h.win, id, plain, 'claude');
      await sendLine(h.win, id, plain, 'exit');
      await expectShellState(h.win, id, plain, 'idle');
      await sendLine(h.win, id, plain, 'printf "Allow Bash command?\\nEsc to cancel\\n"');
      await waitForShell(h.win, id, plain, 'Allow Bash command?');
      await expectShellState(h.win, id, plain, 'idle');
      await sendLine(h.win, id, 0, '/status-work');
      await expectAgentDot(tabDot(h.win, 0), 'claude', 'busy'); // positive control: detector still active
    }
  } finally {
    await h.close();
  }
});
