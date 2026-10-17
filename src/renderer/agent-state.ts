/** Pure renderer selectors and reducers for current per-shell agent status and generic severity rollups. */
import type { AgentKind, AgentShellStateEntry, AgentState } from '@shared/agent-state';

export interface ShellAgentState {
  readonly agent: AgentKind | null;
  readonly state: AgentState;
}

export type AgentStateMap = ReadonlyMap<string, ShellAgentState>;

const IDLE_SHELL: ShellAgentState = { agent: null, state: 'idle' };
const STATE_RANK: Readonly<Record<AgentState, number>> = { idle: 0, busy: 1, blocked: 2 };

/** Distinguishes a shell from another shell and a project from a numeric-prefix neighbor. */
export function keyFor(projectId: number, shellIndex: number): string {
  return `${projectId}:${shellIndex}`;
}

/** Returns a shared fallback for a non-agent or absent shell, preserving selector identity. */
export function shellStateOf(
  map: AgentStateMap,
  projectId: number,
  shellIndex: number,
): ShellAgentState {
  return map.get(keyFor(projectId, shellIndex)) ?? IDLE_SHELL;
}

/** Computes the highest severity among a project's live agent shells. */
export function projectStateOf(map: AgentStateMap, projectId: number): AgentState {
  const prefix = `${projectId}:`;
  let worst: AgentState = 'idle';
  for (const [key, shell] of map) {
    if (key.startsWith(prefix) && STATE_RANK[shell.state] > STATE_RANK[worst]) worst = shell.state;
  }
  return worst;
}

/** Computes highest severity across all live agent shells, independent of identity. */
export function overallStateOf(map: AgentStateMap): AgentState {
  let worst: AgentState = 'idle';
  for (const shell of map.values()) {
    if (STATE_RANK[shell.state] > STATE_RANK[worst]) worst = shell.state;
  }
  return worst;
}

/** Derives one shell's stable snapshot from an injected current-map getter. */
export function shellSnapshotGetter(
  getMap: () => AgentStateMap,
  projectId: number,
  shellIndex: number,
): () => ShellAgentState {
  return () => shellStateOf(getMap(), projectId, shellIndex);
}

/** Derives a primitive project severity so unrelated shell updates cannot rerender it. */
export function projectSnapshotGetter(
  getMap: () => AgentStateMap,
  projectId: number,
): () => AgentState {
  return () => projectStateOf(getMap(), projectId);
}

/** Derives a primitive global severity for the In use heading. */
export function overallSnapshotGetter(getMap: () => AgentStateMap): () => AgentState {
  return () => overallStateOf(getMap());
}

/** Replaces stale shell data on refresh, reusing unchanged values from the previous snapshot. */
export function applySnapshot(
  entries: readonly AgentShellStateEntry[],
  previous: AgentStateMap = new Map(),
): AgentStateMap {
  const next = new Map<string, ShellAgentState>();
  for (const entry of entries) {
    if (entry.agent === null) continue;
    const key = keyFor(entry.projectId, entry.shellIndex);
    const current = previous.get(key);
    next.set(
      key,
      current?.agent === entry.agent && current.state === entry.state
        ? current
        : { agent: entry.agent, state: entry.state },
    );
  }
  return next;
}

/** Applies an authenticated per-shell change; an exited/non-agent shell removes its old entry. */
export function applyDelta(map: AgentStateMap, entry: AgentShellStateEntry): AgentStateMap {
  const key = keyFor(entry.projectId, entry.shellIndex);
  const current = map.get(key);
  if (entry.agent === null && current === undefined) return map;
  if (entry.agent === current?.agent && entry.state === current.state) return map;
  const next = new Map(map);
  if (entry.agent === null) next.delete(key);
  else next.set(key, { agent: entry.agent, state: entry.state });
  return next;
}
