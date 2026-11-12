/**
 * Minimal in-test React hook runtime for node-environment vitest (no DOM renderer is installed).
 * `hookRuntime` is created inside `vi.hoisted` and mapped onto a `vi.mock('react')` so a hook under
 * test runs with React's dependency semantics: `render` runs the hook then flushes due effects.
 */
export function createHookRuntime() {
  type Effect = { deps?: unknown[]; cleanup?: () => void; run?: () => unknown };
  const slots: unknown[] = [];
  const effects: Effect[] = [];
  let cursor = 0;
  let effectCursor = 0;
  const changed = (a: unknown[] | undefined, b: unknown[] | undefined) =>
    !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  return {
    reset() { slots.length = 0; effects.length = 0; },
    render<T>(fn: () => T): T {
      cursor = 0;
      effectCursor = 0;
      const out = fn();
      const due = effects.filter((e) => e.run);
      for (const e of due) e.cleanup?.();
      for (const e of due) {
        const c = e.run?.();
        e.run = undefined;
        e.cleanup = typeof c === 'function' ? (c as () => void) : undefined;
      }
      return out;
    },
    unmount() { for (const e of effects) { e.cleanup?.(); e.cleanup = undefined; } },
    useState<S>(init: S) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = init;
      const set = (v: S | ((p: S) => S)) => { slots[i] = typeof v === 'function' ? (v as (p: S) => S)(slots[i] as S) : v; };
      return [slots[i] as S, set] as const;
    },
    useRef<R>(init: R) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: init };
      return slots[i] as { current: R };
    },
    useCallback<F>(fn: F, deps: unknown[]) {
      const i = cursor++;
      const prev = slots[i] as { fn: F; deps: unknown[] } | undefined;
      if (prev && !changed(prev.deps, deps)) return prev.fn;
      slots[i] = { fn, deps };
      return fn;
    },
    useEffect(run: () => unknown, deps?: unknown[]) {
      const i = effectCursor++;
      const prev = effects[i];
      if (prev && !changed(prev.deps, deps)) return;
      effects[i] = { deps, cleanup: prev?.cleanup, run };
    },
  };
}
