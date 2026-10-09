import { describe, it, expect, vi } from 'vitest';
import { resolveSpawnEnv, type SpawnEnvInput } from '@main/domain/spawn-env';
import { createLaunchDecorator } from '@main/claude-hooks/launch-decorator';
import type { ProjectConfig } from '@shared/types';

function input(env: ProjectConfig['env'], overrides: Partial<SpawnEnvInput> = {}): SpawnEnvInput {
  return {
    project: { path: '/r/api', config: env === undefined ? {} : { env } },
    templateEnv: {},
    inherited: {},
    homeDir: '/home/u',
    appEnv: {},
    ...overrides,
  };
}

describe('resolveSpawnEnv — precedence (AC11)', () => {
  it('overlay is template env plus project vars', () => {
    const r = resolveSpawnEnv(
      input({ API_URL: 'http://localhost:4000' }, { templateEnv: { T: 't' } }),
    );
    expect(r.env).toEqual({ T: 't', API_URL: 'http://localhost:4000' });
  });

  it('project var wins over the same name in the template env', () => {
    const r = resolveSpawnEnv(
      input({ NODE_ENV: 'development' }, { templateEnv: { NODE_ENV: 'production' } }),
    );
    expect(r.env.NODE_ENV).toBe('development');
  });

  it('inherited vars are not copied into the overlay (PtyManager layers process.env itself)', () => {
    const r = resolveSpawnEnv(
      input({ A: '1' }, { inherited: { PATH: '/usr/bin', HOME: '/home/u' } }),
    );
    expect(r.env).toEqual({ A: '1' });
  });

  it('project var wins over the inherited value in lookup', () => {
    const r = resolveSpawnEnv(input({ PATH: '/p' }, { inherited: { PATH: '/usr/bin' } }));
    expect(r.lookup.PATH).toBe('/p');
  });
});

describe('resolveSpawnEnv — ${env.NAME} in project values (AC12)', () => {
  it('extends the inherited PATH', () => {
    const r = resolveSpawnEnv(
      input(
        { PATH: '${PROJECT_PATH}/node_modules/.bin:${env.PATH}' },
        { inherited: { PATH: '/usr/bin:/bin' } },
      ),
    );
    expect(r.env.PATH).toBe('/r/api/node_modules/.bin:/usr/bin:/bin');
  });

  it('resolves to the template value when the template sets the name', () => {
    const r = resolveSpawnEnv(
      input({ X: 'pre-${env.T}' }, { templateEnv: { T: 'tpl' }, inherited: { T: 'inh' } }),
    );
    expect(r.env.X).toBe('pre-tpl');
  });

  it('resolves an unset name to the empty string', () => {
    const r = resolveSpawnEnv(input({ X: '[${env.NOPE}]' }, { inherited: { OTHER: 'o' } }));
    expect(r.env.X).toBe('[]');
  });

  it('treats an inherited undefined as unset', () => {
    const r = resolveSpawnEnv(input({ X: '[${env.GONE}]' }, { inherited: { GONE: undefined } }));
    expect(r.env.X).toBe('[]');
  });

  it('does not resolve one project var against another project var', () => {
    const r = resolveSpawnEnv(
      input({ B: 'project-b', A: '${env.B}' }, { inherited: { B: 'inherited-b' } }),
    );
    expect(r.env.A).toBe('inherited-b');
  });

  it('a reference to a name only the project sets resolves to the empty string', () => {
    const r = resolveSpawnEnv(input({ B: 'project-b', A: '[${env.B}]' }));
    expect(r.env.A).toBe('[]');
  });

  it('is single-pass: an expansion that yields a token is not expanded again', () => {
    const r = resolveSpawnEnv(
      input({ X: '${env.RAW}' }, { inherited: { RAW: '${HOME}', HOME: '/home/x' } }),
    );
    expect(r.env.X).toBe('${HOME}');
  });
});

describe('resolveSpawnEnv — path tokens', () => {
  it('resolves ${HOME}, ${PROJECT_PATH} and ${PROJECT_NAME} from the inputs', () => {
    const r = resolveSpawnEnv(
      input(
        { X: '${HOME}|${PROJECT_PATH}|${PROJECT_NAME}' },
        { inherited: { HOME: '/inherited/home' } },
      ),
    );
    expect(r.env.X).toBe('/home/u|/r/api|api');
  });

  it('PROJECT_NAME is the basename of the current path', () => {
    const r = resolveSpawnEnv({
      ...input({ X: '${PROJECT_NAME}' }),
      project: { path: '/a/b/renamed', config: { env: { X: '${PROJECT_NAME}' } } },
    });
    expect(r.env.X).toBe('renamed');
  });
});

