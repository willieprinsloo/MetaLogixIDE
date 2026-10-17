import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IpcChannelName, IpcRequest, IpcResponse } from '../../../src/shared/ipc-contract';
import type {
  CliProfile,
  LaunchCmd,
  Project,
  ProjectConfig,
  SettingsMap,
} from '../../../src/shared/types';
import type {} from '../../../src/renderer/api';
import {
  PROJECT_SETTINGS_COPY as COPY,
  PROJECT_SETTINGS_TESTIDS as IDS,
} from '../../../src/renderer/project-settings-contract';
import { baseEnv, closeApp, guardedLaunch, launch, type Harness } from './claude-harness';

export interface AgentHarness extends Harness {
  readonly executable: string;
}

/** Existing harness boots the actual main, SQLite repository, renderer and PTY. */
export async function launchAgents(names: string[]): Promise<AgentHarness> {
  const h = await launch(names);
  try {
    return await seedAgents(h);
  } catch (error) {
    await closeApp(h.app);
    h.cleanup();
    throw error;
  }
}

async function seedAgents(h: Harness): Promise<AgentHarness> {
  const executable = join(h.isolatedHome, 'agent-marker');
  // This is a real child executable, not a mocked settings/launch implementation.
  // Keep stdin observable: settings must neither restart nor send input to it.
  writeFileSync(
    executable,
    [
      '#!/bin/sh',
      'printf "AGENT[%s]\\nPID[%s]\\nCWD[%s]\\n" "$1" "$$" "$PWD"',
      'for arg in "$@"; do printf "ARG[%s]\\n" "$arg"; done',
      'printf "ENV[source=%s;layer=%s;app=%s;project=%s]\\n" "$E2E_SOURCE" "$E2E_LAYER" "$E2E_APP" "$E2E_PROJECT"',
      'while IFS= read -r line; do printf "INPUT[%s]\\n" "$line"; done',
      '',
    ].join('\n'),
  );
  chmodSync(executable, 0o755);
  const result = { ...h, executable };
  await setSetting(h.win, 'default_cli_profiles', []);
  await setSetting(h.win, 'keep_alive_cap', 16);
  await setGlobals(result, 'global-first', 'global-subsequent');
  await ipc(h.win, 'settings:set-app-env', { env: { E2E_APP: 'app', E2E_LAYER: 'app' } });
  // Seed self-checks fail before a journey can mistake inherited defaults for fixtures.
  expect(
    await setting(h.win, 'default_cli_profiles'),
    'seed: global catalog must truly be empty',
  ).toEqual([]);
  expect(
    (await ipc(h.win, 'shells:alive-list', undefined)).shells,
    'seed: no project auto-opened',
  ).toEqual([]);
  expect(await setting(h.win, 'default_launch_cmd.first')).toEqual(command(result, 'global-first'));
  expect(await setting(h.win, 'default_launch_cmd.subsequent')).toEqual(
    command(result, 'global-subsequent'),
  );
  return result;
}

/**
 * Same HOME/userData/database; do not add roots or reseed on restart. A
 * failed relaunch closes the new app and removes the harness's temp dirs
 * before rethrowing; the caller's own teardown then finds nothing left.
 */
export async function restartAgents(h: AgentHarness): Promise<void> {
  await h.app.close();
  try {
    await guardedLaunch(async (scope) => {
      h.app = scope.own(
        await electron.launch({
          args: ['.', `--user-data-dir=${join(h.isolatedHome, 'userData')}`],
          env: {
            ...baseEnv(),
            HOME: h.isolatedHome,
            SHELL: '/bin/sh',
            METAIDE_TEST_MODE: '1',
            METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
          },
        }),
      );
      h.win = await h.app.firstWindow();
      await h.win.waitForLoadState('domcontentloaded');
      await resize(h.app, 1400, 900);
    });
  } catch (error) {
    h.cleanup();
    throw error;
  }
}

export async function resize(
  app: ElectronApplication,
  width: number,
  height: number,
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('test setup: main window missing');
      window.setSize(size.width, size.height);
    },
    { width, height },
  );
}

export async function ipc<C extends IpcChannelName>(
  win: Page,
  channel: C,
  request: IpcRequest<C>,
): Promise<IpcResponse<C>> {
  return win.evaluate(async (args) => window.api.invoke(args.channel, args.request), {
    channel,
    request,
  });
}

export async function setting(
  win: Page,
  key: keyof SettingsMap,
): Promise<SettingsMap[keyof SettingsMap]> {
  return (await ipc(win, 'settings:get', { key })).value;
}

export async function setSetting<K extends keyof SettingsMap>(
  win: Page,
  key: K,
  value: SettingsMap[K],
): Promise<void> {
  await ipc(win, 'settings:set', { key, value });
  expect(await setting(win, key), `seed: ${key} persisted through the real repository`).toEqual(
    value,
  );
}

