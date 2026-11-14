import type { FleetEntry } from '@shared/p2p-contract';

/** Selection key of this machine's dot; peer ids are 64-char hex, so it cannot collide (spec AC5). */
export const LOCAL_MACHINE_ID = 'local' as const;

/** One dot in the machine switcher; `self` is true only for the {@link LOCAL_MACHINE_ID} dot. */
export type MachineDot = Pick<FleetEntry, 'deviceId' | 'name' | 'online' | 'lastSeenAt'> & { self: boolean };

/** What the sidebar hands to App when a remote project is clicked. */
export interface OpenPaneRequest {
  source: { kind: 'remote'; deviceId: string };
  deviceName: string;
  projectId: number;
  projectName: string;
}
