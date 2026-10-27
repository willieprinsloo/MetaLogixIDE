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

export type KnownDevice = { pub: string; name: string; addedAt: number };

export function loadKnownDevices(file: string = DEFAULT_KNOWN_DEVICES_PATH): KnownDevice[] {
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { devices?: unknown };
  if (!parsed || !Array.isArray(parsed.devices)) throw new Error('known_devices.json malformed');
  return parsed.devices.map((d) => {
    const x = d as Partial<KnownDevice>;
    if (typeof x.pub !== 'string' || !/^[0-9a-f]{64}$/.test(x.pub) || typeof x.name !== 'string' || typeof x.addedAt !== 'number') {
      throw new Error('known_devices.json contains an invalid entry');
    }
    return { pub: canonicalPubHex(x.pub), name: x.name, addedAt: x.addedAt };
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

export function addKnownDevice(pub: Uint8Array | string, name: string, file: string = DEFAULT_KNOWN_DEVICES_PATH, now: number = Date.now()): void {
  const canon = canonicalPubHex(pub);
  const list = loadKnownDevices(file).filter((d) => d.pub !== canon);
  list.push({ pub: canon, name, addedAt: now });
  saveKnownDevices(list, file);
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
