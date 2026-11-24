import type { FleetEntry } from '@shared/p2p-contract';
import type { AgentState } from '@shared/agent-state';

/** Selection key of this machine's dot; peer ids are 64-char hex, so it cannot collide (spec AC5). */
export const LOCAL_MACHINE_ID = 'local' as const;

/**
 * One dot in the machine switcher; `self` is true only for the {@link LOCAL_MACHINE_ID} dot.
 * `agentState` is the machine's overall agent status (AC34); undefined or null means clear glass.
 */
export type MachineDot = Pick<FleetEntry, 'deviceId' | 'name' | 'online' | 'lastSeenAt'> & { self: boolean; agentState?: AgentState | null };

/** What the sidebar hands to App when a remote project is clicked. */
export interface OpenPaneRequest {
  source: { kind: 'remote'; deviceId: string };
  deviceName: string;
  projectId: number;
  projectName: string;
}
