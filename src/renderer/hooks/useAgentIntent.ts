/**
 * Live "what each agent is doing" state for one project. Reads
 * `intent:list` once on mount, then merges `intent:changed` events
 * into a Map keyed by `agent#shell`. The renderer renders the latest
 * text plus a staleness class derived from `update.ts`.
 *
 * Idle timers are rolled by the consumer — this hook just surfaces the
 * last-known update per shell. A `now` state ticks every 15s so a
 * subscribing component re-renders in time to flip to "idle" without
 * extra bookkeeping at every usage site.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '@renderer/api';
import { INTENT_DIM_MS, INTENT_IDLE_MS, type IntentUpdate } from '@shared/intent';

export type IntentKind = 'fresh' | 'dim' | 'idle';

export interface IntentView {
  update: IntentUpdate;
  kind: IntentKind;
  /** Convenience: what to show. For `idle`, it's the literal word "idle". */
  display: string;
}

function keyOf(u: { agent: string; shell: number }): string { return `${u.agent}#${u.shell}`; }

function kindOf(now: number, ts: string): IntentKind {
  const age = now - new Date(ts).getTime();
  if (age >= INTENT_IDLE_MS) return 'idle';
  if (age >= INTENT_DIM_MS) return 'dim';
  return 'fresh';
}

export function useAgentIntent(projectId: number): Map<string, IntentView> {
  const multi = useAgentIntents(useMemo(() => [projectId], [projectId]));
  // Strip the `<projectId>:` prefix the multi-project hook keys with —
  // single-project callers only have one and shouldn't have to assemble
  // the composite key themselves.
  return useMemo(() => {
    const out = new Map<string, IntentView>();
    const prefix = `${projectId}:`;
    for (const [k, v] of multi) {
      if (k.startsWith(prefix)) out.set(k.slice(prefix.length), v);
    }
    return out;
  }, [multi, projectId]);
}

/**
 * Multi-project variant used by FleetView, where one widget shows
 * shells from several projects at once. Returns a flat map keyed
 * `"<projectId>:<agent>#<shell>"` so a row at any depth can look up
 * its intent in constant time.
 *
 * `projectIds` must be referentially stable across renders (wrap in
 * `useMemo` upstream) — the hook's effect is keyed on it and a new
 * array per render would re-subscribe endlessly.
 */
export function useAgentIntents(projectIds: readonly number[]): Map<string, IntentView> {
  const [state, setState] = useState<Map<string, IntentUpdate>>(new Map());
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const merged = new Map<string, IntentUpdate>();
      for (const projectId of projectIds) {
        try {
          const { updates } = await api.invoke('intent:list', { projectId });
          if (cancelled) return;
          for (const u of updates) merged.set(`${projectId}:${keyOf(u)}`, u);
        } catch { /* best-effort per project */ }
      }
      if (!cancelled) setState(merged);
    })();
    const idset = new Set(projectIds);
    const off = api.on('intent:changed', (ev) => {
      if (!idset.has(ev.projectId)) return;
      setState((prev) => {
        const next = new Map(prev);
        next.set(`${ev.projectId}:${keyOf(ev.update)}`, ev.update);
        return next;
      });
    });
    return () => { cancelled = true; off(); };
  }, [projectIds]);

  // Re-render every 15s so a `fresh` → `dim` → `idle` transition lands
  // without every consumer wiring its own timer. 15s is well under the
  // 30s dim threshold, so a shell reaches `dim` within one tick of
  // crossing it and `idle` within one tick of crossing 2 min.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  return useMemo(() => {
    const out = new Map<string, IntentView>();
    for (const [k, u] of state) {
      const kind = kindOf(now, u.ts);
      out.set(k, { update: u, kind, display: kind === 'idle' ? 'idle' : u.text });
    }
    return out;
  }, [state, now]);
}
