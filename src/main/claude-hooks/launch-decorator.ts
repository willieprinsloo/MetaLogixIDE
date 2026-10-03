/**
 * Spawn-time injection of the app's hook settings into Claude launches.
 * A Claude argv gets `--settings <path>` after argv[0] and a fresh per-spawn
 * session id + token in its env (token never in argv). Anything else —
 * non-Claude argv, a user-supplied `--settings`, or hooks not available —
 * is returned as the same object, untouched (AC5, AC6, AC22, AC27). Every
 * spawn supersedes the shell's previous hook session: an injected spawn
 * replaces it via `issue`, any other spawn releases it, so a stale session
 * never outlives the process that owned it. On Windows, a Claude that
 * spawns through `cmd.exe /c` (an npm `claude.cmd` shim) is also left
 * untouched when the settings path contains whitespace: node-pty quotes that
 * token and `cmd /c` strips the outer quotes, which would stop Claude from
 * starting at all. That shell keeps the generic notifier (AC22, D7). A
 * native `claude.exe` is not wrapped in cmd and stays decorated.
 */
import type { ResolvedLaunch } from '@main/domain/launch';
import { isClaudeArgv } from '@main/domain/claude-permission-mode';
import type { SpawnDecorator } from '@main/pty/manager';
import { toSpawnableArgv } from '@main/domain/shell';
import { SHELL_ENV, TOKEN_ENV } from './protocol';
import type { HookSession, ShellKey } from './session-registry';

/**
 * Collaborators: the session registry, the current settings-file path (null
 * while hooks are unavailable), and — defaulting to the running process —
 * the platform and whether an argv spawns through `cmd.exe /c`.
 */
export interface LaunchDecoratorDeps {
  sessions: { issue(shell: ShellKey): HookSession; release(shell: ShellKey): void };
  settingsPath: () => string | null;
  platform?: NodeJS.Platform;
  goesThroughCmd?: (argv: string[]) => boolean;
}

/** True when `toSpawnableArgv` wraps argv in `cmd.exe /c` (Windows `.cmd`/`.bat` shims). */
export function goesThroughCmdShim(argv: string[]): boolean {
  const spawnable = toSpawnableArgv(argv);
  return spawnable.length === argv.length + 2 && spawnable[1] === '/c';
}

function hasSettingsFlag(argv: readonly string[]): boolean {
  return argv.slice(1).some((arg) => arg === '--settings' || arg.startsWith('--settings='));
}

/** Builds the `PtyManager` spawn decorator; see the module docblock for the rule. */
export function createLaunchDecorator(deps: LaunchDecoratorDeps): SpawnDecorator {
  const platform = deps.platform ?? process.platform;
  const goesThroughCmd = deps.goesThroughCmd ?? goesThroughCmdShim;
  const cmdWouldMisparse = (argv: string[], path: string): boolean =>
    platform === 'win32' && /\s/.test(path) && goesThroughCmd(argv);
  const injectablePath = (argv: string[]): string | null => {
    if (!isClaudeArgv(argv) || hasSettingsFlag(argv)) return null;
    const path = deps.settingsPath();
    return path !== null && !cmdWouldMisparse(argv, path) ? path : null;
  };
  return (projectId: number, shellIndex: number, launch: ResolvedLaunch): ResolvedLaunch => {
    const shell = { projectId, shellIndex };
    const settingsPath = injectablePath(launch.argv);
    if (settingsPath === null) {
      deps.sessions.release(shell);
      return launch;
    }
    const session = deps.sessions.issue(shell);
    const [bin, ...rest] = launch.argv;
    return {
      ...launch,
      argv: [bin!, '--settings', settingsPath, ...rest],
      env: { ...launch.env, [SHELL_ENV]: session.id, [TOKEN_ENV]: session.token },
    };
  };
}
