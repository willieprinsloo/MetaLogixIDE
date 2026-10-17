import { useSyncExternalStore } from 'react';

/** The media query this hook follows. */
export const REDUCE_TRANSPARENCY_QUERY = '(prefers-reduced-transparency: reduce)';

interface ChangeList {
  matches: boolean;
  addEventListener: (type: 'change', cb: () => void) => void;
  removeEventListener: (type: 'change', cb: () => void) => void;
}

/** The `subscribe` / `getSnapshot` pair for `useSyncExternalStore`, over an injectable `matchMedia`. */
export function reducedTransparencyStore(matchMedia: (query: string) => ChangeList) {
  return {
    subscribe: (onChange: () => void) => {
      const list = matchMedia(REDUCE_TRANSPARENCY_QUERY);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    getSnapshot: () => matchMedia(REDUCE_TRANSPARENCY_QUERY).matches,
  };
}

const windowStore = typeof window === 'undefined' ? null : reducedTransparencyStore((q) => window.matchMedia(q));
const never = () => () => undefined;

/**
 * Live `prefers-reduced-transparency: reduce` (D12, AC24), for the Frosted glass group's notice
 * line. Server rendering reports false.
 */
export function usePrefersReducedTransparency(): boolean {
  return useSyncExternalStore(windowStore?.subscribe ?? never, windowStore?.getSnapshot ?? (() => false), () => false);
}
