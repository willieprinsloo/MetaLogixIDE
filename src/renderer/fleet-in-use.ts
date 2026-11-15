/**
 * Pure rules behind the sidebar's shared In use section (docs/specs/machine-switcher-dots.md
 * AC36–AC40): the paired machines' live-project rows and the heading's agent state. No React and no
 * IPC; the names come from `useFleetInUse` and the live sets from the switcher's `shells.alive` poll.
 */
import type { AgentState } from '@shared/agent-state';
import { machineAgentState } from './agent-state';
import type { MachineDot } from './machine-switcher-contract';
import { filterByName, type PeerShells } from './machine-dots';

/** One paired machine's live project in the shared In use section. */
export interface RemoteInUseRow { deviceId: string; deviceName: string; projectId: number; name: string; state: AgentState }

/** Known project names per paired machine: device id, then project id to name. */
export type FleetProjectNames = ReadonlyMap<string, ReadonlyMap<number, string>>;

function machineRows(m: MachineDot, shells: PeerShells, names: ReadonlyMap<number, string>): RemoteInUseRow[] {
  const rows: RemoteInUseRow[] = [];
  for (const projectId of shells.aliveProjectIds) {
    const name = names.get(projectId);
    if (name === undefined) continue;
    rows.push({ deviceId: m.deviceId, deviceName: m.name, projectId, name, state: shells.projectStates.get(projectId) ?? 'idle' });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.projectId - b.projectId);
}

/**
 * The paired machines' rows (AC36, AC39): online peers only, in dot order (`machines` is the dot
 * list), projects sorted by name within a machine, ids with no known name left out, then the filter
 * by project name. This machine is never listed here; its rows are the local In use list.
 */
export function remoteInUseRows(
  machines: readonly MachineDot[], shells: ReadonlyMap<string, PeerShells>, names: FleetProjectNames, filter: string,
): RemoteInUseRow[] {
  const rows = machines.flatMap((m) => {
    const live = m.self || !m.online ? undefined : shells.get(m.deviceId);
    const known = names.get(m.deviceId);
    return live && known ? machineRows(m, live, known) : [];
  });
  return filterByName(rows, filter);
}

/** The heading's agent state (AC40): the worst of `local` (null when this machine has no rows) and every remote row's state, idle when nothing runs. */
export function inUseHeadingState(local: AgentState | null, rows: readonly RemoteInUseRow[]): AgentState {
  return machineAgentState([local, ...rows.map((r) => r.state)]) ?? 'idle';
}
