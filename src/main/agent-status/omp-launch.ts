/** Loads the app-owned OMP extension without modifying user configuration or other extensions. */
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { toSpawnableArgv } from '@main/domain/shell';
import type { SpawnDecorator } from '@main/pty/manager';
import type { ShellKey } from '@main/claude-hooks/session-registry';

export const OMP_PORT_ENV = 'METAIDE_OMP_STATUS_PORT';
export const OMP_SPAWN_ENV = 'METAIDE_OMP_STATUS_SPAWN';
export const OMP_TOKEN_ENV = 'METAIDE_OMP_STATUS_TOKEN';

/** Accepts only a direct OMP executable, before Windows cmd.exe wrapping. */
export function isOmpArgv(argv: readonly string[]): boolean {
  const executable = argv[0]?.split(/[/\\]/).pop()?.toLowerCase();
  return (
    executable === 'omp' ||
    executable === 'omp.exe' ||
    executable === 'omp.cmd' ||
    executable === 'omp.bat'
  );
}

/** Dependencies resolved once at startup; absent port/path leaves original OMP invocation runnable. */
export interface OmpLaunchDeps {
  readonly receiver: {
    issue(shell: ShellKey): { spawn: string; token: string };
    release(shell: ShellKey): void;
  };
  readonly extensionPath: string | null;
  readonly port: () => number | null;
  readonly fileExists?: (path: string) => boolean;
  readonly platform?: NodeJS.Platform;
  readonly goesThroughCmd?: (argv: string[]) => boolean;
}

/** Adds an explicit extension to supported direct OMP launches; never overrides trusted-extension mode. */
export function createOmpLaunchDecorator(deps: OmpLaunchDeps): SpawnDecorator {
  return (projectId, shellIndex, launch) => {
    const shell = { projectId, shellIndex };
    deps.receiver.release(shell);
    const port = deps.port();
    if (
      !isOmpArgv(launch.argv) ||
      !deps.extensionPath ||
      !(deps.fileExists ?? existsSync)(deps.extensionPath) ||
      !port ||
      launch.argv.includes('--trusted-extension')
    )
      return launch;
    const cmdShim = (
      deps.goesThroughCmd ?? ((argv: string[]) => toSpawnableArgv(argv)[1] === '/c')
    )(launch.argv);
    const extension =
      (deps.platform ?? process.platform) === 'win32' && cmdShim
        ? pathToFileURL(deps.extensionPath).href
        : deps.extensionPath;
    // The app owns this root PTY. Do not inherit a parent OMP's nested-session flag.
    const { spawn, token } = deps.receiver.issue(shell);
    const [executable, ...args] = launch.argv;
    return {
      ...launch,
      argv: [executable ?? 'omp', '-e', extension, ...args],
      env: {
        ...launch.env,
        OMPCODE: '',
        [OMP_PORT_ENV]: String(port),
        [OMP_SPAWN_ENV]: spawn,
        [OMP_TOKEN_ENV]: token,
      },
    };
  };
}
