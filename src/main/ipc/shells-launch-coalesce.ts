/**
 * Coalesces concurrent `shells:launch` calls for the same shell slot. The
 * handler's `isAlive(projectId, shellIndex)` check is synchronous, but the
 * `spawn` it then awaits isn't — a second IPC arriving in that gap used to
 * fall through to `ptyManager.spawn` and trip "already spawned: N:0" from
 * the manager's single-entry guard. Logs showed this throwing 411 times
 * last week.
 *
 * `coalesce` keys by (projectId, shellIndex) and returns the single
 * in-flight promise to every caller until it settles; the slot clears on
 * settle so the next launch is fresh.
 */
export type LaunchKey = `${number}:${number}`;

export function launchKey(projectId: number, shellIndex: number): LaunchKey {
  return `${projectId}:${shellIndex}`;
}

export class LaunchCoalescer<T> {
  private inFlight = new Map<LaunchKey, Promise<T>>();

  async run(key: LaunchKey, task: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = task().finally(() => {
      // Always clear, even on reject — the next caller gets a clean slot
      // so a failed launch does not wedge the shell.
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  /** For tests/assertions: is a launch currently in flight for this key? */
  has(key: LaunchKey): boolean {
    return this.inFlight.has(key);
  }
}