export function command(h: AgentHarness, marker: string): LaunchCmd {
  return { argv: [h.executable, marker], env: { E2E_SOURCE: marker } };
}

export function profile(h: AgentHarness, name: string, marker: string): CliProfile {
  return {
    name,
    argv: [h.executable, marker, '${PROJECT_NAME}', '${env.E2E_LAYER}'],
    env: { E2E_SOURCE: marker, E2E_LAYER: 'profile' },
  };
}

export async function setGlobals(
  h: AgentHarness,
  first: string,
  subsequent: string,
): Promise<void> {
  await setSetting(h.win, 'default_launch_cmd.first', command(h, first));
  await setSetting(h.win, 'default_launch_cmd.subsequent', command(h, subsequent));
}

export async function project(win: Page, name: string): Promise<Project> {
  const { projects } = await ipc(win, 'projects:list', undefined);
  const result = projects.find((p) => p.name === name);
  if (!result) throw new Error(`seed/project read: missing ${name}`);
  return result;
}

export async function seedProject(
  h: AgentHarness,
  name: string,
  config: ProjectConfig,
  expectations: { readonly unavailableName?: string; readonly emptyCatalog?: boolean } = {},
): Promise<Project> {
  const target = await project(h.win, name);
  await ipc(h.win, 'projects:update-config', { id: target.id, config });
  const stored = await project(h.win, name);
  for (const [key, value] of Object.entries(config)) {
    expect(Reflect.get(stored.config, key), `seed: ${name}.config.${key} persisted`).toEqual(value);
  }
  const catalog = (await ipc(h.win, 'shells:cli-profiles-list', { projectId: target.id })).profiles;
  for (const local of config.cliProfiles ?? []) {
    const resolved = catalog.filter((p) => p.name === local.name);
    expect(resolved, `seed: ${name} local ${local.name} shadows global exactly once`).toEqual([
      { ...local, scope: 'project' },
    ]);
  }
  if (expectations.emptyCatalog)
    expect(catalog, `seed: ${name} merged catalog is genuinely empty`).toEqual([]);
  if (expectations.unavailableName !== undefined) {
    expect(
      catalog.some((p) => p.name === expectations.unavailableName),
      `seed: ${name} unavailable profile must not resolve`,
    ).toBe(false);
    expect(
      stored.config.defaultCliName,
      `seed: ${name} unavailable name retained, not normalized`,
    ).toBe(expectations.unavailableName);
  }
  return stored;
}

export function row(win: Page, name: string): Locator {
  return win
    .getByTestId('project-row')
    .filter({ has: win.getByText(name, { exact: true }) })
    .first();
}

export async function selectProject(win: Page, name: string): Promise<void> {
  await row(win, name).click();
  await expect.poll(() => win.title()).toBe(`${name} — MetaLogix IDE`);
}

export function settingsView(win: Page): Locator {
  return win.getByRole('region', { name: COPY.title, exact: true });
}

export function choice(win: Page): Locator {
  return settingsView(win).getByRole('combobox', { name: COPY.defaultAgentLabel, exact: true });
}

export async function enterSettingsTab(win: Page, target: Project, fromRow = false): Promise<void> {
  if (fromRow) {
    await row(win, target.name).click({ button: 'right', position: { x: 8, y: 16 } });
    await win.getByRole('menuitem', { name: COPY.contextMenuItem, exact: true }).click();
  } else {
    await win.getByRole('button', { name: COPY.tab, exact: true }).click();
  }
  await expect(settingsView(win)).toBeVisible();
  await expect(settingsView(win).getByTestId(IDS.projectName)).toHaveText(target.name);
  await expect(settingsView(win).getByTestId(IDS.projectPath)).toHaveText(target.path);
}

export async function leaveSettingsTab(
  win: Page,
  tab: 'Shell' | 'Files' | 'Env' = 'Shell',
): Promise<void> {
  await win.getByRole('button', { name: tab, exact: true }).click();
  await expect(settingsView(win)).toHaveCount(0);
}

export async function displayedChoice(win: Page): Promise<string> {
  return choice(win).locator('option:checked').innerText();
}

export async function choose(win: Page, name: string | null): Promise<void> {
  await choice(win).selectOption({ label: name ?? COPY.globalDefault });
  await expect(settingsView(win).getByTestId(IDS.status)).toHaveText(COPY.saved);
  await expect(choice(win)).toBeEnabled();
  await expect.poll(() => displayedChoice(win)).toBe(name ?? COPY.globalDefault);
}

