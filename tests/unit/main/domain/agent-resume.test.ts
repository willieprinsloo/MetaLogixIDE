import { describe, expect, it } from 'vitest';
import { harnessOf, resumeArgv } from '@shared/agent-harness';
import { profileLaunchArgv, resolveLaunch } from '@main/domain/launch';
import { DEFAULT_SETTINGS, type SettingsRepo } from '@main/repos/settings-repo';
import type { AgentHarness } from '@shared/agent-harness';
import type { Project } from '@shared/types';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 1, rootId: 1, path: '/r/x', name: 'x',
    metaprojectProjectId: null, linkedChatChannelId: null,
    lastOpenedAt: null, pinned: false, hidden: false,
    firstLaunchedAt: null, config: {}, ...overrides,
  };
}

const settings = { get: (k: keyof typeof DEFAULT_SETTINGS) => DEFAULT_SETTINGS[k] } as unknown as SettingsRepo;
const never = (): boolean => false;
const LAUNCHED = '2026-11-01 10:00:00';

describe('harnessOf', () => {
  it.each([
    [['claude'], 'claude'], [['/opt/bin/codex', '-m', 'x'], 'codex'], [['C:\\bin\\opencode.exe'], 'opencode'],
    [['gemini'], null], [['omp'], null], [[], null],
  ] as const)('%j → %s', (argv, harness) => {
    expect(harnessOf(argv)).toBe(harness);
  });
});

describe('resumeArgv', () => {
  it('continues the latest session in the working directory for each supported harness', () => {
    expect(resumeArgv(['claude', '--permission-mode', 'auto'])).toEqual(['claude', '--permission-mode', 'auto', '--continue']);
    expect(resumeArgv(['codex', '-m', 'gpt'])).toEqual(['codex', 'resume', '--last', '-m', 'gpt']);
    expect(resumeArgv(['opencode'])).toEqual(['opencode', '--continue']);
  });

  it('leaves a command that already resumes alone', () => {
    expect(resumeArgv(['claude', '--resume', 'abc'])).toEqual(['claude', '--resume', 'abc']);
    expect(resumeArgv(['codex', 'resume', '--last'])).toEqual(['codex', 'resume', '--last']);
    expect(resumeArgv(['opencode', '-s', 'ses_1'])).toEqual(['opencode', '-s', 'ses_1']);
  });

  it('does not resume other subcommands or other harnesses', () => {
    expect(resumeArgv(['codex', 'exec', 'do it'])).toBeNull();
    expect(resumeArgv(['gemini'])).toBeNull();
  });
});

describe('profileLaunchArgv', () => {
  const ran = project({ firstLaunchedAt: LAUNCHED, config: { resumableAgents: ['codex'] } });

  it('resumes a harness that has run in the project before', () => {
    expect(profileLaunchArgv(ran, ['codex'], 'subsequent', never)).toEqual(['codex', 'resume', '--last']);
  });

  it('starts fresh for a harness that never ran here, on a first launch, or while another shell runs it', () => {
    expect(profileLaunchArgv(ran, ['opencode'], 'subsequent', never)).toEqual(['opencode']);
    expect(profileLaunchArgv(ran, ['codex'], 'first', never)).toEqual(['codex']);
    expect(profileLaunchArgv(ran, ['codex'], 'subsequent', (h: AgentHarness) => h === 'codex')).toEqual(['codex']);
  });
});

describe('resolveLaunch with a default agent', () => {
  it('resumes the default Claude profile once it has run (the session no longer resets on reopen)', () => {
    const p = project({ firstLaunchedAt: LAUNCHED, config: { defaultCliName: 'Claude', resumableAgents: ['claude'] } });
    expect(resolveLaunch(p, settings, '/home/u', {}).argv).toEqual(['claude', '--continue']);
  });

  it('resumes Codex and opencode defaults the same way', () => {
    for (const [name, argv] of [['OpenAI Codex', ['codex', 'resume', '--last']], ['opencode', ['opencode', '--continue']]] as const) {
      const harness = argv[0] as AgentHarness;
      const p = project({ firstLaunchedAt: LAUNCHED, config: { defaultCliName: name, resumableAgents: [harness] } });
      expect(resolveLaunch(p, settings, '/home/u', {}).argv).toEqual(argv);
    }
  });

  it('starts the default agent fresh on the project\'s first launch', () => {
    const p = project({ config: { defaultCliName: 'Claude', resumableAgents: ['claude'] } });
    expect(resolveLaunch(p, settings, '/home/u', {}).argv).toEqual(['claude']);
  });

  it('does not resume the built-in Claude launch while another shell in the project runs Claude', () => {
    const p = project({ firstLaunchedAt: LAUNCHED });
    expect(resolveLaunch(p, settings, '/home/u', {}).argv).toEqual(['claude', '--continue']);
    expect(resolveLaunch(p, settings, '/home/u', {}, { resumeBlocked: (h) => h === 'claude' }).argv).toEqual(['claude']);
  });
});
