/**
 * Pure derivations over the renderer's Claude-state snapshot: worst-of
 * across shells, per-shell and per-project lookups, the two reducers
 * (`applySnapshot`, `applyDelta`) that turn `claude-state:list` responses
 * and `claude-state:changed` events into a `ReadonlyMap<string, ClaudeShellState>`
 * keyed by `keyFor(projectId, shellIndex)`, and the `*SnapshotGetter` factories
 * `useClaudeStates` wires into `useSyncExternalStore` so each selector compares
 * a primitive rather than the whole map. No IO lives here — `useClaudeStates`
 * owns fetching and subscribing.
 */
import type { ClaudeShellState, ClaudeShellStateEntry } from '@shared/claude-state';

const STATE_RANK: Readonly<Record<ClaudeShellState, number>> = { idle: 0, busy: 1, blocked: 2 };

/** Map key for one shell's entry, shared by the reducers and the lookup helpers. */
export function keyFor(projectId: number, shellIndex: number): string {
  return `${projectId}:${shellIndex}`;
}

/** Worst state among the given states; blocked > busy > idle, and an empty iterable is idle (spec "Worst state"). */
export function worstClaudeState(states: Iterable<ClaudeShellState>): ClaudeShellState {
  let worst: ClaudeShellState = 'idle';
  for (const s of states) {
    if (STATE_RANK[s] > STATE_RANK[worst]) worst = s;
  }
  return worst;
}

/** State of one shell; absent from the map (idle, or never tracked) reads as idle. */
export function shellStateOf(map: ReadonlyMap<string, ClaudeShellState>, projectId: number, shellIndex: number): ClaudeShellState {
  return map.get(keyFor(projectId, shellIndex)) ?? 'idle';
}

/** Worst state among a single project's shells (AC15). */
export function projectStateOf(map: ReadonlyMap<string, ClaudeShellState>, projectId: number): ClaudeShellState {
  const prefix = `${projectId}:`;
  const states: ClaudeShellState[] = [];
  for (const [key, state] of map) {
    if (key.startsWith(prefix)) states.push(state);
  }
  return worstClaudeState(states);
}

/** Worst state across every project's shells — the "In use" header dot (AC15, D4). */
export function overallStateOf(map: ReadonlyMap<string, ClaudeShellState>): ClaudeShellState {
  return worstClaudeState(map.values());
}

/**
 * Builds a `useSyncExternalStore` snapshot getter that derives a shell's
 * state on every call, rather than returning the backing map. Since the
 * result is a primitive `ClaudeShellState`, React's `Object.is` snapshot
 * comparison is a value comparison: a delta to an unrelated shell leaves
 * the returned string unchanged, so only the sites whose own state moved
 * re-render. `getMap` is injected so this stays pure and testable without
 * the store's IPC wiring.
 */
export function shellSnapshotGetter(
  getMap: () => ReadonlyMap<string, ClaudeShellState>,
  projectId: number,
  shellIndex: number,
): () => ClaudeShellState {
  return () => shellStateOf(getMap(), projectId, shellIndex);
}

/** Same as `shellSnapshotGetter`, for a project's worst state. */
export function projectSnapshotGetter(
  getMap: () => ReadonlyMap<string, ClaudeShellState>,
  projectId: number,
): () => ClaudeShellState {
  return () => projectStateOf(getMap(), projectId);
}

/** Same as `shellSnapshotGetter`, for the worst state across every project. */
export function overallSnapshotGetter(
  getMap: () => ReadonlyMap<string, ClaudeShellState>,
): () => ClaudeShellState {
  return () => overallStateOf(getMap());
}

/** Rebuilds the map from a `claude-state:list` snapshot. Idle entries (defensively, since the channel documents non-idle-only) are dropped rather than stored. */
export function applySnapshot(entries: readonly ClaudeShellStateEntry[]): ReadonlyMap<string, ClaudeShellState> {
  const map = new Map<string, ClaudeShellState>();
  for (const entry of entries) {
    if (entry.state === 'idle') continue;
    map.set(keyFor(entry.projectId, entry.shellIndex), entry.state);
  }
  return map;
}

/**
 * Applies one `claude-state:changed` delta. Idle deletes the entry; a state
 * equal to what's already stored returns the same map instance so
 * `useSyncExternalStore` selectors relying on referential equality skip a
 * re-render; any other change returns a new map.
 */
export function applyDelta(
  map: ReadonlyMap<string, ClaudeShellState>,
  entry: ClaudeShellStateEntry,
): ReadonlyMap<string, ClaudeShellState> {
  const key = keyFor(entry.projectId, entry.shellIndex);
  const current = map.get(key);
  if (entry.state === 'idle') {
    if (current === undefined) return map;
    const next = new Map(map);
    next.delete(key);
    return next;
  }
  if (current === entry.state) return map;
  const next = new Map(map);
  next.set(key, entry.state);
  return next;
}
