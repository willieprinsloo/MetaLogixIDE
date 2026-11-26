/**
 * Wire names for the local command forwarder, its launch environment and the receiver.
 */

/** Path the hooks POST to. */
export const HOOK_PATH = '/claude-hook';

/** Header carrying the per-spawn session id. */
export const SHELL_HEADER = 'X-Metaide-Shell';

/** PTY env var holding the per-spawn session id (not secret). */
export const SHELL_ENV = 'METAIDE_HOOK_SHELL';

/** PTY env var holding the per-spawn secret token. */
export const TOKEN_ENV = 'METAIDE_HOOK_TOKEN';

/** Forwarder paths and the private endpoint belonging to the originating IDE instance. */
export const FORWARDER_ENV = 'METAIDE_HOOK_FORWARDER';
export const EXECUTABLE_ENV = 'METAIDE_HOOK_EXE';
export const ENDPOINT_ENV = 'METAIDE_HOOK_ENDPOINT';
