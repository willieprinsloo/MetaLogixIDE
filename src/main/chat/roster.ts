/**
 * Roster builder. Feeds the composer's `@`-autocomplete and the pane's
 * sidebar list — which agents are on which device right now, with what
 * agent state, and what mention string the composer should insert.
 *
 * The inputs are the facts the main process already has:
 *   - `local`  = `PtyManager.liveShells()` → `AliveShellSummary[]`
 *   - `remote` = cached `shells.alive` responses from each paired peer
 *   - `agentLabels` + `agentStates` come from the local agent-status tracker
 *   - `selfDevice` is `services.p2p?.api.getSettings().deviceName ?? hostname()`
 */
import type { AliveShellSummary } from '@shared/types';

export interface RemoteShellRow {
  projectId: number;
  shellIndex: number;
  agentState?: 'idle' | 'busy' | 'blocked' | null;
  /** Agent family label, e.g. "claude" / "codex" / "ollama"; may be absent on older peers. */
  agent?: string | null;
}

export interface RemotePeer {
  device: string;
  shells: RemoteShellRow[];
}

export interface RosterRow {
  device: string;
  shell: number;
  agent: string;
  label: string;
  state: 'idle' | 'busy' | 'blocked' | null;
  mention: string;
}

export interface BuildRosterInput {
  local: AliveShellSummary[];
  remote: RemotePeer[];
  /** shellIndex → agent family for local shells. Blank/undefined drops the row. */
  agentLabels: Record<number, string>;
  /** shellIndex → tracked state for local shells. Missing → null. */
  agentStates: Record<number, 'idle' | 'busy' | 'blocked' | null>;
  selfDevice: string;
}

interface Intermediate {
  device: string;
  shell: number;
  agent: string;
  state: 'idle' | 'busy' | 'blocked' | null;
}

export function buildRoster(input: BuildRosterInput): RosterRow[] {
  const rows: Intermediate[] = [];
  for (const s of input.local) {
    const agent = input.agentLabels[s.shellIndex];
    if (!agent) continue;
    rows.push({
      device: input.selfDevice,
      shell: s.shellIndex,
      agent,
      state: input.agentStates[s.shellIndex] ?? null,
    });
  }
  for (const peer of input.remote) {
    for (const s of peer.shells) {
      const agent = s.agent;
      if (!agent) continue;
      rows.push({
        device: peer.device,
        shell: s.shellIndex,
        agent,
        state: s.agentState ?? null,
      });
    }
  }
  rows.sort((a, b) => {
    const aSelf = a.device === input.selfDevice ? 0 : 1;
    const bSelf = b.device === input.selfDevice ? 0 : 1;
    if (aSelf !== bSelf) return aSelf - bSelf;
    if (a.device !== b.device) return a.device < b.device ? -1 : 1;
    return a.shell - b.shell;
  });
  // Count (agent, device) occurrences so unique ones can drop the #<shell>.
  const occ = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.agent}@${r.device}`;
    occ.set(key, (occ.get(key) ?? 0) + 1);
  }
  return rows.map((r) => {
    const sameAgentOnDevice = occ.get(`${r.agent}@${r.device}`) ?? 0;
    const shellPart = sameAgentOnDevice > 1 ? `#${r.shell}` : '';
    const devicePart = r.device === input.selfDevice ? '' : `@${r.device}`;
    return {
      device: r.device,
      shell: r.shell,
      agent: r.agent,
      state: r.state,
      // Human-readable label used in the pane list.
      label: devicePart ? `${r.agent} (${r.device})` : r.agent,
      mention: `@${r.agent}${shellPart}${devicePart}`,
    };
  });
}
