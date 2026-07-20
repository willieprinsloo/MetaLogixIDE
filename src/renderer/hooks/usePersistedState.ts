import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Generic localStorage-backed state. Reads on mount, writes on change.
 * Corrupt / missing values fall back to `initial` without throwing so the
 * app boots even if a user tinkers with DevTools > Application > Storage.
 *
 * Type-parameter `T` is only checked structurally by the validate() hook
 * you can pass — nothing here enforces runtime shape beyond parseability.
 */
export function usePersistedState<T>(
  key: string,
  initial: T,
  validate?: (v: unknown) => v is T,
): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValueState] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return initial;
      const parsed = JSON.parse(raw) as unknown;
      if (validate && !validate(parsed)) return initial;
      return parsed as T;
    } catch { return initial; }
  });

  // Keep a ref of the latest value so the setter closure never captures a
  // stale one (matters when consumers pass a function updater rapidly).
  const ref = useRef(value);
  ref.current = value;

  const setValue = useCallback((v: T | ((prev: T) => T)) => {
    setValueState((prev) => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
      ref.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch { /* quota exceeded / private mode → drop silently */ }
  }, [key, value]);

  return [value, setValue];
}
