import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Paired-machine fixture for the sidebar machine switcher (docs/specs/machine-switcher-dots.md).
 *
 * The main process re-reads `<HOME>/.metaide/known_devices.json` on every fleet poll (5 s), so writing
 * this file into an isolated HOME gives real, *offline* paired machines with no mocking; rewriting it
 * while the app runs adds or removes peers within one poll. The file format is the one
 * `loadKnownDevices` accepts (src/main/p2p/identity.ts): `{ devices: [{ pub, name, addedAt }] }` with
 * `pub` 64 lowercase hex. A malformed file makes the fleet call throw, so `writeFleet` self-checks.
 */

export interface FleetPeer { pub: string; name: string }

/** One fleet poll, plus slack: how long a test waits for a file change to show in the sidebar. */
export const FLEET_POLL_WAIT_MS = 15_000;

/**
 * A valid device id. `canonicalPubHex` clears the top bit of the last byte, so the last byte is kept
 * below 0x80 (index < 128) to make the stored id equal the one written here.
 */
export function peerPub(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 127) throw new Error(`peerPub index out of range: ${index}`);
  return `${'ab'.repeat(31)}${index.toString(16).padStart(2, '0')}`;
}

export function peer(index: number, name: string): FleetPeer {
  return { pub: peerPub(index), name };
}

/** Writes (replaces) the known-devices file under `home`. An empty list removes every peer. */
export function writeFleet(home: string, peers: readonly FleetPeer[]): void {
  const fail = (cause: string): never => { throw new Error(`fleet-fixture self-check failed: ${cause}`); };
  const seen = new Set<string>();
  for (const p of peers) {
    if (!/^[0-9a-f]{64}$/.test(p.pub)) fail(`pub must be 64 lowercase hex, got ${p.pub}`);
    if (parseInt(p.pub.slice(62), 16) >= 0x80) fail(`pub ${p.pub} last byte >= 0x80 would be canonicalised to a different id`);
    if (seen.has(p.pub)) fail(`duplicate pub ${p.pub}`);
    seen.add(p.pub);
    if (!p.name) fail('peer name must be non-empty');
  }
  const dir = join(home, '.metaide');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'known_devices.json'),
    JSON.stringify({ devices: peers.map((p) => ({ pub: p.pub, name: p.name, addedAt: 1 })) }),
  );
}
