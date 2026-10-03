/**
 * Wire names shared by the generated hook settings file and the receiver:
 * the POST path, the shell-id header and the env vars Claude interpolates
 * into the headers.
 */

/** Path the hooks POST to. */
export const HOOK_PATH = '/claude-hook';

/** Header carrying the per-spawn session id. */
export const SHELL_HEADER = 'X-Metaide-Shell';

/** PTY env var holding the per-spawn session id (not secret). */
export const SHELL_ENV = 'METAIDE_HOOK_SHELL';

/** PTY env var holding the per-spawn secret token. */
export const TOKEN_ENV = 'METAIDE_HOOK_TOKEN';
