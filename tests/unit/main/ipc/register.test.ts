import { describe, it, expect, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { registerIpc } from '@main/ipc/register';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { SettingsRepo } from '@main/repos/settings-repo';
import { ViewedShells } from '@main/notifications/viewed-shells';
import { RootsRepo } from '@main/repos/roots-repo';
import { ProjectsRepo } from '@main/repos/projects-repo';
import { ShellsRepo } from '@main/repos/shells-repo';
import { applyClaudePermissionMode } from '@main/domain/claude-permission-mode';
import type { ProjectConfig } from '@shared/types';
import type { ResolvedLaunch } from '@main/domain/launch';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const migrationsDir = resolve(__dirname, '../../../../migrations');

function fakeIpcMain(): IpcMain & { handlers: Map<string, (e: unknown, req: unknown) => Promise<unknown>> } {
  const handlers = new Map<string, (e: unknown, req: unknown) => Promise<unknown>>();
  return {
    handle: (channel: string, fn: (e: unknown, req: unknown) => Promise<unknown>) => handlers.set(channel, fn),
    handlers,
  } as unknown as ReturnType<typeof fakeIpcMain>;
}

/** Real SettingsRepo backed by a temp sqlite db, seeded with defaults, for tests that exercise the real permission-mode rewrite. */
function realSettings(): SettingsRepo {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'reg-')), 'db'));
  runMigrations(db, migrationsDir);
  const repo = new SettingsRepo(db);
  repo.seedDefaults();
  return repo;
}

/** Minimal ptyManager stand-in: every method is a spy, so a test can assert nothing was spawned. */
function fakePtyManager() {
  return { on: vi.fn(), off: vi.fn(), spawn: vi.fn(async () => {}), kill: vi.fn(async () => {}), isAlive: vi.fn(() => false), resize: vi.fn(), write: vi.fn(), getScrollback: vi.fn(() => ''), getSnapshot: vi.fn(async () => ''), allPorts: vi.fn(() => []), liveShells: vi.fn(() => []) };
}

