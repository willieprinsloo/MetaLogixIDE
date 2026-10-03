import { describe, it, expect, vi } from 'vitest';
import { createLaunchDecorator, goesThroughCmdShim } from '@main/claude-hooks/launch-decorator';
import type { ResolvedLaunch } from '@main/domain/launch';

const SETTINGS = '/home/u/.metaide/claude-hooks/settings.json';

function launchOf(argv: string[], env: Record<string, string> = { FOO: 'bar' }): ResolvedLaunch {
  return { argv, env, cwd: '/proj', variant: 'first' };
}

function setup(settingsPath: string | null = SETTINGS) {
  let n = 0;
  const sessions = { issue: vi.fn(() => { n += 1; return { id: `id-${n}`, token: `tok-${n}` }; }), release: vi.fn() };
  const decorate = createLaunchDecorator({ sessions, settingsPath: () => settingsPath });
  return { decorate, sessions };
}

describe('createLaunchDecorator — non-Claude argv is untouched (AC5)', () => {
  it.each([
    [['zsh', '-l']],
    [['/bin/bash', '--login']],
    [['codex']],
    [['node', 'scripts/mock-claude.mjs']],
    [['/usr/local/bin/claude-wrapper.sh']],
    [['my-claude']],
    [['claudex']],
  ])('%j → same object, no session issued', (argv) => {
    const { decorate, sessions } = setup();
    const launch = launchOf(argv);
    expect(decorate(1, 0, launch)).toBe(launch);
    expect(sessions.issue).not.toHaveBeenCalled();
  });
});

describe('createLaunchDecorator — Claude argv gets --settings and the hook env (AC6)', () => {
  it.each([
    [['claude'], ['claude', '--settings', SETTINGS]],
    [['claude', '--continue'], ['claude', '--settings', SETTINGS, '--continue']],
    [['claude', '--permission-mode', 'auto', '--continue'], ['claude', '--settings', SETTINGS, '--permission-mode', 'auto', '--continue']],
    [['/x/claude.cmd'], ['/x/claude.cmd', '--settings', SETTINGS]],
    [['C:\\bin\\CLAUDE.EXE', '--continue'], ['C:\\bin\\CLAUDE.EXE', '--settings', SETTINGS, '--continue']],
  ])('%j → %j', (argv, expected) => {
    const { decorate } = setup();
    const out = decorate(3, 1, launchOf(argv));
    expect(out.argv).toEqual(expected);
    expect(out.env).toEqual({ FOO: 'bar', METAIDE_HOOK_SHELL: 'id-1', METAIDE_HOOK_TOKEN: 'tok-1' });
    expect(out.cwd).toBe('/proj');
    expect(out.variant).toBe('first');
  });

  it('issues the session for the spawning shell and keeps the token out of argv', () => {
    const { decorate, sessions } = setup();
    const out = decorate(3, 1, launchOf(['claude']));
    expect(sessions.issue).toHaveBeenCalledWith({ projectId: 3, shellIndex: 1 });
    expect(out.argv.join(' ')).not.toContain('tok-1');
    expect(out.argv.join(' ')).not.toContain('id-1');
  });

  it('never mutates the caller launch (AC8)', () => {
    const { decorate } = setup();
    const launch = launchOf(['claude', '--continue']);
    const snapshot = structuredClone(launch);
    decorate(3, 1, launch);
    expect(launch).toEqual(snapshot);
  });

  it('each call registers a fresh session', () => {
    const { decorate, sessions } = setup();
    const one = decorate(1, 0, launchOf(['claude']));
    const two = decorate(1, 0, launchOf(['claude']));
    expect(sessions.issue).toHaveBeenCalledTimes(2);
    expect(one.env.METAIDE_HOOK_SHELL).not.toBe(two.env.METAIDE_HOOK_SHELL);
  });

  it('overrides a user-set METAIDE_HOOK_* in the launch env', () => {
    const { decorate } = setup();
    const out = decorate(1, 0, launchOf(['claude'], { METAIDE_HOOK_TOKEN: 'forged' }));
    expect(out.env.METAIDE_HOOK_TOKEN).toBe('tok-1');
  });
});