describe('resolveSpawnEnv — stored names that fail validation are dropped', () => {
  it.each([
    ['reserved', 'METAIDE_HOOK_TOKEN'],
    ['reserved lower-case', 'metaide_x'],
    ['reserved __proto__', '__proto__'],
    ['invalid', 'MY-VAR'],
    ['leading digit', '1FOO'],
  ])('drops a %s name', (_label, name) => {
    const r = resolveSpawnEnv(input({ [name]: 'v', OK: '1' }, { templateEnv: { T: 't' } }));
    expect(r.env).toEqual({ T: 't', OK: '1' });
    expect(r.lookup).not.toHaveProperty(name);
  });

  it('drops a non-string or NUL-carrying stored value', () => {
    const env = { NUM: 1, NUL: 'a\0b', OK: '1' } as unknown as Record<string, string>;
    const r = resolveSpawnEnv(input(env));
    expect(r.env).toEqual({ OK: '1' });
  });

  it('keeps a template env name even when it would fail project validation', () => {
    const r = resolveSpawnEnv(input({}, { templateEnv: { METAIDE_TEST_MODE: '1' } }));
    expect(r.env).toEqual({ METAIDE_TEST_MODE: '1' });
  });
});

describe('resolveSpawnEnv — no project vars (AC14)', () => {
  it.each([
    ['env undefined', undefined],
    ['env empty', {}],
  ])('%s → env deep-equals the template env', (_label, env) => {
    const templateEnv = { T: '${env.NOT_INTERPOLATED}', U: 'u' };
    const r = resolveSpawnEnv(input(env, { templateEnv, inherited: { PATH: '/usr/bin' } }));
    expect(r.env).toEqual(templateEnv);
  });

  it('empty template and no vars → empty overlay', () => {
    expect(resolveSpawnEnv(input(undefined, { inherited: { PATH: '/usr/bin' } })).env).toEqual({});
  });

  it('does not mutate the template env or inherited inputs', () => {
    const templateEnv = { T: 't' };
    const inherited = { PATH: '/usr/bin' };
    resolveSpawnEnv(input({ T: 'p', PATH: 'x' }, { templateEnv, inherited }));
    expect(templateEnv).toEqual({ T: 't' });
    expect(inherited).toEqual({ PATH: '/usr/bin' });
  });

  it('template env values are passed through uninterpolated', () => {
    const r = resolveSpawnEnv(input({ A: '1' }, { templateEnv: { T: '${HOME}' } }));
    expect(r.env.T).toBe('${HOME}');
  });
});

describe('resolveSpawnEnv — lookup', () => {
  it('is inherited (defined only) ⊕ template ⊕ project', () => {
    const r = resolveSpawnEnv(
      input(
        { P: 'proj', X: 'proj-x' },
        {
          templateEnv: { T: 'tpl', X: 'tpl-x' },
          inherited: { I: 'inh', T: 'inh-t', U: undefined },
        },
      ),
    );
    expect(r.lookup).toStrictEqual({ I: 'inh', T: 'tpl', X: 'proj-x', P: 'proj' });
    expect(Object.keys(r.lookup)).not.toContain('U');
  });

  it('carries the interpolated project value, not the raw token', () => {
    const r = resolveSpawnEnv(input({ X: '${PROJECT_PATH}/bin' }));
    expect(r.lookup.X).toBe('/r/api/bin');
  });
});

describe('resolveSpawnEnv — composition with the Claude launch decorator', () => {
  it('hook variables from the decorator win over a stored reserved project var', () => {
    const sessions = {
      issue: vi.fn(() => ({ id: 'app-id', token: 'app-token' })),
      release: vi.fn(),
    };
    const decorate = createLaunchDecorator({
      sessions,
      settingsPath: () => '/s.json',
      platform: 'darwin',
    });
    const { env } = resolveSpawnEnv(
      input({ METAIDE_HOOK_TOKEN: 'evil', METAIDE_HOOK_SHELL: 'evil', API: 'a' }),
    );
    const out = decorate(1, 0, { argv: ['claude'], env, cwd: '/r/api', variant: 'first' });
    expect(out.env).toEqual({
      API: 'a',
      METAIDE_HOOK_SHELL: 'app-id',
      METAIDE_HOOK_TOKEN: 'app-token',
    });
  });

  it('a plain shell never carries a stored reserved name', () => {
    const sessions = { issue: vi.fn(), release: vi.fn() };
    const decorate = createLaunchDecorator({
      sessions,
      settingsPath: () => '/s.json',
      platform: 'darwin',
    });
    const { env } = resolveSpawnEnv(input({ METAIDE_HOOK_TOKEN: 'evil' }));
    const out = decorate(1, 1, { argv: ['zsh', '-l'], env, cwd: '/r/api', variant: 'first' });
    expect(out.env).toEqual({});
  });
});