export async function replaceLegacy(win: Page): Promise<void> {
  await expect(
    settingsView(win).getByText(COPY.customCommandsNotice, { exact: true }),
  ).toBeVisible();
  await settingsView(win)
    .getByRole('button', { name: COPY.replaceCustomCommands, exact: true })
    .click();
  await expect(settingsView(win).getByTestId(IDS.status)).toHaveText(COPY.saved);
  await expect(settingsView(win).getByTestId(IDS.legacyNotice)).toHaveCount(0);
  await expect(settingsView(win).getByText(COPY.nextLaunchNotice, { exact: true })).toBeVisible();
}

export async function output(win: Page, projectId: number, shellIndex = 0): Promise<string> {
  const { output: serialized } = await ipc(win, 'shells:snapshot', { projectId, shellIndex });
  // Snapshot is a terminal replay, not plain text. Remove terminal control codes
  // and line wrapping so long paths/argv are asserted as emitted, not by columns.
  return serialized
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/[\r\n]/g, '');
}

/** Assert both recorded launch arguments and what the actual executable received. */
export async function assertLaunch(
  h: AgentHarness,
  target: Project,
  marker: string,
  named = false,
  options: { readonly shellIndex?: number; readonly explicit?: boolean } = {},
): Promise<number> {
  const shellIndex = options.shellIndex ?? 0;
  const args = [h.executable, marker];
  // Existing explicit menu launches keep configured argv literal; automatic
  // launches interpolate it. Assert both paths without changing their semantics.
  if (named)
    args.push(
      ...(options.explicit ? ['${PROJECT_NAME}', '${env.E2E_LAYER}'] : [target.name, 'project']),
    );
  await expect.poll(() => output(h.win, target.id, shellIndex)).toContain(`AGENT[${marker}]`);
  // UI project selection returns before the existing subsequent-launch
  // settlement finishes. Child output can precede its persisted shell row.
  await expect
    .poll(async () => {
      const { shells } = await ipc(h.win, 'shells:alive-list', undefined);
      return shells.find((s) => s.projectId === target.id && s.shellIndex === shellIndex)
        ?.launchArgv;
    })
    .toEqual(args);
  const { shells } = await ipc(h.win, 'shells:alive-list', undefined);
  const shell = shells.find((s) => s.projectId === target.id && s.shellIndex === shellIndex);
  if (!shell) throw new Error(`expected live shell ${target.id}:${shellIndex}`);
  expect(shell.launchArgv, 'real resolver argv, no invented resume flags').toEqual(args);
  const text = await output(h.win, target.id, shellIndex);
  for (const arg of args.slice(1)) expect(text).toContain(`ARG[${arg}]`);
  expect(text).toContain(`CWD[${target.config.cwdOverride ?? target.path}]`);
  expect(text).toContain(`ENV[source=${marker};layer=project;app=app;project=${target.name}]`);
  const { shells: stats } = await ipc(h.win, 'shells:live-stats', undefined);
  const live = stats.find((s) => s.projectId === target.id && s.shellIndex === shellIndex);
  if (!live) throw new Error(`expected PID for ${target.id}:${shellIndex}`);
  expect(live.pid).toBeGreaterThan(0);
  expect(text).toContain(`PID[${live.pid}]`);
  return live.pid;
}

export async function killPrimary(h: AgentHarness, target: Project): Promise<void> {
  await ipc(h.win, 'shells:kill', { projectId: target.id, shellIndex: 0 });
  await expect
    .poll(async () =>
      (await ipc(h.win, 'shells:alive-list', undefined)).shells.some(
        (s) => s.projectId === target.id && s.shellIndex === 0,
      ),
    )
    .toBe(false);
}

export async function automaticSpawn(h: AgentHarness, target: Project): Promise<void> {
  await ipc(h.win, 'projects:open', { id: target.id });
  await ipc(h.win, 'shells:launch', { projectId: target.id });
}

export async function shellState(win: Page): Promise<unknown> {
  const { shells } = await ipc(win, 'shells:alive-list', undefined);
  const { shells: stats } = await ipc(win, 'shells:live-stats', undefined);
  return shells
    .map((s) => ({
      projectId: s.projectId,
      shellIndex: s.shellIndex,
      launchArgv: s.launchArgv,
      pid: stats.find((p) => p.projectId === s.projectId && p.shellIndex === s.shellIndex)?.pid,
    }))
    .sort((a, b) => a.projectId - b.projectId || a.shellIndex - b.shellIndex);
}

export async function openShellMenu(win: Page): Promise<Locator> {
  await win.getByTestId('tabbar-new-shell').click();
  const menu = win.locator('[data-new-shell-menu="1"]:not([inert])');
  await expect(menu.getByText('Add a shell', { exact: true })).toBeVisible();
  await expect(menu.getByText(COPY.menuDefaultNotice, { exact: true })).toBeVisible();
  return menu;
}