describe('createLaunchDecorator — identity cases', () => {
  it.each([
    [['claude', '--settings', '/tmp/mine.json']],
    [['claude', '--continue', '--settings=/tmp/mine.json']],
    [['claude', '--settings={"hooks":{}}']],
  ])('user-supplied --settings %j → same object, no env, no session (AC27)', (argv) => {
    const { decorate, sessions } = setup();
    const launch = launchOf(argv);
    expect(decorate(1, 0, launch)).toBe(launch);
    expect(sessions.issue).not.toHaveBeenCalled();
  });

  it('receiver not listening / settings file not written → same object, no session (AC22)', () => {
    const { decorate, sessions } = setup(null);
    const launch = launchOf(['claude']);
    expect(decorate(1, 0, launch)).toBe(launch);
    expect(sessions.issue).not.toHaveBeenCalled();
  });

  it('a --settings-like value that is not the flag itself does not block injection', () => {
    const { decorate } = setup();
    const out = decorate(1, 0, launchOf(['claude', '--settingsx', '-p', 'about --settings']));
    expect(out.argv).toEqual(['claude', '--settings', SETTINGS, '--settingsx', '-p', 'about --settings']);
  });

  it.each([
    ['a non-Claude spawn', ['zsh', '-l'], SETTINGS],
    ['a user --settings spawn', ['claude', '--settings', '/tmp/mine.json'], SETTINGS],
    ['a Claude spawn while hooks are unavailable', ['claude'], null],
  ])('%s releases any session left by the previous spawn of that shell', (_label, argv, path) => {
    const { decorate, sessions } = setup(path);
    decorate(5, 2, launchOf(argv));
    expect(sessions.release).toHaveBeenCalledWith({ projectId: 5, shellIndex: 2 });
  });

  it('an injected spawn does not release (issue replaces the previous session itself)', () => {
    const { decorate, sessions } = setup();
    decorate(5, 2, launchOf(['claude']));
    expect(sessions.release).not.toHaveBeenCalled();
  });
});

describe('createLaunchDecorator — Windows cmd.exe /c shim with a spaced settings path (AC22)', () => {
  const SPACED = 'C:\\Users\\Jane Doe\\.metaide\\claude-hooks\\settings-5000.json';
  const PLAIN = 'C:\\Users\\jane\\.metaide\\claude-hooks\\settings-5000.json';

  function winSetup(settingsPath: string, platform: NodeJS.Platform, viaCmd: boolean) {
    const sessions = { issue: vi.fn(() => ({ id: 'id-1', token: 'tok-1' })), release: vi.fn() };
    const goesThroughCmd = vi.fn(() => viaCmd);
    const decorate = createLaunchDecorator({ sessions, settingsPath: () => settingsPath, platform, goesThroughCmd });
    return { decorate, sessions, goesThroughCmd };
  }

  it('win32 + spaced path + .cmd shim → same object, session released, none issued', () => {
    const { decorate, sessions, goesThroughCmd } = winSetup(SPACED, 'win32', true);
    const launch = launchOf(['claude', '--continue']);
    expect(decorate(1, 0, launch)).toBe(launch);
    expect(goesThroughCmd).toHaveBeenCalledWith(['claude', '--continue']);
    expect(sessions.release).toHaveBeenCalledWith({ projectId: 1, shellIndex: 0 });
    expect(sessions.issue).not.toHaveBeenCalled();
  });

  it('win32 + spaced path + native claude.exe → still decorated', () => {
    const { decorate } = winSetup(SPACED, 'win32', false);
    expect(decorate(1, 0, launchOf(['claude'])).argv).toEqual(['claude', '--settings', SPACED]);
  });

  it('win32 + .cmd shim + path without whitespace → still decorated', () => {
    const { decorate } = winSetup(PLAIN, 'win32', true);
    expect(decorate(1, 0, launchOf(['claude'])).argv).toEqual(['claude', '--settings', PLAIN]);
  });

  it('POSIX + spaced path → still decorated and never asks about cmd', () => {
    const { decorate, goesThroughCmd } = winSetup('/Users/Jane Doe/.metaide/claude-hooks/settings-5000.json', 'darwin', true);
    expect(decorate(1, 0, launchOf(['claude'])).argv).toEqual(['claude', '--settings', '/Users/Jane Doe/.metaide/claude-hooks/settings-5000.json']);
    expect(goesThroughCmd).not.toHaveBeenCalled();
  });
});

describe('goesThroughCmdShim', () => {
  it.skipIf(process.platform === 'win32')('is false off Windows, where argv spawns as given', () => {
    expect(goesThroughCmdShim(['claude', '--continue'])).toBe(false);
    expect(goesThroughCmdShim(['/x/claude.cmd'])).toBe(false);
  });
});

