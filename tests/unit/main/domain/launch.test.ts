import { describe, it, expect } from 'vitest';
import { resolveLaunch } from '@main/domain/launch';
import type { Project } from '@shared/types';
import { DEFAULT_SETTINGS } from '@main/repos/settings-repo';
import { applyClaudePermissionMode } from '@main/domain/claude-permission-mode';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { SettingsRepo } from '@main/repos/settings-repo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 1, rootId: 1, path: '/r/x', name: 'x',
    metaprojectProjectId: null, linkedChatChannelId: null,
    lastOpenedAt: null, pinned: false, hidden: false,
    firstLaunchedAt: null, config: {}, ...overrides,
  };
}

const fakeSettings = { get: (k: keyof typeof DEFAULT_SETTINGS) => DEFAULT_SETTINGS[k] } as unknown as import('@main/repos/settings-repo').SettingsRepo;

describe('resolveLaunch', () => {
  it('uses first variant when project has never launched', () => {
    const r = resolveLaunch(project(), fakeSettings, '/home/u', {});
    expect(r.variant).toBe('first');
    expect(r.argv).toEqual(DEFAULT_SETTINGS['default_launch_cmd.first'].argv);
    expect(r.cwd).toBe('/r/x');
  });

  it('uses subsequent variant once first_launched_at is set', () => {
    const r = resolveLaunch(
      project({ firstLaunchedAt: '2026-07-18 10:00:00' }),
      fakeSettings,
      '/home/u',
      {},
    );
    expect(r.variant).toBe('subsequent');
    expect(r.argv).toEqual(DEFAULT_SETTINGS['default_launch_cmd.subsequent'].argv);
  });

  it('project override wins over global default', () => {
    const p = project({ config: { launchCmd: { first: { argv: ['echo', 'hello'], env: {} } } } });
    const r = resolveLaunch(p, fakeSettings, '/home/u', {});
    expect(r.argv).toEqual(['echo', 'hello']);
  });

  it('interpolates PROJECT_PATH', () => {
    const p = project({ config: { launchCmd: { first: { argv: ['run', '${PROJECT_PATH}'], env: {} } } } });
    const r = resolveLaunch(p, fakeSettings, '/home/u', {});
    expect(r.argv).toEqual(['run', '/r/x']);
  });

  it('respects cwd_override', () => {
    const p = project({ config: { cwdOverride: '/r/x/sub' } });
    const r = resolveLaunch(p, fakeSettings, '/home/u', {});
    expect(r.cwd).toBe('/r/x/sub');
  });

  it('AC16 — after applying Auto, both first and subsequent argv carry --permission-mode auto', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'lr-')), 'db'));
    runMigrations(db, resolve(__dirname, '../../../../migrations'));
    const settings = new SettingsRepo(db);
    settings.seedDefaults();
    applyClaudePermissionMode(settings, 'auto');

    const first = resolveLaunch(project(), settings, '/home/u', {});
    expect(first.argv).toEqual(expect.arrayContaining(['--permission-mode', 'auto']));

    const subsequent = resolveLaunch(
      project({ firstLaunchedAt: '2026-07-18 10:00:00' }),
      settings,
      '/home/u',
      {},
    );
    expect(subsequent.argv).toEqual(expect.arrayContaining(['--permission-mode', 'auto']));
  });
});