describe('registerIpc', () => {
  it('registers every declared channel', async () => {
    const ipc = fakeIpcMain();
    const services = {} as unknown as Parameters<typeof registerIpc>[1]; // handlers are not invoked in this test
    registerIpc(ipc as unknown as IpcMain, services, () => {});
    const expected = [
      'roots:list', 'roots:add', 'roots:remove', 'roots:rescan',
      'projects:list', 'projects:open', 'projects:pin', 'projects:hide',
      'projects:update-config', 'projects:recents',
      'shells:launch', 'shells:kill', 'shells:resize', 'shells:write',
      'shells:alive-list', 'shells:pin',
      'settings:get', 'settings:set', 'settings:set-claude-permission-mode',
      'files:tree', 'app:ping', 'notifications:viewed-shells', 'claude-state:list',
    ];
    for (const c of expected) expect(ipc.handlers.has(c)).toBe(true);
  });

  it('claude-state:list returns the tracker list as { shells }', async () => {
    const ipc = fakeIpcMain();
    const shells = [{ projectId: 1, shellIndex: 0, state: 'busy' }, { projectId: 2, shellIndex: 3, state: 'blocked' }];
    const list = vi.fn(() => shells);
    const services = { claudeState: { list } } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, () => {});
    await expect(ipc.handlers.get('claude-state:list')!({}, undefined)).resolves.toEqual({ shells });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('settings:set rejects key claude_permission_mode without writing', async () => {
    const ipc = fakeIpcMain();
    const settings = realSettings();
    const setSpy = vi.spyOn(settings, 'set');
    const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, () => {});
    const handler = ipc.handlers.get('settings:set')!;
    await expect(handler({}, { key: 'claude_permission_mode', value: 'auto' })).rejects.toThrow();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it.each(['plan', 'bypassPermissions', '', undefined])('settings:set-claude-permission-mode rejects mode %j without changing anything', async (mode) => {
    const ipc = fakeIpcMain();
    const settings = realSettings();
    const before = settings.get('claude_permission_mode');
    const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, () => {});
    const handler = ipc.handlers.get('settings:set-claude-permission-mode')!;
    await expect(handler({}, { mode })).rejects.toThrow();
    expect(settings.get('claude_permission_mode')).toBe(before);
  });

  it('shells:snapshot returns the serialized terminal state, not the raw scrollback tail', async () => {
    const ipc = fakeIpcMain();
    const ptyManager = fakePtyManager();
    ptyManager.isAlive.mockReturnValue(true);
    ptyManager.getScrollback.mockReturnValue('RAW-TAIL');
    ptyManager.getSnapshot.mockResolvedValue('\x1b[1mSERIALIZED');
    const services = { ptyManager } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, () => {});
    const result = await ipc.handlers.get('shells:snapshot')!({}, { projectId: 4, shellIndex: 2 });
    expect(result).toEqual({ output: '\x1b[1mSERIALIZED', alive: true });
    expect(ptyManager.getSnapshot).toHaveBeenCalledWith(4, 2);
  });

  it('shells:snapshot returns an empty dead snapshot when no ptyManager is wired', async () => {
    const ipc = fakeIpcMain();
    registerIpc(ipc as unknown as IpcMain, {} as unknown as Parameters<typeof registerIpc>[1], () => {});
    await expect(ipc.handlers.get('shells:snapshot')!({}, { projectId: 1, shellIndex: 0 })).resolves.toEqual({ output: '', alive: false });
  });

  it('shells:launch rejects while the permission mode is unchosen, without spawning', async () => {
    const ipc = fakeIpcMain();
    const settings = realSettings();
    expect(settings.get('claude_permission_mode')).toBeNull();
    const ptyManager = fakePtyManager();
    const services = { settings, ptyManager } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, () => {});
    const handler = ipc.handlers.get('shells:launch')!;
    await expect(handler({}, { projectId: 1 })).rejects.toThrow('Choose a Claude permission mode first');
    expect(ptyManager.spawn).not.toHaveBeenCalled();
  });

  it('settings:set-claude-permission-mode returns { mode, changedKeys } and emits settings:changed once per changed key', async () => {
    const ipc = fakeIpcMain();
    const settings = realSettings();
    const events: Array<{ channel: string; payload: unknown }> = [];
    const sendEvent = (channel: string, payload: unknown) => { events.push({ channel, payload }); };
    const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, sendEvent as never);
    const handler = ipc.handlers.get('settings:set-claude-permission-mode')!;
    const result = await handler({}, { mode: 'auto' }) as { mode: string; changedKeys: string[] };
    expect(result.mode).toBe('auto');
    expect(new Set(result.changedKeys)).toEqual(new Set(['claude_permission_mode', 'default_launch_cmd.first', 'default_launch_cmd.subsequent', 'default_cli_profiles']));
    const settingsChangedKeys = events.filter(e => e.channel === 'settings:changed').map(e => (e.payload as { key: string }).key);
    expect(new Set(settingsChangedKeys)).toEqual(new Set(result.changedKeys));
    expect(settingsChangedKeys).toHaveLength(result.changedKeys.length);
  });

  it('settings:set-claude-permission-mode emits nothing on failure', async () => {
    const ipc = fakeIpcMain();
    const settings = realSettings();
    const events: Array<{ channel: string; payload: unknown }> = [];
    const sendEvent = (channel: string, payload: unknown) => { events.push({ channel, payload }); };
    const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, sendEvent as never);
    const handler = ipc.handlers.get('settings:set-claude-permission-mode')!;
    await expect(handler({}, { mode: 'plan' })).rejects.toThrow();
    expect(events).toEqual([]);
  });

  describe('notifications:viewed-shells', () => {
    const main = {};
    const mainFocused = { focused: () => main, main: () => main, popout: () => null };

    function setupViewed() {
      const ipc = fakeIpcMain();
      const viewedShells = new ViewedShells();
      const services = { viewedShells } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, () => {});
      return { handler: ipc.handlers.get('notifications:viewed-shells')!, viewedShells };
    }

    it('a valid payload replaces the reported view', async () => {
      const { handler, viewedShells } = setupViewed();
      await expect(handler({}, { shells: [{ projectId: 3, shellIndex: 1 }] })).resolves.toEqual({ ok: true });
      expect(viewedShells.isViewing({ projectId: 3, shellIndex: 1 }, mainFocused)).toBe(true);
      await handler({}, { shells: [] });
      expect(viewedShells.isViewing({ projectId: 3, shellIndex: 1 }, mainFocused)).toBe(false);
    });

    it.each([
      ['more than 8 items', { shells: Array.from({ length: 9 }, (_, i) => ({ projectId: 1, shellIndex: i })) }],
      ['a non-integer id', { shells: [{ projectId: 1.5, shellIndex: 0 }] }],
      ['a negative shell index', { shells: [{ projectId: 1, shellIndex: -1 }] }],
      ['projectId 0', { shells: [{ projectId: 0, shellIndex: 0 }] }],
      ['a non-array', { shells: 'all' }],
    ])('rejects %s and leaves the view unchanged', async (_label, req) => {
      const { handler, viewedShells } = setupViewed();
      await handler({}, { shells: [{ projectId: 3, shellIndex: 1 }] });
      await expect(handler({}, req)).rejects.toThrow(/viewed shells/);
      expect(viewedShells.isViewing({ projectId: 3, shellIndex: 1 }, mainFocused)).toBe(true);
    });
  });
});

