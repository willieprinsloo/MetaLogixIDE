import { describe, expect, it, vi } from 'vitest';
import { parseProjectDefaultAgent, setProjectDefaultAgent } from '@main/domain/project-default-agent';
import { DEFAULT_SETTINGS } from '@main/repos/settings-repo';
import type { Project, ProjectConfig, SettingsMap } from '@shared/types';

function rig(config: ProjectConfig = {}) {
  const project: Project = {
    id: 7, rootId: 1, path: '/projects/a', name: 'a',
    metaprojectProjectId: 'meta', linkedChatChannelId: 'chat',
    lastOpenedAt: '2026-09-01 10:00:00', pinned: true, hidden: false,
    firstLaunchedAt: '2026-09-01 10:00:00', config,
  };
  const persisted = { ...project, config: { ...config, defaultCliName: 'Agent', launchCmd: null } };
  const projects = {
    get: vi.fn((id: number) => id === project.id ? project : null),
    updateConfig: vi.fn((): Project => persisted),
  };
  const values: SettingsMap = { ...DEFAULT_SETTINGS, default_cli_profiles: [{ name: 'Agent', argv: ['agent'] }] };
  const getSettings = vi.fn<(key: keyof SettingsMap) => void>();
  const settings = {
    get<K extends keyof SettingsMap>(key: K): SettingsMap[K] {
      getSettings(key);
      return values[key];
    },
  };
  return { project, persisted, projects, settings, getSettings, values };
}

describe('parseProjectDefaultAgent', () => {
  it.each([
    ['null', null], ['undefined', undefined], ['array', []], ['string', 'request'],
    ['missing id', { name: null }], ['string id', { projectId: '7', name: null }],
    ['zero', { projectId: 0, name: null }], ['negative', { projectId: -1, name: null }],
    ['fraction', { projectId: 1.5, name: null }], ['NaN', { projectId: NaN, name: null }],
    ['infinity', { projectId: Infinity, name: null }],
    ['unsafe integer', { projectId: Number.MAX_SAFE_INTEGER + 1, name: null }],
    ['missing name', { projectId: 7 }], ['empty name', { projectId: 7, name: '' }],
    ['numeric name', { projectId: 7, name: 42 }], ['array name', { projectId: 7, name: [] }],
    ['object name', { projectId: 7, name: {} }],
  ])('rejects %s with a typed error', (_label, request) => {
    expect(parseProjectDefaultAgent(request)).toEqual({ ok: false, error: expect.any(String) });
  });

  it.each(['  Agent 字體  ', '   ', '__proto__'])('preserves exact nonempty name %j and strips ignored fields', (name) => {
    expect(parseProjectDefaultAgent({
      projectId: Number.MAX_SAFE_INTEGER, name, argv: ['untrusted'], env: { SECRET: 'discard' },
    })).toStrictEqual({ ok: true, value: { projectId: Number.MAX_SAFE_INTEGER, name } });
  });

  it('parses an explicit null reset', () => {
    expect(parseProjectDefaultAgent({ projectId: 1, name: null }))
      .toStrictEqual({ ok: true, value: { projectId: 1, name: null } });
  });
});

describe('setProjectDefaultAgent', () => {
  it('returns a missing-project failure without lookup or write', () => {
    const r = rig();
    expect(setProjectDefaultAgent(r, { projectId: 8, name: 'Agent' }))
      .toEqual({ ok: false, error: expect.stringMatching(/project/i) });
    expect(r.projects.get.mock.calls).toEqual([[8]]);
    expect(r.getSettings).not.toHaveBeenCalled();
    expect(r.projects.updateConfig).not.toHaveBeenCalled();
  });

  it('rejects an unavailable profile without mutating the loaded config', () => {
    const config: ProjectConfig = { defaultCliName: 'old', launchCmd: { first: { argv: ['legacy'], env: {} } } };
    const r = rig(config);
    expect(setProjectDefaultAgent(r, { projectId: 7, name: 'missing' }))
      .toEqual({ ok: false, error: expect.stringMatching(/profile/i) });
    expect(r.getSettings).toHaveBeenCalledWith('default_cli_profiles');
    expect(r.projects.updateConfig).not.toHaveBeenCalled();
    expect(r.project.config).toStrictEqual(config);
  });

  it('resolves project-first without consulting a same-name global', () => {
    const r = rig({ cliProfiles: [{ name: 'Agent', argv: ['project-agent'] }] });
    expect(setProjectDefaultAgent(r, { projectId: 7, name: 'Agent' }))
      .toEqual({ ok: true, project: r.persisted });
    expect(r.getSettings).not.toHaveBeenCalled();
    expect(r.projects.updateConfig.mock.calls).toEqual([[7, { defaultCliName: 'Agent', launchCmd: null }]]);
  });

  it.each(['  exact Agent  ', '   '])('finds an exact catalog name %j without normalization or binary discovery', (name) => {
    const r = rig();
    r.values.default_cli_profiles = [{ name, argv: ['/not-installed/agent'] }];
    expect(setProjectDefaultAgent(r, { projectId: 7, name })).toEqual({ ok: true, project: r.persisted });
    expect(r.projects.updateConfig.mock.calls).toEqual([[7, { defaultCliName: name, launchCmd: null }]]);
  });

  it('does not treat a differently cased or trimmed name as available', () => {
    const r = rig();
    expect(setProjectDefaultAgent(r, { projectId: 7, name: ' agent ' })).toMatchObject({ ok: false });
    expect(r.projects.updateConfig).not.toHaveBeenCalled();
  });

  it.each(['Agent', null])('explicit same value %j still makes exactly the two-field replacement patch', (name) => {
    const r = rig({
      defaultCliName: name,
      launchCmd: { first: { argv: ['first'], env: {} }, subsequent: { argv: ['resume'], env: {} } },
      env: { KEEP: 'yes' }, cwdOverride: '/elsewhere', notes: 'keep',
    });
    const before = structuredClone(r.project);
    expect(setProjectDefaultAgent(r, { projectId: 7, name })).toEqual({ ok: true, project: r.persisted });
    expect(r.projects.updateConfig.mock.calls).toEqual([[7, { defaultCliName: name, launchCmd: null }]]);
    expect(r.project).toStrictEqual(before);
    if (name === null) expect(r.getSettings).not.toHaveBeenCalled();
  });

  it('reset works with an empty catalog and returns the repository result by identity', () => {
    const r = rig();
    r.values.default_cli_profiles = [];
    const result = setProjectDefaultAgent(r, { projectId: 7, name: null });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.project).toBe(r.persisted);
    expect(r.projects.updateConfig.mock.calls).toEqual([[7, { defaultCliName: null, launchCmd: null }]]);
    expect(r.getSettings).not.toHaveBeenCalled();
  });

  it('propagates persistence failure without mutating input or returning success', () => {
    const r = rig({ defaultCliName: 'old' });
    const failure = new Error('write failed');
    r.projects.updateConfig.mockImplementation(() => { throw failure; });
    expect(() => setProjectDefaultAgent(r, { projectId: 7, name: 'Agent' })).toThrow(failure);
    expect(r.project.config).toStrictEqual({ defaultCliName: 'old' });
  });
});

describe('built-in Terminal default agent', () => {
  it('saves Terminal without a matching CLI profile', () => {
    const { projects, settings } = rig();
    const result = setProjectDefaultAgent({ projects, settings }, { projectId: 7, name: 'Terminal' });
    expect(result.ok).toBe(true);
    expect(projects.updateConfig).toHaveBeenCalledWith(7, { defaultCliName: 'Terminal', launchCmd: null });
  });
});
