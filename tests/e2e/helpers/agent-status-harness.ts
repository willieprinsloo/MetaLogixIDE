import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import {
  AGENT_DOT,
  AGENT_STATE_LABEL,
  AGGREGATE_STATE_LABEL,
  SHELL_TAB_TEST_ID,
  type AgentKind,
  type AgentState,
  type AgentShellStateEntry,
} from '../../../src/shared/agent-state';
import {
  baseEnv,
  guardedLaunch,
  projectId,
  openProject,
  sendLine,
  waitForShell,
  type Api,
} from './claude-harness';

const MOCK_CLAUDE = resolve(process.cwd(), 'scripts/mock-claude.mjs');
const MOCK_OMP = resolve(process.cwd(), 'scripts/mock-omp.mjs');
const WINDOWS = process.platform === 'win32';

/** Packaged runners pass METAIDE_PACKAGED_APP; local runs use the built Electron app. */
export function electronOptions(
  home: string,
  env: NodeJS.ProcessEnv,
): Parameters<typeof electron.launch>[0] {
  return {
    ...(process.env.METAIDE_PACKAGED_APP
      ? { executablePath: process.env.METAIDE_PACKAGED_APP }
      : {}),
    args: [
      ...(process.env.METAIDE_PACKAGED_APP ? [] : ['.']),
      `--user-data-dir=${join(home, 'userData')}`,
    ],
    env: Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  };
}

function command(home: string, name: string, script: string): string {
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, WINDOWS ? `${name}.cmd` : name);
  if (WINDOWS) writeFileSync(path, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  else {
    // Keep node's argv[0] equal to claude in the manually typed POSIX case.
    writeFileSync(path, `#!/bin/bash\nexec -a ${name} "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(path, 0o755);
  }
  return path;
}

export interface StatusHarness {
  app: ElectronApplication;
  win: Page;
  home: string;
  root: string;
  claude: string;
  omp: string;
  close: () => Promise<void>;
}

export async function launchStatus(
  names: string[],
  opts: {
    defaultAgent?: 'claude' | 'omp';
    unavailableHooks?: boolean;
    inheritedOmp?: boolean;
  } = {},
): Promise<StatusHarness> {
  return guardedLaunch(async (scope) => {
    const home = scope.tempDir('metaide-agent-home-');
    const root = scope.tempDir('metaide-agent-root-');
    for (const name of names) {
      mkdirSync(join(root, name, '.git'), { recursive: true });
    }
    const claude = command(home, 'claude', MOCK_CLAUDE);
    const omp = command(home, 'omp', MOCK_OMP);
    if (opts.unavailableHooks) {
      mkdirSync(join(home, '.metaide'), { recursive: true });
      writeFileSync(join(home, '.metaide', 'claude-hooks'), 'hook settings directory unavailable');
    }
    const first = opts.defaultAgent === 'omp' ? omp : claude;
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(),
      ...(opts.inheritedOmp ? { OMPCODE: '1' } : {}),
      HOME: home,
      ...(WINDOWS ? { USERPROFILE: home } : { SHELL: '/bin/bash' }),
      PATH: `${join(home, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
      METAIDE_TEST_MODE: '1',
      METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
      METAIDE_DEFAULT_LAUNCH_FIRST: JSON.stringify({ argv: [first], env: {} }),
      METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: [first, '--continue'], env: {} }),
    };
    const app = scope.own(await electron.launch(electronOptions(home, env)));
    const win = await app.firstWindow();
    await win.getByTestId('settings-open').waitFor();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setSize(1400, 900);
    });
    await win.evaluate(async (path: string) => {
      const appWindow = window as unknown as { api: Api };
      await appWindow.api.invoke('roots:add', { path });
    }, root);
    return {
      app,
      win,
      home,
      root,
      claude,
      omp,
      close: async () => {
        await app.close();
        rmSync(home, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
      },
    };
  });
}

export { projectId, openProject, sendLine, waitForShell };

export async function launchCli(
  win: Page,
  project: number,
  name: string,
  argv: string[],
): Promise<number> {
  return win.evaluate(
    async ({ projectId, profileName, args }) => {
      const appWindow = window as unknown as { api: Api };
      const value = (await appWindow.api.invoke('shells:launch-cli', {
        projectId,
        profileName,
        argv: args,
        save: false,
      })) as unknown;
      if (
        !value ||
        typeof value !== 'object' ||
        !('shellIndex' in value) ||
        typeof value.shellIndex !== 'number'
      )
        throw new Error('CLI launch returned no shellIndex');
      return value.shellIndex;
    },
    { projectId: project, profileName: name, args: argv },
  );
}

