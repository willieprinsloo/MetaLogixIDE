/**
 * Per-key toast throttle. `shouldShow(key)` is true the first time a key is seen and again once
 * `windowMs` has passed since it last returned true; suppressed calls do not extend the window.
 * `now` is injectable for tests.
 */
export interface ToastThrottle {
  shouldShow(key: string): boolean;
}

export function createToastThrottle(opts: { windowMs: number; now?: () => number }): ToastThrottle {
  const now = opts.now ?? Date.now;
  const last = new Map<string, number>();
  return {
    shouldShow(key) {
      const t = now();
      const prev = last.get(key);
      if (prev !== undefined && t - prev < opts.windowMs) return false;
      last.set(key, t);
      return true;
    },
  };
}
