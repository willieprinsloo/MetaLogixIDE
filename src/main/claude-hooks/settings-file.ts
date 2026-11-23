/** Writes only Claude notification and turn-confirmation hooks; status dots never consume hooks. */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EXECUTABLE_ENV, FORWARDER_ENV } from './protocol';

/** One observational Claude Code command hook. */
export interface CommandHook {
  type: 'command';
  command: string;
  async: true;
  timeout: number;
  shell?: 'powershell';
}

/** One matcher group of a hook event. */
export interface HookGroup {
  matcher?: string;
  hooks: CommandHook[];
}

/** Name of a hook event the app registers. */
export type RegisteredHookEvent = 'Notification' | 'Stop' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse';

/** The settings document written to disk. */
export interface HookSettings {
  hooks: Record<RegisteredHookEvent, HookGroup[]>;
}

const HOOK_TIMEOUT_SECONDS = 1;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Private settings file owned by one IDE instance. */
export function hookSettingsPath(homeDir: string, instanceId: string): string {
  return join(homeDir, '.metaide', 'claude-hooks', `settings-${instanceId}.json`);
}

/** Uses a shell only to set Electron's child-only Node mode and suppress missing-executable errors. */
export function buildHookSettings(platform: NodeJS.Platform): HookSettings {
  const windows = platform === 'win32';
  const hook: CommandHook = {
    type: 'command',
    command: windows
      ? `$env:ELECTRON_RUN_AS_NODE='1'; & $env:${EXECUTABLE_ENV} $env:${FORWARDER_ENV} *> $null; exit 0`
      : `ELECTRON_RUN_AS_NODE=1 "$${EXECUTABLE_ENV}" "$${FORWARDER_ENV}" >/dev/null 2>&1 || :`,
    ...(windows ? { shell: 'powershell' } : {}),
    async: true,
    timeout: HOOK_TIMEOUT_SECONDS,
  };
  const all = (): HookGroup[] => [{ matcher: '', hooks: [hook] }];
  const unmatched = (): HookGroup[] => [{ hooks: [hook] }];
  return {
    hooks: {
      Notification: all(),
      Stop: unmatched(),
      UserPromptSubmit: unmatched(),
      // Mirror every tool call into the activity log — this is the signal
      // that lets a second shell see what the first agent is actually doing.
      PreToolUse: all(),
      PostToolUse: all(),
    },
  };
}

/** Writes a new instance settings file without following an existing entry. */
export function writeHookSettings(path: string, platform: NodeJS.Platform): void {
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
  writeFileSync(path, JSON.stringify(buildHookSettings(platform), null, 2), { mode: FILE_MODE, flag: 'wx' });
  chmodSync(path, FILE_MODE);
}

/** Deletes the settings file at `path`; a missing file is not an error, other I/O failures throw. */
export function removeHookSettings(path: string): void {
  rmSync(path, { force: true });
}