describe('resolveLaunch — project env (AC10–AC14)', () => {
  const tpl = (argv: string[], env: Record<string, string> = {}) => ({
    launchCmd: { first: { argv, env } },
  });

  it('project env overrides template env in the output env', () => {
    const p = project({
      config: {
        ...tpl(['run'], { NODE_ENV: 'production', T: 't' }),
        env: { NODE_ENV: 'development' },
      },
    });
    expect(resolveLaunch(p, fakeSettings, '/home/u', {}).env).toEqual({
      NODE_ENV: 'development',
      T: 't',
    });
  });

  it('project values resolve ${env.PATH} against the inherited env (AC12)', () => {
    const p = project({
      config: { ...tpl(['run']), env: { PATH: '${PROJECT_PATH}/bin:${env.PATH}' } },
    });
    expect(resolveLaunch(p, fakeSettings, '/home/u', { PATH: '/usr/bin' }).env.PATH).toBe(
      '/r/x/bin:/usr/bin',
    );
  });

  it('D6 clash — argv ${env.X} sees the project value when template and project both set X (AC13)', () => {
    const p = project({
      config: { ...tpl(['run', '${env.X}'], { X: 'tpl' }), env: { X: 'proj' } },
    });
    expect(resolveLaunch(p, fakeSettings, '/home/u', { X: 'inh' }).argv).toEqual(['run', 'proj']);
  });

  it('D6 interpolated — argv sees the expanded project value, not the raw token (AC13)', () => {
    const p = project({
      config: { ...tpl(['run', '${env.X}']), env: { X: '${PROJECT_PATH}/bin' } },
    });
    expect(resolveLaunch(p, fakeSettings, '/home/u', {}).argv).toEqual(['run', '/r/x/bin']);
  });

  it('argv ${env.NAME} falls back to the inherited env (AC13)', () => {
    const p = project({ config: tpl(['run', '${env.ONLY_INHERITED}']) });
    expect(resolveLaunch(p, fakeSettings, '/home/u', { ONLY_INHERITED: 'inh' }).argv).toEqual([
      'run',
      'inh',
    ]);
  });

  it('argv ${env.NAME} sees the template value over the inherited one (AC13)', () => {
    const p = project({ config: tpl(['run', '${env.X}'], { X: 'tpl' }) });
    expect(resolveLaunch(p, fakeSettings, '/home/u', { X: 'inh' }).argv).toEqual(['run', 'tpl']);
  });

  it('argv ${env.NAME} unset everywhere resolves to the empty string (AC13)', () => {
    const p = project({
      config: { ...tpl(['run', '[${env.UNSET_EVERYWHERE}]'], { T: 't' }), env: { P: 'p' } },
    });
    expect(resolveLaunch(p, fakeSettings, '/home/u', { I: 'i' }).argv).toEqual(['run', '[]']);
  });

  it('AC13a / D7 — template env ${env.P} still resolves to the raw project value', () => {
    const p = project({
      config: { ...tpl(['run'], { T: '${env.P}' }), env: { P: '${PROJECT_PATH}/raw' } },
    });
    expect(resolveLaunch(p, fakeSettings, '/home/u', { P: 'inh' }).env.T).toBe(
      '${PROJECT_PATH}/raw',
    );
  });

  it('AC13a / D7 — template env does not see the inherited env', () => {
    const p = project({ config: tpl(['run'], { T: '[${env.ONLY_INHERITED}]' }) });
    expect(resolveLaunch(p, fakeSettings, '/home/u', { ONLY_INHERITED: 'inh' }).env.T).toBe('[]');
  });

  it('AC13a / D7 — template env ${env.Y} sees another template value, which wins over the project', () => {
    const p = project({
      config: { ...tpl(['run'], { T: '${env.Y}', Y: 'tpl-y' }), env: { Y: 'proj-y' } },
    });
    const r = resolveLaunch(p, fakeSettings, '/home/u', {});
    expect(r.env.T).toBe('tpl-y');
    expect(r.env.Y).toBe('proj-y');
  });

  it('AC13a / D7 — template env tokens HOME, PROJECT_PATH, PROJECT_NAME resolve as today', () => {
    const p = project({ config: tpl(['run'], { T: '${HOME}|${PROJECT_PATH}|${PROJECT_NAME}' }) });
    expect(resolveLaunch(p, fakeSettings, '/home/u', { HOME: '/other' }).env.T).toBe(
      '/home/u|/r/x|x',
    );
  });

  it.each([
    ['global default', {}],
    ['project launchCmd', tpl(['run', '${env.T}', '${PROJECT_NAME}'], { T: '${HOME}/t', U: 'u' })],
  ])('AC14 — no project vars: env equals the interpolated template env (%s)', (_label, config) => {
    const p = project({ config });
    const r = resolveLaunch(p, fakeSettings, '/home/u', { PATH: '/usr/bin' });
    const templateEnv =
      'launchCmd' in config
        ? config.launchCmd.first.env
        : DEFAULT_SETTINGS['default_launch_cmd.first'].env;
    const expected = Object.fromEntries(
      Object.entries(templateEnv).map(([k, v]) => [k, v.replace('${HOME}', '/home/u')]),
    );
    expect(r.env).toStrictEqual(expected);
  });

  it('a CLI profile picked by defaultCliName gets the project env layered on top', () => {
    const p = project({
      config: {
        defaultCliName: 'codex',
        cliProfiles: [{ name: 'codex', argv: ['codex', '${env.K}'], env: { K: 'profile' } }],
        env: { K: 'proj' },
      },
    });
    const r = resolveLaunch(p, fakeSettings, '/home/u', {});
    expect(r.argv).toEqual(['codex', 'proj']);
    expect(r.env).toEqual({ K: 'proj' });
  });

  it.each([
    ['without project variables', undefined],
    ['with project variables', { Y: 'y' }],
  ])('AC19 / D14 — argv ${env.X} gets the interpolated template value %s', (_label, env) => {
    const p = project({
      config: { ...tpl(['run', '${env.X}'], { X: '${HOME}/t' }), ...(env ? { env } : {}) },
    });
    const r = resolveLaunch(p, fakeSettings, '/home/u', {});
    expect(r.argv).toEqual(['run', '/home/u/t']);
    expect(r.env.X).toBe('/home/u/t');
  });

  it('drops a stored reserved project name from the output env', () => {
    const p = project({
      config: { ...tpl(['claude']), env: { METAIDE_HOOK_TOKEN: 'evil', A: '1' } },
    });
    expect(resolveLaunch(p, fakeSettings, '/home/u', {}).env).toEqual({ A: '1' });
  });
});

describe('resolveLaunch — app-wide env (AC9, AC10)', () => {
  const settingsWith = (app_env: Record<string, string>) =>
    ({ get: (k: string) => (k === 'app_env' ? app_env : DEFAULT_SETTINGS[k as keyof typeof DEFAULT_SETTINGS]) }) as unknown as import('@main/repos/settings-repo').SettingsRepo;

  it('an app-wide variable reaches the primary launch env with no project or template value', () => {
    const p = project();
    const r = resolveLaunch(p, settingsWith({ X: 'app' }), '/home/u', {});
    expect(r.env.X).toBe('app');
  });

  it('argv ${env.X} sees the app-wide value when there is no project or template value', () => {
    const p = project({ config: { launchCmd: { first: { argv: ['run', '${env.X}'], env: {} } } } });
    const r = resolveLaunch(p, settingsWith({ X: 'app' }), '/home/u', {});
    expect(r.argv).toEqual(['run', 'app']);
  });

  it('a project value still wins over an app-wide value of the same name', () => {
    const p = project({ config: { env: { X: 'proj' } } });
    const r = resolveLaunch(p, settingsWith({ X: 'app' }), '/home/u', {});
    expect(r.env.X).toBe('proj');
  });

  it('finding 5 — template env interpolation does not see app-wide variables', () => {
    const p = project({
      config: { launchCmd: { first: { argv: ['run'], env: { T: '[${env.X}]' } } } },
    });
    const r = resolveLaunch(p, settingsWith({ X: 'app' }), '/home/u', {});
    expect(r.env.T).toBe('[]');
  });
});
