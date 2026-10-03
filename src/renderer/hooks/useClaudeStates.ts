/**
 * Module-singleton external store for the per-shell Claude state
 * (`claude-state.ts`'s reducers over `ReadonlyMap<string, ClaudeShellState>`).
 * The first subscriber fetches the `claude-state:list` snapshot, subscribes
 * to the `claude-state:changed` delta event, and refetches on
 * `alive-shells:changed` (a respawned shell isn't delta-pushed — see plan
 * §4.3). A fetch failure is logged with its cause and the store keeps its
 * last state rather than throwing into a render. The exported selector
 * hooks (`useShellClaudeState`, `useProjectClaudeState`,
 * `useOverallClaudeState`) pass `useSyncExternalStore` one of
 * `claude-state.ts`'s `*SnapshotGetter` factories rather than the raw map,
 * so React's `Object.is` snapshot check compares the derived primitive
 * `ClaudeShellState` and a site only re-renders when its own derived value
 * actually changes.
 */
import { useSyncExternalStore } from 'react';
import { api } from '@renderer/api';
import {
  applyDelta,
  applySnapshot,
  overallSnapshotGetter,
  projectSnapshotGetter,
  shellSnapshotGetter,
} from '@renderer/claude-state';
import type { ClaudeShellState } from '@shared/claude-state';

let map: ReadonlyMap<string, ClaudeShellState> = new Map();
const listeners = new Set<() => void>();
let unsubscribeIpc: (() => void) | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

async function fetchSnapshot(): Promise<void> {
  try {
    const { shells } = await api.invoke('claude-state:list', undefined as never);
    map = applySnapshot(shells);
    notify();
  } catch (e) {
    console.error('claude-state: failed to fetch snapshot, keeping last known state', e);
  }
}

function start(): void {
  const offChanged = api.on('claude-state:changed', (entry) => {
    map = applyDelta(map, entry);
    notify();
  });
  const offAlive = api.on('alive-shells:changed', () => { void fetchSnapshot(); });
  unsubscribeIpc = () => { offChanged(); offAlive(); };
  void fetchSnapshot();
}

function stop(): void {
  unsubscribeIpc?.();
  unsubscribeIpc = null;
  map = new Map();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

function getMap(): ReadonlyMap<string, ClaudeShellState> {
  return map;
}

/** Claude state of one shell (per-shell dot sites). */
export function useShellClaudeState(projectId: number, shellIndex: number): ClaudeShellState {
  return useSyncExternalStore(subscribe, shellSnapshotGetter(getMap, projectId, shellIndex));
}

/** Worst state among a single project's live shells (project-level dot sites). */
export function useProjectClaudeState(projectId: number): ClaudeShellState {
  return useSyncExternalStore(subscribe, projectSnapshotGetter(getMap, projectId));
}

/** Worst state across every project's live shells (the "In use" header dot, D4). */
export function useOverallClaudeState(): ClaudeShellState {
  return useSyncExternalStore(subscribe, overallSnapshotGetter(getMap));
}
