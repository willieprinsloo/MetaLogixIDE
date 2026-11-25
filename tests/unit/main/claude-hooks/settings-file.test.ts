import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { buildHookSettings, hookSettingsPath, removeHookSettings, writeHookSettings } from '@main/claude-hooks/settings-file';

const expectedHook = {
  type: 'command',
  command: 'ELECTRON_RUN_AS_NODE=1 "$METAIDE_HOOK_EXE" "$METAIDE_HOOK_FORWARDER" >/dev/null 2>&1 || :',
  async: true,
  timeout: 1,
};

describe('buildHookSettings', () => {
  it('registers notification, turn-confirmation, session-start and tool-use events', () => {
    expect(buildHookSettings('linux')).toEqual({
      hooks: {
        Notification: [{ matcher: '', hooks: [expectedHook] }],
        SessionStart: [{ matcher: '', hooks: [expectedHook] }],
        Stop: [{ hooks: [expectedHook] }],
        UserPromptSubmit: [{ hooks: [expectedHook] }],
        PreToolUse: [{ matcher: '', hooks: [expectedHook] }],
        PostToolUse: [{ matcher: '', hooks: [expectedHook] }],
      },
    });
  });

  it('registers nothing else (user settings stay in charge of everything but these hooks)', () => {
    const settings = buildHookSettings('linux');
    expect(Object.keys(settings)).toEqual(['hooks']);
    expect(Object.keys(settings.hooks).sort()).toEqual(['Notification', 'PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  });
  it('uses PowerShell on Windows without writing a token or a receiver address', () => {
    const hook = buildHookSettings('win32').hooks.Stop[0]?.hooks[0];
    expect(hook).toMatchObject({ type: 'command', shell: 'powershell', async: true });
    expect(hook?.command).toContain('$env:METAIDE_HOOK_EXE');
    expect(hook?.command).not.toMatch(/TOKEN|https?:\/\//);
  });
});

describe('hookSettingsPath (AC7)', () => {
  it('lives under <home>/.metaide/claude-hooks/, keyed by the IDE instance', () => {
    expect(hookSettingsPath('/home/u', 'instance')).toBe(join('/home/u', '.metaide', 'claude-hooks', 'settings-instance.json'));
  });

  it('differs per instance so two app instances never share a file', () => {
    expect(hookSettingsPath('/home/u', 'a')).not.toBe(hookSettingsPath('/home/u', 'b'));
  });

  it('is outside ~/.claude, ~/.claude.json and any project .claude directory', () => {
    const home = '/home/u';
    const rel = relative(home, hookSettingsPath(home, 'instance'));
    const segments = rel.split(sep);
    expect(segments.some((s) => s.startsWith('.claude'))).toBe(false);
    expect(rel.startsWith('..')).toBe(false);
  });
});

describe('writeHookSettings / removeHookSettings', () => {
  const pathIn = (home: string) => hookSettingsPath(home, 'instance');

  it('writes the settings JSON with mode 0600, creating the directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'hooks-home-'));
    writeHookSettings(pathIn(home), 'linux');
    expect(JSON.parse(readFileSync(pathIn(home), 'utf8'))).toEqual(buildHookSettings('linux'));
    if (process.platform !== 'win32') expect(statSync(pathIn(home)).mode & 0o777).toBe(0o600);
  });

  it('contains neither the bearer token nor the receiver endpoint', () => {
    const home = mkdtempSync(join(tmpdir(), 'hooks-home-'));
    writeHookSettings(pathIn(home), 'linux');
    const content = readFileSync(pathIn(home), 'utf8');
    expect(content).not.toMatch(/Bearer|METAIDE_HOOK_TOKEN|METAIDE_HOOK_ENDPOINT/);
  });

  it('does not replace an existing instance file', () => {
    const home = mkdtempSync(join(tmpdir(), 'hooks-home-'));
    mkdirSync(join(home, '.metaide', 'claude-hooks'), { recursive: true });
    writeFileSync(pathIn(home), '{"stale":true}');
    expect(() => writeHookSettings(pathIn(home), 'linux')).toThrow(/EEXIST/);
    expect(readFileSync(pathIn(home), 'utf8')).toBe('{"stale":true}');
  });

  it('touches nothing under the home Claude config', () => {
    const home = mkdtempSync(join(tmpdir(), 'hooks-home-'));
    writeHookSettings(pathIn(home), 'linux');
    expect(() => statSync(join(home, '.claude'))).toThrow();
    expect(() => statSync(join(home, '.claude.json'))).toThrow();
  });

  it('removeHookSettings deletes the file and ignores one that is already gone', () => {
    const home = mkdtempSync(join(tmpdir(), 'hooks-home-'));
    writeHookSettings(pathIn(home), 'linux');
    removeHookSettings(pathIn(home));
    expect(existsSync(pathIn(home))).toBe(false);
    expect(() => removeHookSettings(pathIn(home))).not.toThrow();
  });
});
