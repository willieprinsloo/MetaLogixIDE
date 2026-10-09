import { useEffect, useMemo, useState } from 'react';
import { createRevealTimers, type RevealKey } from '@renderer/env-reveal';

export interface RevealState {
  isRevealed(key: RevealKey): boolean;
  toggle(key: RevealKey): void;
  /** Masks one value and cancels its timer, e.g. when its row is removed. */
  hide(key: RevealKey): void;
  /** Masks every value and cancels every timer, e.g. after a save re-keys the rows. */
  clearAll(): void;
}

/** Per-row reveal state for one mounted editor; every value masks again on unmount (AC25). */
export function useRevealState(): RevealState {
  const [, bump] = useState(0);
  const timers = useMemo(() => createRevealTimers({ onChange: () => bump((n) => n + 1) }), []);

  useEffect(() => () => timers.clearAll(), [timers]);

  return useMemo(
    () => ({
      isRevealed: (key: RevealKey) => timers.isRevealed(key),
      toggle: (key: RevealKey) => {
        timers.toggle(key);
      },
      hide: (key: RevealKey) => {
        timers.hide(key);
      },
      clearAll: () => {
        timers.clearAll();
        bump((n) => n + 1);
      },
    }),
    [timers],
  );
}
