/**
 * Per-row reveal timers for masked env values: each revealed key masks itself
 * again after `timeoutMs`, independently of every other key.
 */

/** How long a revealed value stays visible (D1). */
export const REVEAL_TIMEOUT_MS = 39_000;

/** Callers namespace keys: `row:<EnvRow.key>` for editable rows, `app:<name>` for inherited rows. */
export type RevealKey = string;

/** The reveal key for an editable row. */
export function rowRevealKey(key: number): RevealKey {
  return `row:${key}`;
}

export interface RevealTimers {
  toggle(key: RevealKey): void;
  isRevealed(key: RevealKey): boolean;
  hide(key: RevealKey): void;
  clearAll(): void;
}

export interface RevealTimersOptions {
  timeoutMs?: number;
  onChange: () => void;
}

/**
 * Reveal timers for one editor. `toggle` reveals a masked key for `timeoutMs`
 * (default `REVEAL_TIMEOUT_MS`) or masks a revealed one; `hide` masks a key
 * whose row is gone; `clearAll` masks everything. Each change, including a
 * timer firing, calls `onChange`; a `hide` that masks nothing does not.
 */
export function createRevealTimers(opts: RevealTimersOptions): RevealTimers {
  const timeoutMs = opts.timeoutMs ?? REVEAL_TIMEOUT_MS;
  const timers = new Map<RevealKey, ReturnType<typeof setTimeout>>();

  function cancel(key: RevealKey): boolean {
    const timer = timers.get(key);
    if (timer === undefined) return false;
    clearTimeout(timer);
    timers.delete(key);
    return true;
  }

  return {
    toggle(key: RevealKey) {
      if (!cancel(key)) {
        timers.set(
          key,
          setTimeout(() => {
            timers.delete(key);
            opts.onChange();
          }, timeoutMs),
        );
      }
      opts.onChange();
    },
    isRevealed(key: RevealKey) {
      return timers.has(key);
    },
    hide(key: RevealKey) {
      if (cancel(key)) opts.onChange();
    },
    clearAll() {
      for (const key of [...timers.keys()]) cancel(key);
    },
  };
}