export async function launchPlain(win: Page, projectId: number): Promise<number> {
  return win.evaluate(async (id: number) => {
    const appWindow = window as unknown as { api: Api };
    const value = (await appWindow.api.invoke('shells:launch-plain', { projectId: id })) as unknown;
    if (
      !value ||
      typeof value !== 'object' ||
      !('shellIndex' in value) ||
      typeof value.shellIndex !== 'number'
    )
      throw new Error('plain launch returned no shellIndex');
    return value.shellIndex;
  }, projectId);
}

export async function kill(win: Page, projectId: number, shellIndex: number): Promise<void> {
  await win.evaluate(
    async ({ projectId, shellIndex }) => {
      const appWindow = window as unknown as { api: Api };
      await appWindow.api.invoke('shells:kill', { projectId, shellIndex });
    },
    { projectId, shellIndex },
  );
}

export async function statusSnapshot(win: Page): Promise<AgentShellStateEntry[]> {
  return win.evaluate(async () => {
    const appWindow = window as unknown as { api: Api };
    const value = (await appWindow.api.invoke('agent-state:list', undefined)) as unknown;
    if (!value || typeof value !== 'object' || !('shells' in value) || !Array.isArray(value.shells))
      throw new Error('agent-state:list returned no shell entries');
    return value.shells as AgentShellStateEntry[];
  });
}

export async function shellState(
  win: Page,
  projectId: number,
  shellIndex: number,
): Promise<AgentState> {
  const shell = (await statusSnapshot(win)).find(
    (x) => x.projectId === projectId && x.shellIndex === shellIndex,
  );
  return shell?.state ?? 'idle';
}

export async function expectShellState(
  win: Page,
  projectId: number,
  shellIndex: number,
  state: AgentState,
  timeout = 2000,
): Promise<void> {
  await expect
    .poll(() => shellState(win, projectId, shellIndex), {
      timeout,
      message: `shell ${projectId}:${shellIndex} ${state}`,
    })
    .toBe(state);
}

export function tabDot(win: Page, index: number): Locator {
  return win
    .locator(`[data-testid="${SHELL_TAB_TEST_ID}"][data-shell-index="${index}"]`)
    .getByTestId(AGENT_DOT.testId);
}

export function rowDot(win: Page, name: string): Locator {
  return win
    .locator('[data-testid="project-row"]')
    .filter({ has: win.getByText(name, { exact: true }) })
    .first()
    .getByTestId(AGENT_DOT.testId);
}

export function chipDot(win: Page): Locator {
  return win
    .locator('span')
    .filter({ has: win.getByTestId('unload-current') })
    .first()
    .getByTestId(AGENT_DOT.testId);
}

export function inUseDot(win: Page): Locator {
  return win.getByTestId('section-in-use-toggle').getByTestId(AGENT_DOT.testId);
}

export async function expectDot(
  dot: Locator,
  state: AgentState,
  label: string,
  timeout = 2000,
): Promise<void> {
  await expect(dot).toHaveAttribute(AGENT_DOT.stateAttr, state, { timeout });
  await expect(dot).toHaveAttribute('title', label);
  await expect(dot).toHaveAccessibleName(label);
}

export async function expectAgentDot(
  dot: Locator,
  agent: AgentKind,
  state: AgentState,
  timeout?: number,
): Promise<void> {
  await expectDot(dot, state, AGENT_STATE_LABEL[agent][state], timeout);
}

/** Inactive idle tabs stay grey but still name their recognized agent. */
export async function expectInactiveAgentIdle(
  win: Page,
  projectId: number,
  shellIndex: number,
  agent: AgentKind,
): Promise<void> {
  await expect
    .poll(async () => {
      const shell = (await statusSnapshot(win)).find(
        (entry) => entry.projectId === projectId && entry.shellIndex === shellIndex,
      );
      return { agent: shell?.agent, state: shell?.state };
    })
    .toEqual({ agent, state: 'idle' });
  const dot = tabDot(win, shellIndex);
  await expect(dot).not.toHaveAttribute(AGENT_DOT.stateAttr);
  await expect(dot).toHaveAttribute('title', AGENT_STATE_LABEL[agent].idle);
  await expect(dot).toHaveAccessibleName(AGENT_STATE_LABEL[agent].idle);
}

export async function expectAggregate(
  dot: Locator,
  state: AgentState,
  timeout?: number,
): Promise<void> {
  await expectDot(dot, state, AGGREGATE_STATE_LABEL[state], timeout);
}
