import type { FleetEntry, P2PSettings, P2PSettingsView } from '../../shared/p2p-contract';
import type { DeviceKey } from './identity';
import type { PairingSession } from './pairing-session';

export type PairRedeemResult = { ok: true } | { ok: false; error: string };

/** What the `p2p:*` IPC handlers call. Lives behind `Services.p2p` so ipc/register.ts never imports the lifecycle (hub imports register). */
export interface P2PApi {
  fleetList(): Promise<FleetEntry[]>;
  getSettings(): P2PSettingsView;
  setSettings(patch: Partial<P2PSettings>): Promise<void>;
  generatePairCode(): { code: string; expiresAt: number };
  redeemPairCode(code: string): Promise<PairRedeemResult>;
  revokeDevice(deviceId: string): Promise<void>;
  /** Force-close any live viewer connection to this device so the next RPC rebuilds a fresh one. No-op if nothing is connected. */
  reconnectDevice(deviceId: string): Promise<void>;
  /** Unary call, or for `shells.attach` a stream: events are pushed on `p2p:rpc-event` and `{ streamId }` is returned. */
  rpcCall(deviceId: string, method: string, params: unknown): Promise<unknown>;
  rpcCloseStream(streamId: number): void;
}

/** Runtime P2P state, attached to `Services.p2p` by `startP2P`. */
export interface P2PServices {
  deviceKey: DeviceKey;
  pairing: PairingSession;
  knownDevicesPath: string;
  api: P2PApi;
}