export async function assertMenuDefault(win: Page, name: string | null): Promise<void> {
  const menu = await openShellMenu(win);
  // Profile rows are positive controls even when no default is marked.
  await expect(menu.getByRole('button', { name: 'Terminal', exact: false })).toBeVisible();
  if (name === null) {
    await expect(menu.getByText('auto', { exact: true })).toHaveCount(0);
    await expect(
      menu.getByRole('button', { name: 'Clear folder default', exact: true }),
    ).toHaveCount(0);
  } else {
    await expect(menu.getByText('auto', { exact: true })).toHaveCount(1);
    await expect(
      menu.getByRole('button', { name: 'Clear folder default', exact: true }),
    ).toHaveCount(1);
    await expect(menu.getByRole('button').filter({ hasText: name }).first()).toContainText('auto');
  }
  await win.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
}

type FeatureChannel = 'projects:list' | 'shells:cli-profiles-list' | 'shells:set-default-cli';
type TransportHandler = (event: unknown, request: unknown) => unknown;
interface TransportGate {
  readonly original: TransportHandler;
  readonly requests: unknown[];
  mode: 'pass' | 'fail' | 'hold';
  readonly message: string;
  readonly projectId: number | null;
  release: (() => void) | null;
  completed: number;
}

declare global {
  // Lives only in the launched Electron main process, never in application source.
  var __projectDefaultAgentGates: Map<string, TransportGate> | undefined;
}

/** Feature-local real transport wrapper. Pass/delay delegate the original handler. */
export async function installGate(
  app: ElectronApplication,
  channel: FeatureChannel,
  mode: TransportGate['mode'],
  projectId: number | null = null,
): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, args) => {
      if (!('_invokeHandlers' in ipcMain) || !(ipcMain._invokeHandlers instanceof Map)) {
        throw new Error('test setup: Electron invoke-handler map unavailable');
      }
      const handlers = ipcMain._invokeHandlers;
      const original: unknown = handlers.get(args.channel);
      if (typeof original !== 'function')
        throw new Error(`test setup: missing ${args.channel} handler`);
      const gates = (globalThis.__projectDefaultAgentGates ??= new Map());
      if (gates.has(args.channel))
        throw new Error(`test setup: gate already installed for ${args.channel}`);
      const gate: TransportGate = {
        original: (event, request) => original(event, request),
        requests: [],
        mode: args.mode,
        message: `E2E controlled ${args.channel} failure; retry after recovery`,
        projectId: args.projectId,
        release: null,
        completed: 0,
      };
      gates.set(args.channel, gate);
      handlers.set(args.channel, async (event: unknown, request: unknown) => {
        const matches =
          gate.projectId === null ||
          (typeof request === 'object' &&
            request !== null &&
            'projectId' in request &&
            request.projectId === gate.projectId);
        gate.requests.push(request);
        if (matches && gate.mode === 'fail') throw new Error(gate.message);
        if (matches && gate.mode === 'hold') {
          gate.mode = 'pass'; // Hold one invocation only; B can load/save while A waits.
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
        }
        const result: unknown = await gate.original(event, request);
        gate.completed++;
        return result;
      });
    },
    { channel, mode, projectId },
  );
}

export async function gateEvidence(
  app: ElectronApplication,
  channel: FeatureChannel,
): Promise<{ requests: unknown[]; completed: number; held: boolean }> {
  return app.evaluate((_electron, ch) => {
    const gate = globalThis.__projectDefaultAgentGates?.get(ch);
    if (!gate) throw new Error(`test setup: no gate for ${ch}`);
    return { requests: gate.requests, completed: gate.completed, held: gate.release !== null };
  }, channel);
}

export async function releaseGate(
  app: ElectronApplication,
  channel: FeatureChannel,
): Promise<void> {
  await app.evaluate((_electron, ch) => {
    const gate = globalThis.__projectDefaultAgentGates?.get(ch);
    if (!gate?.release) throw new Error(`test setup: ${ch} did not hold an invocation`);
    gate.release();
    gate.release = null;
  }, channel);
}

export async function restoreGate(
  app: ElectronApplication,
  channel: FeatureChannel,
): Promise<void> {
  await app.evaluate(({ ipcMain }, ch) => {
    const gate = globalThis.__projectDefaultAgentGates?.get(ch);
    if (!gate) throw new Error(`test setup: no gate to restore for ${ch}`);
    if (!('_invokeHandlers' in ipcMain) || !(ipcMain._invokeHandlers instanceof Map))
      throw new Error('test setup: handler map disappeared');
    gate.release?.();
    ipcMain._invokeHandlers.set(ch, gate.original);
    globalThis.__projectDefaultAgentGates?.delete(ch);
  }, channel);
}
