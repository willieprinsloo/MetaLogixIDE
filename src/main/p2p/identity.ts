import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Secret } from '../../shared/signaling-wire';
import { EFF_SHORT_WORDLIST } from './_wordlist';

export const DEFAULT_KEY_PATH = path.join(os.homedir(), '.metaide', 'device.key');
export const DEFAULT_KNOWN_DEVICES_PATH = path.join(os.homedir(), '.metaide', 'known_devices.json');

export type DeviceKey = { pub: Uint8Array; priv: Secret<Uint8Array>; fingerprint: string };

/** 6 words from EFF Diceware Short derived from SHA-256(pub). Deterministic. */
export function fingerprintFromPub(pub: Uint8Array): string {
  const digest = createHash('sha256').update(pub).digest();
  const words: string[] = [];
  for (let i = 0; i < 6; i++) {
    // 32-bit slice mod 1296: modulo bias is ~3e-7, irrelevant for a display fingerprint.
    words.push(EFF_SHORT_WORDLIST[digest.readUInt32BE(i * 4) % EFF_SHORT_WORDLIST.length]!);
  }
  return words.join(' ');
}

/** Atomic write: tmp file (0600) then rename. */
function atomicWrite(file: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

function readSeed(file: string): Uint8Array {
  const raw = fs.readFileSync(file);
  if (raw.length !== 32) throw new Error(`device key at ${file} is corrupt (expected 32 bytes)`);
  if ((fs.statSync(file).mode & 0o777) !== 0o600) fs.chmodSync(file, 0o600);
  return new Uint8Array(raw);
}

export function loadOrCreateDeviceKey(file: string = DEFAULT_KEY_PATH): DeviceKey {
  const finish = (seed: Uint8Array): DeviceKey => {
    const pub = ed25519.getPublicKey(seed);
    return { pub, priv: new Secret(seed), fingerprint: fingerprintFromPub(pub) };
  };
  if (fs.existsSync(file)) return finish(readSeed(file));

  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const seed = new Uint8Array(randomBytes(32));
  const tmp = path.join(dir, `.device.key.tmp-${randomBytes(8).toString('hex')}`);
  try {
    // Full seed is written and fsynced to a 0600 tmp file, then linked into place:
    // `file` either does not exist or is complete, never a partial write.
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeSync(fd, seed);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.linkSync(tmp, file); // atomic; EEXIST if another process won the race
    return finish(seed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return finish(readSeed(file));
    throw err;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* no-op */ }
  }
}

/**
 * `code` is the peer's mrsignald host connect code: the address a viewer puts in `session_request`.
 * `viewer` marks an explicit viewer-only device (the mobile app). A missing `code` only means undialable.
 * `workspaceAccess` is a local grant, never supplied by pairing metadata. Missing means denied.
 */
export type KnownDevice = { pub: string; name: string; addedAt: number; code?: string; viewer?: boolean; workspaceAccess?: true };

/**
 * True for a device that cannot be a fleet machine: it said so when pairing, or it gave no connect code,
 * so nothing here can dial it. Such devices stay trusted and revocable but are kept out of the fleet views.
 */
export function isViewerOnly(d: KnownDevice): boolean {
  return d.viewer === true || !d.code;
}

export const CONNECT_CODE_RE = /^[A-Za-z0-9-]{4,32}$/;

export function loadKnownDevices(file: string = DEFAULT_KNOWN_DEVICES_PATH): KnownDevice[] {
  if (!fs.existsSync(file)) return [];
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !('devices' in parsed) || !Array.isArray(parsed.devices)) {
    throw new Error('known_devices.json malformed');
  }
  return parsed.devices.map((x: unknown): KnownDevice => {
    if (!x || typeof x !== 'object' || !('pub' in x) || typeof x.pub !== 'string' || !/^[0-9a-f]{64}$/.test(x.pub)
      || !('name' in x) || typeof x.name !== 'string' || !('addedAt' in x) || typeof x.addedAt !== 'number') {
      throw new Error('known_devices.json contains an invalid entry');
    }
    const code = 'code' in x && typeof x.code === 'string' && CONNECT_CODE_RE.test(x.code) ? x.code : undefined;
    const viewer = 'viewer' in x && x.viewer === true;
    const workspaceAccess = !viewer && 'workspaceAccess' in x && x.workspaceAccess === true;
    return {
      pub: canonicalPubHex(x.pub), name: x.name, addedAt: x.addedAt,
      ...(code ? { code } : {}), ...(viewer ? { viewer: true } : {}), ...(workspaceAccess ? { workspaceAccess: true } : {}),
    };
  });
}