/**
 * Real projects/shells/settings repos on a temp db, a spy ptyManager and two
 * projects on disk, for exercising project env at every spawn site.
 */
function envRig() {
  const dir = mkdtempSync(join(tmpdir(), 'reg-env-'));
  const db = openDb(join(dir, 'db'));
  runMigrations(db, migrationsDir);
  const settings = new SettingsRepo(db);
  settings.seedDefaults();
  applyClaudePermissionMode(settings, 'auto');
  const projects = new ProjectsRepo(db);
  const shells = new ShellsRepo(db);
  const root = new RootsRepo(db).add(dir);
  const pathA = join(dir, 'alpha');
  const pathB = join(dir, 'beta');
  mkdirSync(pathA);
  mkdirSync(pathB);
  const a = projects.upsert(root.id, pathA, 'alpha');
  const b = projects.upsert(root.id, pathB, 'beta');
  const ptyManager = fakePtyManager();
  const events: string[] = [];
  const ipc = fakeIpcMain();
  const services = {
    settings,
    projects,
    shells,
    ptyManager,
    homeDir: '/home/u',
  } as unknown as Parameters<typeof registerIpc>[1];
  registerIpc(ipc as unknown as IpcMain, services, ((channel: string) => {
    events.push(channel);
  }) as never);
  const call = (channel: string, req: unknown) => ipc.handlers.get(channel)!({}, req);
  const spawned = (n: number) =>
    (ptyManager.spawn.mock.calls[n] as unknown as [number, number, ResolvedLaunch])[2];
  const setEnv = (id: number, env: Record<string, string>) => projects.updateConfig(id, { env });
  return {
    dir,
    settings,
    projects,
    shells,
    ptyManager,
    events,
    call,
    spawned,
    setEnv,
    a,
    b,
    pathA,
  };
}

describe('projects:update-config — env validation (AC8, AC9)', () => {
  const seeded: ProjectConfig = {
    env: { A: '1' },
    launchCmd: { first: { argv: ['echo'], env: {} } },
    cliProfiles: [{ name: 'p', argv: ['codex'] }],
    defaultCliName: 'p',
  };

  it.each([
    ['an invalid name', { env: { 'MY-VAR': 'x' } }],
    ['a leading-digit name', { env: { '1FOO': 'x' } }],
    ['a reserved name', { env: { METAIDE_HOOK_TOKEN: 'x' } }],
    ['a reserved lower-case name', { env: { metaide_x: 'x' } }],
    ['an own __proto__ name', JSON.parse('{"env":{"__proto__":"x"}}') as unknown],
    ['a non-string value', { env: { A: 1 } }],
    ['a null value', { env: { A: null } }],
    ['a NUL value', { env: { A: 'x\0y' } }],
    ['an array env', { env: [['A', '1']] }],
    ['a null env', { env: null }],
    ['a string env', { env: 'A=1' }],
  ])('rejects %s and leaves the stored config and events unchanged', async (_label, config) => {
    const rig = envRig();
    rig.projects.updateConfig(rig.a.id, seeded);
    const before = rig.projects.get(rig.a.id)!.config;
    await expect(rig.call('projects:update-config', { id: rig.a.id, config })).rejects.toThrow();
    expect(rig.projects.get(rig.a.id)!.config).toStrictEqual(before);
    expect(rig.events).toEqual([]);
  });

  it.each([
    ['null', null],
    ['an array', [{ env: {} }]],
    ['a string', 'env'],
    ['missing', undefined],
  ])('rejects a config that is %s without writing', async (_label, config) => {
    const rig = envRig();
    rig.projects.updateConfig(rig.a.id, seeded);
    const before = rig.projects.get(rig.a.id)!.config;
    await expect(rig.call('projects:update-config', { id: rig.a.id, config })).rejects.toThrow();
    expect(rig.projects.get(rig.a.id)!.config).toStrictEqual(before);
  });

  it('AC17 — the rejection names the key and never the value', async () => {
    const rig = envRig();
    const err = await rig
      .call('projects:update-config', { id: rig.a.id, config: { env: { TOKEN: 'S3CRET\0' } } })
      .catch((e: Error) => e);
    expect((err as Error).message).toContain('TOKEN');
    expect((err as Error).message).not.toContain('S3CRET');
  });

  it('a valid env save replaces the whole map and keeps every other field', async () => {
    const rig = envRig();
    rig.projects.updateConfig(rig.a.id, seeded);
    const res = (await rig.call('projects:update-config', {
      id: rig.a.id,
      config: { env: { B: '2', EMPTY: '' } },
    })) as { project: { config: ProjectConfig } };
    const expected = { ...seeded, env: { B: '2', EMPTY: '' } };
    expect(res.project.config).toStrictEqual(expected);
    expect(rig.projects.get(rig.a.id)!.config).toStrictEqual(expected);
  });

  it('an empty env map clears every variable', async () => {
    const rig = envRig();
    rig.setEnv(rig.a.id, { A: '1' });
    await rig.call('projects:update-config', { id: rig.a.id, config: { env: {} } });
    expect(rig.projects.get(rig.a.id)!.config.env).toStrictEqual({});
  });

  it('a save without env is not validated as env and works as before', async () => {
    const rig = envRig();
    await rig.call('projects:update-config', { id: rig.a.id, config: { model: 'opus' } });
    expect(rig.projects.get(rig.a.id)!.config).toStrictEqual({ model: 'opus' });
  });

  it('a successful save emits projects:changed', async () => {
    const rig = envRig();
    await rig.call('projects:update-config', { id: rig.a.id, config: { env: { A: '1' } } });
    expect(rig.events).toEqual(['projects:changed']);
  });
});