describe('resolveSpawnEnv — app env precedence (AC10, AC11)', () => {
  it('app < template < project', () => {
    const r = resolveSpawnEnv(
      input({ X: 'proj' }, { templateEnv: { X: 'tpl' }, appEnv: { X: 'app' } }),
    );
    expect(r.env.X).toBe('proj');
  });

  it('template wins over app when there is no project value', () => {
    const r = resolveSpawnEnv(input({}, { templateEnv: { X: 'tpl' }, appEnv: { X: 'app' } }));
    expect(r.env.X).toBe('tpl');
  });

  it('app value appears in the overlay with no project or template value', () => {
    const r = resolveSpawnEnv(input({}, { appEnv: { X: 'app' } }));
    expect(r.env).toEqual({ X: 'app' });
  });

  it('app value wins over the same name in the inherited environment', () => {
    const r = resolveSpawnEnv(
      input({}, { appEnv: { X: 'app' }, inherited: { X: 'inherited' } }),
    );
    expect(r.env.X).toBe('app');
    expect(r.lookup.X).toBe('app');
  });

  it('a project value of the empty string overrides a non-empty app value', () => {
    const r = resolveSpawnEnv(input({ X: '' }, { appEnv: { X: 'app' } }));
    expect(r.env.X).toBe('');
    expect(Object.keys(r.env)).toContain('X');
  });
});

describe('resolveSpawnEnv — app value interpolation (AC12)', () => {
  it('resolves ${HOME}, ${PROJECT_PATH} and ${PROJECT_NAME}', () => {
    const r = resolveSpawnEnv(
      input({}, { appEnv: { X: '${HOME}|${PROJECT_PATH}|${PROJECT_NAME}' } }),
    );
    expect(r.env.X).toBe('/home/u|/r/api|api');
  });

  it('${env.NAME} reads the inherited environment only', () => {
    const r = resolveSpawnEnv(
      input({}, { appEnv: { X: '[${env.BASE}]' }, inherited: { BASE: 'inh' } }),
    );
    expect(r.env.X).toBe('[inh]');
  });

  it('an app value cannot reference another app value', () => {
    const r = resolveSpawnEnv(
      input({}, { appEnv: { BASE: 'app-base', X: '[${env.BASE}]' } }),
    );
    expect(r.env.X).toBe('[]');
  });

  it('${env.NAME} does not read the template env', () => {
    const r = resolveSpawnEnv(
      input({}, { appEnv: { X: '[${env.T}]' }, templateEnv: { T: 'tpl' } }),
    );
    expect(r.env.X).toBe('[]');
  });

  it('an unset name resolves to the empty string', () => {
    const r = resolveSpawnEnv(input({}, { appEnv: { X: '[${env.NOPE}]' } }));
    expect(r.env.X).toBe('[]');
  });
});

describe('resolveSpawnEnv — project values read interpolated app values (AC13)', () => {
  it('a project value reads an app value via ${env.NAME}', () => {
    const r = resolveSpawnEnv(
      input({ P: '${env.BASE}/x' }, { appEnv: { BASE: '/opt' } }),
    );
    expect(r.env.P).toBe('/opt/x');
  });

  it('PATH chain: app extends inherited, project extends the result on both sides', () => {
    const r = resolveSpawnEnv(
      input(
        { PATH: '/b:${env.PATH}' },
        { appEnv: { PATH: '${env.PATH}:/a' }, inherited: { PATH: '/inh' } },
      ),
    );
    expect(r.env.PATH).toBe('/b:/inh:/a');
  });
});

describe('resolveSpawnEnv — argv lookup precedence (AC14)', () => {
  it('lookup carries project over template over app for the same name', () => {
    const r = resolveSpawnEnv(
      input(
        { X: 'proj' },
        { templateEnv: { X: 'tpl' }, appEnv: { X: 'app' }, inherited: { X: 'inh' } },
      ),
    );
    expect(r.lookup.X).toBe('proj');
  });

  it('lookup falls back to template then app when the project sets nothing', () => {
    const r = resolveSpawnEnv(input({}, { templateEnv: { X: 'tpl' }, appEnv: { X: 'app' } }));
    expect(r.lookup.X).toBe('tpl');
    const r2 = resolveSpawnEnv(input({}, { appEnv: { X: 'app' } }));
    expect(r2.lookup.X).toBe('app');
  });
});

describe('resolveSpawnEnv — invalid stored app entries are dropped (AC15)', () => {
  it.each([
    ['reserved', 'METAIDE_HOOK_TOKEN'],
    ['reserved lower-case', 'metaide_x'],
    ['reserved __proto__', '__proto__'],
    ['invalid', 'MY-VAR'],
  ])('drops a %s app name', (_label, name) => {
    const r = resolveSpawnEnv(input({}, { appEnv: { [name]: 'v', OK: 'app-ok' } }));
    expect(r.env).toEqual({ OK: 'app-ok' });
    expect(r.lookup).not.toHaveProperty(name);
  });

  it('drops a non-string or NUL-carrying app value, never stopping the spawn', () => {
    const appEnv = { NUM: 1, NUL: 'a\0b', OK: 'app-ok' } as unknown as Record<string, string>;
    const r = resolveSpawnEnv(input({}, { appEnv }));
    expect(r.env).toEqual({ OK: 'app-ok' });
  });
});

describe('resolveSpawnEnv — does not mutate appEnv', () => {
  it('leaves the caller-supplied appEnv object untouched', () => {
    const appEnv = { X: 'app' };
    resolveSpawnEnv(input({ X: 'proj' }, { appEnv }));
    expect(appEnv).toEqual({ X: 'app' });
  });
});
