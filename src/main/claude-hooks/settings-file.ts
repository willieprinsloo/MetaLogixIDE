/**
 * The app-owned Claude Code settings file passed via `--settings`. It
 * registers one `http` hook on `Notification` (all types), `Stop`,
 * `UserPromptSubmit`, the tool events, `PermissionRequest` and
 * `StopFailure`, pointing at the loopback receiver with header
 * templates Claude fills from the PTY env. It holds no secret and lives
 * under `~/.metaide/claude-hooks/`, never under a Claude config path (AC7).
 * The file is keyed by the receiver port so app instances sharing one HOME
 * (packaged + dev) never point each other's Claude shells at the wrong
 * receiver.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SHELL_ENV, SHELL_HEADER, TOKEN_ENV } from './protocol';

/** One Claude Code `http` hook entry. */
export interface HttpHook {
  type: 'http';
  url: string;
  timeout: number;
  headers: Record<string, string>;
  allowedEnvVars: string[];
}

/** One matcher group of a hook event. */
export interface HookGroup {
  matcher?: string;
  hooks: HttpHook[];
}

/** Name of a hook event the app registers. */
export type RegisteredHookEvent =
  | 'Notification' | 'Stop' | 'UserPromptSubmit'
  | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'PermissionRequest' | 'StopFailure';

/** The settings document written to disk. */
export interface HookSettings {
  hooks: Record<RegisteredHookEvent, HookGroup[]>;
}

const HOOK_TIMEOUT_SECONDS = 1;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** `<homeDir>/.metaide/claude-hooks/settings-<port>.json` for the receiver listening on `port`. */
export function hookSettingsPath(homeDir: string, port: number): string {
  return join(homeDir, '.metaide', 'claude-hooks', `settings-${port}.json`);
}

/** Builds the hook settings for a receiver at `url`. */
export function buildHookSettings(url: string): HookSettings {
  const hook: HttpHook = {
    type: 'http',
    url,
    timeout: HOOK_TIMEOUT_SECONDS,
    headers: { [SHELL_HEADER]: `$${SHELL_ENV}`, Authorization: `Bearer $${TOKEN_ENV}` },
    allowedEnvVars: [SHELL_ENV, TOKEN_ENV],
  };
  const all = (): HookGroup[] => [{ matcher: '', hooks: [hook] }];
  const unmatched = (): HookGroup[] => [{ hooks: [hook] }];
  return {
    hooks: {
      Notification: all(),
      Stop: unmatched(),
      UserPromptSubmit: unmatched(),
      PreToolUse: all(),
      PostToolUse: all(),
      PostToolUseFailure: all(),
      PermissionRequest: all(),
      StopFailure: all(),
    },
  };
}

/** Writes the settings for `url` to `path` with mode 0600, creating its directory; throws on I/O failure. */
export function writeHookSettings(path: string, url: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
  writeFileSync(path, JSON.stringify(buildHookSettings(url), null, 2), { mode: FILE_MODE });
  chmodSync(path, FILE_MODE);
}

/** Deletes the settings file at `path`; a missing file is not an error, other I/O failures throw. */
export function removeHookSettings(path: string): void {
  rmSync(path, { force: true });
}
