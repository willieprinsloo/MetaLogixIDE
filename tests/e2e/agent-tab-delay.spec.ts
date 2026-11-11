import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_STATE_LABEL, SHELL_TAB_TEST_ID, type AgentKind } from '../../src/shared/agent-state';
import type { IpcEvents } from '../../src/shared/ipc-contract';
import type { Project } from '../../src/shared/types';
import { baseEnv } from './helpers/claude-harness';
import { ipc, output, project, resize, setSetting } from './helpers/project-default-agent';
import { terminalProbes } from './helpers/terminal-probe';

/** Real Electron/preload/main/SQLite/node-pty/xterm; only the paid CLI is replaced. */
interface NativeHarness {
  readonly app: ElectronApplication;
  readonly win: Page;
  readonly home: string;
  readonly target: Project;
}
interface LaunchObservation {
  state: 'pending' | 'resolved' | 'rejected';
}
interface StreamObservation {
  output: string;
  aliveChanges: number;
  exits: IpcEvents['pty:exit'][];
  readonly unsubscribe: Array<() => void>;
}
declare global {
  var __agentTabDelayLaunches: LaunchObservation[] | undefined;
  var __agentTabDelayStream: StreamObservation | undefined;
}

const NAME = 'agent-tab-delay';
const TAB_TIMEOUT = 1500; // Generous rendering allowance, still below the old 2500ms watchdog.

