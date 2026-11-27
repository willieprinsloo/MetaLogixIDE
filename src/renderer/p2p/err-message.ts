/**
 * Human-readable text for a rejection: the message of an `Error` (or `String(err)`), with
 * Electron's `Error invoking remote method '<channel>': ` wrapper and a leading `Error:` or
 * `RpcError:` label removed so toasts show only the cause.
 */
export function errMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(?:[A-Za-z]*Error):\s*/, '');
}

const OLDER_HOST_PREFIXES = ['unknown method:', 'unknown_method:'] as const;

/**
 * True when a failed RPC means the host's build does not know the method: the host answers
 * `unknown method: <m>` and the viewer's own guard throws `unknown_method: <m>`. Only a message
 * that starts with one of these counts; each call is judged on its own.
 */
export function isOlderHostError(err: unknown): boolean {
  const message = errMessage(err);
  return OLDER_HOST_PREFIXES.some((prefix) => message.startsWith(prefix));
}
