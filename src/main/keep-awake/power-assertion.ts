/**
 * Adapter over Electron's `powerSaveBlocker` that holds at most one
 * `prevent-app-suspension` assertion. `prevent-display-sleep` is never used,
 * because it would outrank and defeat the screen darkening.
 */

/** The slice of Electron's `powerSaveBlocker` this adapter uses. */
export interface PowerSaveBlockerLike {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): void;
}

/** A single, idempotent system-sleep assertion. */
export interface PowerAssertion {
  /** Acquires the assertion; a no-op while already held. */
  hold(): void;
  /** Releases the assertion; a no-op when not held. */
  release(): void;
}

/** Builds a `PowerAssertion` over `blocker`. */
export function createPowerAssertion(blocker: PowerSaveBlockerLike): PowerAssertion {
  let id: number | null = null;
  return {
    hold() {
      if (id === null) id = blocker.start('prevent-app-suspension');
    },
    release() {
      if (id === null) return;
      const held = id;
      id = null;
      blocker.stop(held);
    },
  };
}