/**
 * Ed25519 public keys encode the sign of x in the top bit of byte 31. The X25519 identity used by the
 * Noise handshake ignores that bit, so A and its sign-flipped twin are the same device. Clearing it
 * gives one canonical hex per device; every store and every trust check goes through this.
 */
export function canonicalPubHex(pub: Uint8Array | string): string {
  const bytes = typeof pub === 'string' ? Buffer.from(pub, 'hex') : Buffer.from(pub);
  if (bytes.length !== 32) throw new Error('invalid device public key');
  bytes[31] = bytes[31]! & 0x7f;
  return bytes.toString('hex');
}

export function isTrustedDevice(pub: Uint8Array | string, file: string = DEFAULT_KNOWN_DEVICES_PATH): boolean {
  const want = canonicalPubHex(pub);
  return loadKnownDevices(file).some((d) => d.pub === want);
}

/** Re-pairing preserves a local grant unless the peer is explicitly viewer-only. */
export function addKnownDevice(pub: Uint8Array | string, name: string, file: string = DEFAULT_KNOWN_DEVICES_PATH, now: number = Date.now(), code?: string, viewer?: boolean): void {
  const canon = canonicalPubHex(pub);
  const devices = loadKnownDevices(file);
  const prev = devices.find((d) => d.pub === canon);
  const list = devices.filter((d) => d.pub !== canon);
  const keep = code && CONNECT_CODE_RE.test(code) ? code : prev?.code;
  // Omitted peer metadata must not clear a previously recorded viewer-only classification.
  const explicitViewer = viewer === true || prev?.viewer === true;
  list.push({
    pub: canon, name, addedAt: now,
    ...(keep ? { code: keep } : {}), ...(explicitViewer ? { viewer: true } : {}),
    ...(!explicitViewer && prev?.workspaceAccess === true ? { workspaceAccess: true } : {}),
  });
  saveKnownDevices(list, file);
}

export function setKnownDeviceWorkspaceAccess(pub: string, allowed: boolean, file: string = DEFAULT_KNOWN_DEVICES_PATH): void {
  const canon = canonicalPubHex(pub);
  const devices = loadKnownDevices(file);
  const device = devices.find((d) => d.pub === canon);
  if (!device) throw new Error('Unknown paired device');
  if (device.viewer === true) throw new Error('Viewer-only devices cannot be allowed workspace access');
  if (allowed) device.workspaceAccess = true;
  else delete device.workspaceAccess;
  saveKnownDevices(devices, file);
}

export function removeKnownDevice(pub: Uint8Array | string, file: string = DEFAULT_KNOWN_DEVICES_PATH): boolean {
  const canon = canonicalPubHex(pub);
  const list = loadKnownDevices(file);
  const next = list.filter((d) => d.pub !== canon);
  if (next.length === list.length) return false;
  saveKnownDevices(next, file);
  return true;
}

export function saveKnownDevices(list: KnownDevice[], file: string = DEFAULT_KNOWN_DEVICES_PATH): void {
  atomicWrite(file, JSON.stringify({ devices: list.map((d) => ({ ...d, pub: canonicalPubHex(d.pub) })) }, null, 2));
}
