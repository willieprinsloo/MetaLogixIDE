/** Subscribed agent-state snapshot/delta store with per-shell identity and severity-only aggregate selectors. */
import { useSyncExternalStore } from 'react';
import { api } from '@renderer/api';
import {
  applyDelta,
  applySnapshot,
  overallSnapshotGetter,
  projectSnapshotGetter,
  shellSnapshotGetter,
  type AgentStateMap,
  type ShellAgentState,
} from '@renderer/agent-state';
import type { AgentShellStateEntry, AgentState } from '@shared/agent-state';

let map: AgentStateMap = new Map();
const listeners = new Set<() => void>();
let unsubscribeIpc: (() => void) | null = null;
let requestId = 0;
let pending: AgentShellStateEntry[] | null = null;

function publish(next: AgentStateMap): void {
  if (next === map) return;
  map = next;
  for (const listener of listeners) listener();
}

async function fetchSnapshot(): Promise<void> {
  const id = ++requestId;
  pending = [];
  try {
    const { shells } = await api.invoke('agent-state:list', undefined);
    if (id !== requestId) return;
    let next = applySnapshot(shells, map);
    for (const update of pending ?? []) next = applyDelta(next, update);
    pending = null;
    publish(next);
  } catch (error) {
    if (id !== requestId) return;
    pending = null;
    console.error('agent-state: failed to fetch snapshot, keeping last known state', error);
  }
}

function start(): void {
  const offChanged = api.on('agent-state:changed', (entry) => {
    pending?.push(entry);
    publish(applyDelta(map, entry));
  });
  const offAlive = api.on('alive-shells:changed', () => {
    void fetchSnapshot();
  });
  unsubscribeIpc = () => {
    offChanged();
    offAlive();
  };
  void fetchSnapshot();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size !== 0) return;
    requestId++;
    unsubscribeIpc?.();
    unsubscribeIpc = null;
    pending = null;
    map = new Map();
  };
}

function getMap(): AgentStateMap {
  return map;
}

/** Returns one shell's current identity and state, including idle agents and unrecognized shells. */
export function useShellAgentState(projectId: number, shellIndex: number): ShellAgentState {
  return useSyncExternalStore(subscribe, shellSnapshotGetter(getMap, projectId, shellIndex));
}

/** Returns generic worst severity among one project's live shells. */
export function useProjectAgentState(projectId: number): AgentState {
  return useSyncExternalStore(subscribe, projectSnapshotGetter(getMap, projectId));
}

/** Returns generic worst severity across all live projects for the In use indicator. */
export function useOverallAgentState(): AgentState {
  return useSyncExternalStore(subscribe, overallSnapshotGetter(getMap));
}
