import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOrCreateDeviceKey, fingerprintFromPub, loadKnownDevices, saveKnownDevices, canonicalPubHex, addKnownDevice, isTrustedDevice, removeKnownDevice } from '../identity';
import { EFF_SHORT_WORDLIST } from '../_wordlist';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metaide-id-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('wordlist', () => {
  it('is the 1296-word EFF short list with unique entries', () => {
    expect(EFF_SHORT_WORDLIST.length).toBe(1296);
    expect(new Set(EFF_SHORT_WORDLIST).size).toBe(1296);
  });
});

describe('device key', () => {
  it('creates a 0600 file and reloads the same keypair', () => {
    const f = path.join(dir, 'sub', 'device.key');
    const a = loadOrCreateDeviceKey(f);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(f).length).toBe(32);
    const b = loadOrCreateDeviceKey(f);
    expect(Buffer.from(b.pub)).toEqual(Buffer.from(a.pub));
    expect(Buffer.from(b.priv.reveal())).toEqual(Buffer.from(a.priv.reveal()));
    expect(b.fingerprint).toBe(a.fingerprint);
  });
  it('concurrent calls converge on the same keypair (O_EXCL)', async () => {
    const f = path.join(dir, 'race', 'device.key');
    const [a, b, c] = (await Promise.all([1, 2, 3].map(async () => loadOrCreateDeviceKey(f)))) as [ReturnType<typeof loadOrCreateDeviceKey>, ReturnType<typeof loadOrCreateDeviceKey>, ReturnType<typeof loadOrCreateDeviceKey>];
    expect(Buffer.from(b.pub)).toEqual(Buffer.from(a.pub));
    expect(Buffer.from(c.pub)).toEqual(Buffer.from(a.pub));
    expect(fs.readFileSync(f).length).toBe(32);
  });
  it('leaves no stale tmp files, including when a 0-byte key already exists', () => {
    const d = path.join(dir, 'tmpcheck');
    loadOrCreateDeviceKey(path.join(d, 'device.key'));
    expect(fs.readdirSync(d)).toEqual(['device.key']);
    const z = path.join(dir, 'zero');
    fs.mkdirSync(z);
    fs.writeFileSync(path.join(z, 'device.key'), '');
    expect(() => loadOrCreateDeviceKey(path.join(z, 'device.key'))).toThrow(/corrupt/);
    expect(fs.readdirSync(z)).toEqual(['device.key']);
  });
  it('redacts the private key when serialised', () => {
    const k = loadOrCreateDeviceKey(path.join(dir, 'k'));
    expect(JSON.stringify(k.priv)).toBe('"<redacted>"');
    expect(String(k.priv)).toBe('<redacted>');
  });
  it('rejects a corrupt key file and repairs loose permissions', () => {
    const f = path.join(dir, 'k');
    fs.writeFileSync(f, Buffer.alloc(5));
    expect(() => loadOrCreateDeviceKey(f)).toThrow(/corrupt/);
    fs.writeFileSync(f, Buffer.alloc(32, 7));
    fs.chmodSync(f, 0o644);
    loadOrCreateDeviceKey(f);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });
  it('fingerprint is stable: 6 words from the list', () => {
    const pub = new Uint8Array(32).fill(9);
    const fp = fingerprintFromPub(pub);
    expect(fingerprintFromPub(pub)).toBe(fp);
    const words = fp.split(' ');
    expect(words).toHaveLength(6);
    for (const w of words) expect(EFF_SHORT_WORDLIST).toContain(w);
    expect(fingerprintFromPub(new Uint8Array(32).fill(10))).not.toBe(fp);
  });
});

describe('known devices', () => {
  it('round-trips at 0600 with no tmp leftovers', () => {
    const f = path.join(dir, 'known_devices.json');
    expect(loadKnownDevices(f)).toEqual([]);
    const list = [{ pub: '12'.repeat(32), name: 'laptop', addedAt: 123 }];
    saveKnownDevices(list, f);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(loadKnownDevices(f)).toEqual(list);
    saveKnownDevices([], f);
    expect(loadKnownDevices(f)).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual(['known_devices.json']);
  });
  it('rejects invalid entries', () => {
    const f = path.join(dir, 'k.json');
    fs.writeFileSync(f, JSON.stringify({ devices: [{ pub: 'zz', name: 'x', addedAt: 1 }] }));
    expect(() => loadKnownDevices(f)).toThrow();
  });
});

describe('known device canonicalization', () => {
  it('clears the Edwards sign bit and treats sign-flipped twins as one device', () => {
    const a = '11'.repeat(31) + '05';
    const twin = '11'.repeat(31) + '85';
    expect(canonicalPubHex(a)).toBe(a);
    expect(canonicalPubHex(twin)).toBe(a);
    const f = path.join(dir, 'k.json');
    addKnownDevice(twin, 'box', f, 5);
    expect(JSON.parse(fs.readFileSync(f, 'utf8')).devices[0].pub).toBe(a);
    expect(isTrustedDevice(a, f)).toBe(true);
    expect(isTrustedDevice(Buffer.from(twin, 'hex'), f)).toBe(true);
    expect(removeKnownDevice(a, f)).toBe(true);
    expect(isTrustedDevice(twin, f)).toBe(false);
    expect(removeKnownDevice(a, f)).toBe(false);
  });
  it('canonicalizes legacy entries on load', () => {
    const f = path.join(dir, 'legacy.json');
    fs.writeFileSync(f, JSON.stringify({ devices: [{ pub: 'ab'.repeat(32), name: 'x', addedAt: 1 }] }));
    expect(loadKnownDevices(f)[0]!.pub).toBe('ab'.repeat(31) + '2b');
  });
});