const test = base.extend<{ native: NativeHarness }>({
  native: async ({}, runFixture) => {
    const directory = mkdtempSync(join(tmpdir(), 'metaide-agent-tab-delay-'));
    const home = join(directory, 'home');
    const root = join(directory, 'projects');
    let app: ElectronApplication | undefined;
    let win: Page | undefined;
    let target: Project | undefined;
    try {
      mkdirSync(join(home, 'bin'), { recursive: true });
      mkdirSync(join(root, NAME, '.git'), { recursive: true });
      for (const binary of ['codex', 'opencode', 'claude']) {
        const executable = join(home, 'bin', binary);
        writeFileSync(
          executable,
          [
            '#!/bin/sh',
            'mode=first',
            'for arg in "$@"; do',
            '  case "$arg" in repeat|--continue|-c) mode=repeat ;; esac',
            'done',
            'printf "READY[%s:%s]\\nPID[%s]\\nCWD[%s]\\n" "${0##*/}" "$mode" "$$" "$PWD"',
            'for arg in "$@"; do printf "ARG[%s]\\n" "$arg"; done',
            'while IFS= read -r line; do',
            '  case "$line" in',
            '    missing-session) printf "No conversation found to continue\\n"; exit 1 ;;',
            '    exit) exit 0 ;;',
            '    *) printf "ACK[%s]\\n" "$line" ;;',
            '  esac',
            'done',
            '',
          ].join('\n'),
        );
        chmodSync(executable, 0o755);
      }
      const initial = { argv: [join(home, 'bin', 'codex'), 'first'], env: {} };
      app = await electron.launch({
        args: ['.', `--user-data-dir=${join(home, 'userData')}`],
        env: {
          ...baseEnv(),
          HOME: home,
          SHELL: '/bin/sh',
          METAIDE_TEST_MODE: '1',
          METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
          METAIDE_DEFAULT_LAUNCH_FIRST: JSON.stringify(initial),
          METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify(initial),
        },
      });
      win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      await resize(app, 1400, 900);
      await app.evaluate(({ app: nativeApp, BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (!window) throw new Error('seed: native main window missing');
        nativeApp.focus({ steal: true });
        window.focus();
        window.webContents.focus();
      });
      await setSetting(win, 'default_cli_profiles', []);
      await ipc(win, 'roots:add', { path: root });
      target = await project(win, NAME);
      expect(target.firstLaunchedAt, 'seed: first command really is selected initially').toBeNull();
      expect(target.config.launchCmd, 'seed: no project command overrides the fixture').toBeFalsy();
      expect(
        target.config.defaultCliName,
        'seed: no project profile overrides the fixture',
      ).toBeFalsy();
      expect(
        (await ipc(win, 'shells:alive-list', undefined)).shells,
        'seed: no owned PTY yet',
      ).toEqual([]);
      expect((await ipc(win, 'shells:cli-profiles-list', { projectId: target.id })).profiles).toEqual([]);
      const section = win.getByTestId('section-all-toggle');
      await expect(section).toHaveAccessibleName('Projects');
      if ((await section.getAttribute('aria-expanded')) === 'false') await section.click();
      await expect(projectRow(win)).toBeVisible();
      await observeLaunches(app);
      await observeStream(win, target.id);
      await runFixture({ app, win, home, target });
    } finally {
      try {
        if (win && !win.isClosed()) {
          try {
            // Kill by the known owned key, even if a regression omitted its database row.
            if (target) await ipc(win, 'shells:kill', { projectId: target.id, shellIndex: 0 });
          } finally {
            await win.evaluate(() => {
              for (const off of globalThis.__agentTabDelayStream?.unsubscribe ?? []) off();
              delete globalThis.__agentTabDelayStream;
            });
          }
        }
      } finally {
        try {
          await app?.close();
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    }
  },
});

function projectRow(win: Page): Locator {
  return win.getByTestId('section-all').getByTestId('project-row').filter({
    has: win.getByText(NAME, { exact: true }),
  });
}

function tab(win: Page): Locator {
  // Match the actual tab strip, not the separate shell-tab xterm container.
  return win.locator(`[data-testid="${SHELL_TAB_TEST_ID}"][data-shell-index="0"]`);
}

async function observeLaunches(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    if (!('_invokeHandlers' in ipcMain) || !(ipcMain._invokeHandlers instanceof Map)) {
      throw new Error('seed: Electron invoke-handler map unavailable');
    }
    const original: unknown = ipcMain._invokeHandlers.get('shells:launch');
    if (typeof original !== 'function') throw new Error('seed: native shells:launch unavailable');
    globalThis.__agentTabDelayLaunches = [];
    ipcMain.removeHandler('shells:launch');
    // Observe, never delay/replace success or spoof a broadcast. The real watchdog runs.
    ipcMain.handle('shells:launch', async (event, request: unknown) => {
      const observation: LaunchObservation = { state: 'pending' };
      globalThis.__agentTabDelayLaunches?.push(observation);
      try {
        const result: unknown = await original(event, request);
        observation.state = 'resolved';
        return result;
      } catch (error: unknown) {
        observation.state = 'rejected';
        throw error;
      }
    });
  });
}

async function observeStream(win: Page, projectId: number): Promise<void> {
  await win.evaluate((id) => {
    const observation: StreamObservation = {
      output: '',
      aliveChanges: 0,
      exits: [],
      unsubscribe: [],
    };
    globalThis.__agentTabDelayStream = observation;
    observation.unsubscribe.push(
      window.api.on('pty:data', (event) => {
        if (event.projectId === id && event.shellIndex === 0) observation.output += event.data;
      }),
      window.api.on('pty:exit', (event) => {
        if (event.projectId === id && event.shellIndex === 0) observation.exits.push(event);
      }),
      window.api.on('alive-shells:changed', () => {
        observation.aliveChanges++;
      }),
    );
  }, projectId);
}

async function launches(h: NativeHarness): Promise<LaunchObservation[]> {
  return h.app.evaluate(() => globalThis.__agentTabDelayLaunches ?? []);
}

async function stream(h: NativeHarness): Promise<Omit<StreamObservation, 'unsubscribe'>> {
  return h.win.evaluate(() => {
    const observation = globalThis.__agentTabDelayStream;
    if (!observation) throw new Error('native stream observer missing');
    return {
      output: observation.output,
      aliveChanges: observation.aliveChanges,
      exits: observation.exits,
    };
  });
}

async function configure(h: NativeHarness, binary: string, repeat: string): Promise<string[]> {
  const executable = join(h.home, 'bin', binary);
  await setSetting(h.win, 'default_launch_cmd.first', { argv: [executable, 'first'], env: {} });
  await setSetting(h.win, 'default_launch_cmd.subsequent', { argv: [executable, repeat], env: {} });
  return [executable, repeat];
}

async function readyTab(h: NativeHarness, binary: string, mode: 'first' | 'repeat'): Promise<void> {
  await expect
    .poll(async () => (await stream(h)).output, {
      timeout: 10000,
      message: `real ${binary} PTY emits ${mode} readiness, independent of launch IPC completion`,
    })
    .toContain(`READY[${binary}:${mode}]`);
  await expect(tab(h.win), 'ready child must already have a real agent tab').toBeVisible({
    timeout: TAB_TIMEOUT,
  });
  await expect(tab(h.win)).toHaveText(binary === 'opencode' ? 'Opencode' : binary === 'codex' ? 'Codex' : 'Claude');
  // Each harness is recognised on its own tab, so the dot names the agent (e.g. "Codex is running").
  const dot = tab(h.win).getByRole('img', { name: AGENT_STATE_LABEL[binary as AgentKind].idle, exact: true });
  await expect(dot).toBeVisible();
  await expect(dot).toHaveClass(/live-dot/);
}

async function assertLive(h: NativeHarness, argv: string[], mode: 'first' | 'repeat'): Promise<number> {
  const { shells } = await ipc(h.win, 'shells:alive-list', undefined);
  expect(shells, 'one real primary, no duplicate/stale launch row').toHaveLength(1);
  expect(shells[0]).toMatchObject({
    projectId: h.target.id,
    shellIndex: 0,
    projectName: NAME,
    projectPath: h.target.path,
    launchArgv: argv,
    pinned: false,
  });
  expect(shells[0]?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  expect(shells[0]?.lastActiveAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const snapshot = await ipc(h.win, 'shells:snapshot', { projectId: h.target.id, shellIndex: 0 });
  expect(snapshot.alive, 'metadata corresponds to an actually running PTY').toBe(true);
  const text = await output(h.win, h.target.id);
  expect(text).toContain(`CWD[${h.target.path}]`);
  for (const arg of argv.slice(1)) expect(text).toContain(`ARG[${arg}]`);
  const binary = argv[0]?.split('/').pop();
  await expect(h.win.locator('.xterm-screen').first()).toBeVisible();
  await expect
    .poll(async () => (await terminalProbes(h.win)).map((p) => p.screen).join('\n'))
    .toContain(`READY[${binary}:${mode}]`);
  const { shells: stats } = await ipc(h.win, 'shells:live-stats', undefined);
  const live = stats.find((s) => s.projectId === h.target.id && s.shellIndex === 0);
  if (!live) throw new Error('published agent has no native live process');
  expect(live.pid).toBeGreaterThan(0);
  expect(text).toContain(`PID[${live.pid}]`);
  expect(
    (await stream(h)).aliveChanges,
    'native publication broadcast reached renderer',
  ).toBeGreaterThan(0);
  return live.pid;
}

async function exitPrimary(h: NativeHarness): Promise<void> {
  await ipc(h.win, 'shells:write', { projectId: h.target.id, shellIndex: 0, data: 'exit\r' });
  await expect.poll(async () => (await stream(h)).exits.map((event) => event.code)).toContain(0);
  await expect.poll(async () => (await ipc(h.win, 'shells:alive-list', undefined)).shells).toEqual([]);
  await expect(tab(h.win), 'exited child leaves no phantom agent tab').toHaveCount(0);
  await expect(h.win.getByRole('button', { name: 'Re-launch', exact: true })).toBeVisible();
}

async function repeatLaunch(h: NativeHarness): Promise<void> {
  expect(
    (await project(h.win, NAME)).firstLaunchedAt,
    'repeat actually resolves subsequent argv',
  ).not.toBeNull();
  await h.win.evaluate(() => {
    const observation = globalThis.__agentTabDelayStream;
    if (!observation) throw new Error('native stream observer missing');
    observation.output = '';
    observation.aliveChanges = 0;
    observation.exits = [];
  });
  // Same sidebar selection path as a user reopening an automatically launched agent.
  await projectRow(h.win).click();
}

for (const binary of ['codex', 'opencode']) {
  test(
    `${binary} repeat automatic launch publishes its tab as soon as the real PTY is ready`,
    async ({ native: h }) => {
      const subsequent = await configure(h, binary, 'repeat');
      await projectRow(h.win).click();
      await readyTab(h, binary, 'first');
      await expect.poll(() => launches(h)).toMatchObject([{ state: 'resolved' }]);
      const firstPid = await assertLive(h, [join(h.home, 'bin', binary), 'first'], 'first');
      await exitPrimary(h);
      await repeatLaunch(h);
      await readyTab(h, binary, 'repeat');
      await expect.poll(() => launches(h), { timeout: TAB_TIMEOUT }).toMatchObject([
        { state: 'resolved' },
        { state: 'resolved' },
      ]);
      expect(
        await assertLive(h, subsequent, 'repeat'),
        'repeat is a fresh real process',
      ).not.toBe(firstPid);
      await exitPrimary(h);
    },
  );
}

for (const resume of ['--continue', '-c']) {
  test(
    `Claude ${resume} tab is visible while the native resume watchdog still owns launch IPC`,
    async ({ native: h }) => {
      const subsequent = await configure(h, 'claude', resume);
      await projectRow(h.win).click();
      await readyTab(h, 'claude', 'first');
      await expect.poll(() => launches(h)).toMatchObject([{ state: 'resolved' }]);
      await assertLive(h, [join(h.home, 'bin', 'claude'), 'first'], 'first');
      await exitPrimary(h);
      await repeatLaunch(h);
      await readyTab(h, 'claude', 'repeat');
      expect(
        await launches(h),
        'visible tab precedes actual watchdog settlement, not a mocked timer',
      ).toMatchObject([{ state: 'resolved' }, { state: 'pending' }]);
      await assertLive(h, subsequent, 'repeat');
      await expect.poll(() => launches(h), { timeout: 7000 }).toMatchObject([
        { state: 'resolved' },
        { state: 'resolved' },
      ]);
      await assertLive(h, subsequent, 'repeat');
      await exitPrimary(h);
    },
  );
}

test(
  'Claude missing-session fallback replaces the early resume row with the actual first-command process',
  async ({ native: h }) => {
    await configure(h, 'claude', '--continue');
    const first = [join(h.home, 'bin', 'claude'), 'first'];
    await projectRow(h.win).click();
    await readyTab(h, 'claude', 'first');
    await expect.poll(() => launches(h)).toMatchObject([{ state: 'resolved' }]);
    await assertLive(h, first, 'first');
    await exitPrimary(h);
    await repeatLaunch(h);
    await readyTab(h, 'claude', 'repeat');
    expect(await launches(h)).toMatchObject([{ state: 'resolved' }, { state: 'pending' }]);
    const resumed = await stream(h);
    const resumedPid = /PID\[(\d+)\]/.exec(resumed.output)?.[1];
    expect(resumedPid, 'fixture resume really spawned before the fallback attack').toBeDefined();
    expect((await ipc(h.win, 'shells:alive-list', undefined)).shells[0]?.launchArgv).toEqual([
      join(h.home, 'bin', 'claude'),
      '--continue',
    ]);
    // Real CLI reports a missing session and exits during the real protection window.
    await ipc(h.win, 'shells:write', {
      projectId: h.target.id,
      shellIndex: 0,
      data: 'missing-session\r',
    });
    await expect.poll(async () => (await stream(h)).exits.map((event) => event.code)).toContain(1);
    await readyTab(h, 'claude', 'first');
    await expect.poll(() => launches(h), { timeout: 7000 }).toMatchObject([
      { state: 'resolved' },
      { state: 'resolved' },
    ]);
    const evidence = await stream(h);
    expect(evidence.output).toContain('No conversation found to continue');
    expect(evidence.output.indexOf('READY[claude:first]')).toBeGreaterThan(
      evidence.output.indexOf('No conversation found to continue'),
    );
    const fallbackPid = await assertLive(h, first, 'first');
    expect(String(fallbackPid), 'fallback starts a different native PTY').not.toBe(resumedPid);
    await expect(h.win.getByRole('button', { name: 'Re-launch', exact: true })).toHaveCount(0);
    await exitPrimary(h);
  },
);
