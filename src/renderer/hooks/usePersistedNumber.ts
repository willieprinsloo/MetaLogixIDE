import { useCallback, useEffect, useState } from 'react';

/**
 * Small helper: persisted numeric state backed by localStorage, clamped
 * to [min, max]. Used for pane widths, keep-alive caps, and similar UI
 * settings that must survive reloads without a full round-trip through
 * the main-process settings store.
 */
export function usePersistedNumber(
  key: string,
  initial: number,
  min: number,
  max: number,
): [number, (v: number) => void] {
  const [value, setValueState] = useState<number>(() => {
    const raw = localStorage.getItem(key);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : initial;
  });

  const setValue = useCallback((v: number) => {
    const clamped = Math.min(max, Math.max(min, v));
    setValueState(clamped);
  }, [min, max]);

  useEffect(() => {
    localStorage.setItem(key, String(value));
  }, [key, value]);

  return [value, setValue];
}
