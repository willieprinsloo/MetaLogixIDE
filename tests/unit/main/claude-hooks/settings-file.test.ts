import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { buildHookSettings, hookSettingsPath, removeHookSettings, writeHookSettings } from '@main/claude-hooks/settings-file';

const URL = 'http://127.0.0.1:43210/claude-hook';

const expectedHook = {
  type: 'http',
  url: URL,
  timeout: 1,
  headers: { 'X-Metaide-Shell': '$METAIDE_HOOK_SHELL', Authorization: 'Bearer $METAIDE_HOOK_TOKEN' },
  allowedEnvVars: ['METAIDE_HOOK_SHELL', 'METAIDE_HOOK_TOKEN'],
};

describe('buildHookSettings', () => {
  it('registers the same http hook on all eight events, matcher-all where Claude supports a matcher (AC13)', () => {
    expect(buildHookSettings(URL)).toEqual({
      hooks: {
        Notification: [{ matcher: '', hooks: [expectedHook] }],
        Stop: [{ hooks: [expectedHook] }],
        UserPromptSubmit: [{ hooks: [expectedHook] }],
        PreToolUse: [{ matcher: '', hooks: [expectedHook] }],
        PostToolUse: [{ matcher: '', hooks: [expectedHook] }],
        PostToolUseFailure: [{ matcher: '', hooks: [expectedHook] }],
        PermissionRequest: [{ matcher: '', hooks: [expectedHook] }],
        StopFailure: [{ matcher: '', hooks: [expectedHook] }],
      },
    });
  });

  it('registers nothing else (user settings stay in charge of everything but these hooks)', () => {
    const settings = buildHookSettings(URL);
    expect(Object.keys(settings)).toEqual(['hooks']);
    expect(Object.keys(settings.hooks).sort()).toEqual([
      'Notification', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'Stop', 'StopFailure', 'UserPromptSubmit',
    ]);
  });
});

describe('hookSettingsPath (AC7)', () => {
  it('lives under <home>/.metaide/claude-hooks/, keyed by the receiver port', () => {
    expect(hookSettingsPath('/home/u', 43210)).toBe(join('/home/u', '.metaide', 'claude-hooks', 'settings-43210.json'));
  });

  it('differs per receiver port so two app instances never share a file', () => {
    expect(hookSettingsPath('/home/u', 5000)).not.toBe(hookSettingsPath('/home/u', 5001));
  });

  it('is outside ~/.claude, ~/.claude.json and any project .claude directory', () => {
    const home = '/home/u';
    const rel = relative(home, hookSettingsPath(home, 43210));
    const segments = rel.split(sep);
    expect(segments.some((s) => s.startsWith('.claude'))).toBe(false);
    expect(rel.startsWith('..')).toBe(false);
  });
});

describe('writeHookSettings / removeHookSettings', () => {
  const pathIn = (home: string) => hookSettingsPath(home, 43210);

  it('writes the settings JSON with mode 0600, creating the directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'hooks-home-'));
    writeHookSettings(pathIn(home), URL);
    expect(JSON.parse(readFileSync(pathIn(home), 'utf8'))).toEqual(buildHookSettings(URL));
    if (process.platform !== 'win32') expect(statSync(pathIn(home)).mode & 0o777).toBe(0o600);
  });

  it('contains no secret — only env-var templates', () => {
    const home = mkdtempSync(join(tmpdir(), 'hooks-home-'));
    writeHookSettings(pathIn(home), URL);
    const content = readFileSync(pathIn(home), 'utf8');
    expect(content).not.toMatch(/Bearer (?!\$METAIDE_HOOK_TOKEN)/);
    expect(content).toContain('$METAIDE_HOOK_TOKEN');
  });

  it('overwrites a stale file (e.g. left by a crash with a reused port) and tightens its mode', () => {
    const home = mkdtempSync(join(tmpdir(), 'hooks-home-'));
    mkdirSync(join(home, '.metaide', 'claude-hooks'), { recursive: true });
    writeFileSync(pathIn(home), '{"stale":true}');
    chmodSync(pathIn(home), 0o644);
    writeHookSettings(pathIn(home), URL);
    expect(JSON.parse(readFileSync(pathIn(home), 'utf8'))).toEqual(buildHookSettings(URL));
    if (process.platform !== 'win32') expect(statSync(pathIn(home)).mode & 0o777).toBe(0o600);
  });

  it('touches nothing under the home Claude config', () => {
    const home = mkdtempSync(join(tmpdir(), 'hooks-home-'));
    writeHookSettings(pathIn(home), URL);
    expect(() => statSync(join(home, '.claude'))).toThrow();
    expect(() => statSync(join(home, '.claude.json'))).toThrow();
  });

  it('removeHookSettings deletes the file and ignores one that is already gone', () => {
    const home = mkdtempSync(join(tmpdir(), 'hooks-home-'));
    writeHookSettings(pathIn(home), URL);
    removeHookSettings(pathIn(home));
    expect(existsSync(pathIn(home))).toBe(false);
    expect(() => removeHookSettings(pathIn(home))).not.toThrow();
  });
});