describe('project env at every spawn site (AC10, AC11, AC14–AC16)', () => {
  it('shells:launch (first) passes the project var and project wins over template env', async () => {
    const rig = envRig();
    rig.projects.updateConfig(rig.a.id, {
      launchCmd: { first: { argv: ['run', '${env.K}'], env: { K: 'tpl', T: 't' } } },
      env: { K: 'proj', P: '${PROJECT_NAME}' },
    });
    await rig.call('shells:launch', { projectId: rig.a.id });
    expect(rig.spawned(0).env).toStrictEqual({ K: 'proj', T: 't', P: 'alpha' });
    expect(rig.spawned(0).argv).toEqual(['run', 'proj']);
  });

  it('shells:launch (subsequent) passes the project var', async () => {
    const rig = envRig();
    rig.setEnv(rig.a.id, { API_URL: 'http://localhost:4000' });
    rig.projects.setFirstLaunched(rig.a.id, new Date());
    rig.ptyManager.spawn.mockImplementationOnce(async () => {
      const onExit = rig.ptyManager.on.mock.calls.filter((c) => c[0] === 'exit').at(-1)![1] as (
        ev: unknown,
      ) => void;
      onExit({ projectId: rig.a.id, shellIndex: 0, code: 0, uptimeMs: 10_000, earlyOutput: '' });
    });
    await rig.call('shells:launch', { projectId: rig.a.id });
    expect(rig.ptyManager.spawn).toHaveBeenCalledTimes(1);
    expect(rig.spawned(0).variant).toBe('subsequent');
    expect(rig.spawned(0).env).toStrictEqual({ API_URL: 'http://localhost:4000' });
  });

  it('shells:launch no-session fallback passes the project var on the retry', async () => {
    const rig = envRig();
    rig.setEnv(rig.a.id, { API_URL: 'http://localhost:4000' });
    rig.projects.setFirstLaunched(rig.a.id, new Date());
    rig.ptyManager.spawn.mockImplementationOnce(async () => {
      const onExit = rig.ptyManager.on.mock.calls.filter((c) => c[0] === 'exit').at(-1)![1] as (
        ev: unknown,
      ) => void;
      onExit({
        projectId: rig.a.id,
        shellIndex: 0,
        code: 1,
        uptimeMs: 100,
        earlyOutput: 'No conversation found to continue',
      });
    });
    await rig.call('shells:launch', { projectId: rig.a.id });
    expect(rig.ptyManager.spawn).toHaveBeenCalledTimes(2);
    expect(rig.spawned(1).variant).toBe('first');
    expect(rig.spawned(1).env).toStrictEqual({ API_URL: 'http://localhost:4000' });
  });

  it('shells:launch-plain passes the interpolated project vars', async () => {
    const rig = envRig();
    rig.setEnv(rig.a.id, { API_URL: 'http://localhost:4000', BIN: '${PROJECT_PATH}/bin' });
    await rig.call('shells:launch-plain', { projectId: rig.a.id });
    expect(rig.spawned(0).env).toStrictEqual({
      API_URL: 'http://localhost:4000',
      BIN: `${rig.pathA}/bin`,
    });
  });

  it('shells:launch-cli profile — project NODE_ENV wins over the profile', async () => {
    const rig = envRig();
    rig.projects.updateConfig(rig.a.id, {
      cliProfiles: [{ name: 'prof', argv: ['node'], env: { NODE_ENV: 'production', X: 'x' } }],
      env: { NODE_ENV: 'development' },
    });
    await rig.call('shells:launch-cli', { projectId: rig.a.id, profileName: 'prof' });
    expect(rig.spawned(0).env).toStrictEqual({ NODE_ENV: 'development', X: 'x' });
  });

  it('shells:launch-cli inline argv+env — project wins; inline env stays uninterpolated', async () => {
    const rig = envRig();
    rig.setEnv(rig.a.id, { E: 'proj', H: '${HOME}' });
    await rig.call('shells:launch-cli', {
      projectId: rig.a.id,
      argv: ['codex'],
      env: { E: 'inline', T: '${HOME}' },
    });
    expect(rig.spawned(0).env).toStrictEqual({ E: 'proj', T: '${HOME}', H: '/home/u' });
  });

  it('tasks:run passes the project var', async () => {
    const rig = envRig();
    writeFileSync(join(rig.pathA, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    rig.setEnv(rig.a.id, { API_URL: 'http://localhost:4000' });
    await rig.call('tasks:run', { projectId: rig.a.id, taskId: 'npm:dev' });
    expect(rig.spawned(0).argv).toEqual(['npm', 'run', 'dev']);
    expect(rig.spawned(0).env).toStrictEqual({ API_URL: 'http://localhost:4000' });
  });

  it('AC16 — a second project spawns without project A vars', async () => {
    const rig = envRig();
    rig.setEnv(rig.a.id, { API_URL: 'a-only' });
    await rig.call('shells:launch-plain', { projectId: rig.a.id });
    await rig.call('shells:launch-plain', { projectId: rig.b.id });
    expect(rig.spawned(1).env).toStrictEqual({});
  });

  it("AC14 — no vars: every site passes exactly today's env", async () => {
    const rig = envRig();
    rig.settings.set('default_launch_cmd.first', { argv: ['claude'], env: { T: '${HOME}/t' } });
    writeFileSync(join(rig.pathA, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    rig.projects.updateConfig(rig.a.id, {
      cliProfiles: [{ name: 'prof', argv: ['node'], env: { NODE_ENV: 'production' } }],
    });
    await rig.call('shells:launch', { projectId: rig.a.id });
    await rig.call('shells:launch-plain', { projectId: rig.a.id });
    await rig.call('shells:launch-cli', { projectId: rig.a.id, profileName: 'prof' });
    await rig.call('shells:launch-cli', {
      projectId: rig.a.id,
      argv: ['codex'],
      env: { I: '${HOME}' },
    });
    await rig.call('tasks:run', { projectId: rig.a.id, taskId: 'npm:dev' });
    expect([0, 1, 2, 3, 4].map((n) => rig.spawned(n).env)).toStrictEqual([
      { T: '/home/u/t' },
      {},
      { NODE_ENV: 'production' },
      { I: '${HOME}' },
      {},
    ]);
  });

  it('AC15 — each spawn reflects the config at its own spawn time', async () => {
    const rig = envRig();
    rig.setEnv(rig.a.id, { API_URL: 'old' });
    await rig.call('shells:launch-plain', { projectId: rig.a.id });
    await rig.call('projects:update-config', { id: rig.a.id, config: { env: { API_URL: 'new' } } });
    await rig.call('shells:launch-plain', { projectId: rig.a.id });
    expect(rig.spawned(0).env).toStrictEqual({ API_URL: 'old' });
    expect(rig.spawned(1).env).toStrictEqual({ API_URL: 'new' });
    expect(rig.ptyManager.write).not.toHaveBeenCalled();
  });

  it('AC17 — the persisted shell row holds argv only, never a project value', async () => {
    const rig = envRig();
    rig.setEnv(rig.a.id, { TOKEN: 'S3CRET' });
    await rig.call('shells:launch-plain', { projectId: rig.a.id });
    const rows = rig.shells.list();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('S3CRET');
  });
});
