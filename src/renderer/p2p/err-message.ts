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
