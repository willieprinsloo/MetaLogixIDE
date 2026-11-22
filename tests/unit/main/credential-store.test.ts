/**
 * Credential store built on Electron's safeStorage. Round-trips passwords
 * through the platform keychain (macOS Keychain / DPAPI / libsecret) without
 * a native dependency, which is why we swapped it in for keytar — keytar's
 * CJS/ESM interop blew up in the bundled app and credentials silently
 * stopped persisting. The store writes an encrypted JSON file in userData,
 * one entry per account; the file never holds plaintext.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`, 'utf8')),
  decryptString: vi.fn((b: Buffer) => b.toString('utf8').replace(/^enc:/, '')),
}));

vi.mock('electron', () => ({ safeStorage: safeStorageMock }));

import { createCredentialStore } from '@main/credential-store';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'credstore-'));
  safeStorageMock.isEncryptionAvailable.mockReset().mockReturnValue(true);
  safeStorageMock.encryptString
    .mockReset()
    .mockImplementation((s: string) => Buffer.from(`enc:${s}`, 'utf8'));
  safeStorageMock.decryptString
    .mockReset()
    .mockImplementation((b: Buffer) => b.toString('utf8').replace(/^enc:/, ''));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createCredentialStore', () => {
  it('round-trips a password through save → load', async () => {
    const store = createCredentialStore(dir);
    await store.save('alice', 'p@ss w\\ord ✓');
    await expect(store.load('alice')).resolves.toBe('p@ss w\\ord ✓');
  });

  it('load returns null for an unknown account', async () => {
    const store = createCredentialStore(dir);
    await expect(store.load('bob')).resolves.toBeNull();
  });

  it('load returns null when the backing file does not exist yet', async () => {
    const store = createCredentialStore(dir);
    await expect(store.load('alice')).resolves.toBeNull();
    expect(existsSync(join(dir, 'credentials.enc.json'))).toBe(false);
  });

  it('clear removes the account without destroying other entries', async () => {
    const store = createCredentialStore(dir);
    await store.save('alice', 'a-pass');
    await store.save('bob', 'b-pass');
    await store.clear('alice');
    await expect(store.load('alice')).resolves.toBeNull();
    await expect(store.load('bob')).resolves.toBe('b-pass');
  });

  it('writes an encrypted file — plaintext is never on disk', async () => {
    const store = createCredentialStore(dir);
    await store.save('alice', 'super-secret-99');
    const raw = readFileSync(join(dir, 'credentials.enc.json'), 'utf8');
    expect(raw).not.toContain('super-secret-99');
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith('super-secret-99');
  });

  it('save overwrites an existing entry for the same account', async () => {
    const store = createCredentialStore(dir);
    await store.save('alice', 'first');
    await store.save('alice', 'second');
    await expect(store.load('alice')).resolves.toBe('second');
  });

  it('a corrupted file does not crash — returns null and lets save heal it', async () => {
    writeFileSync(join(dir, 'credentials.enc.json'), '{not json');
    const store = createCredentialStore(dir);
    await expect(store.load('alice')).resolves.toBeNull();
    await store.save('alice', 'fresh');
    await expect(store.load('alice')).resolves.toBe('fresh');
  });

  it('a decryptString throw is reported as null, not an unhandled error', async () => {
    const store = createCredentialStore(dir);
    await store.save('alice', 'ok');
    safeStorageMock.decryptString.mockImplementationOnce(() => {
      throw new Error('keychain locked');
    });
    await expect(store.load('alice')).resolves.toBeNull();
  });

  it('encryption unavailable: save returns false, load returns null, no file written', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    const store = createCredentialStore(dir);
    await expect(store.save('alice', 'x')).resolves.toBe(false);
    await expect(store.load('alice')).resolves.toBeNull();
    expect(existsSync(join(dir, 'credentials.enc.json'))).toBe(false);
  });

  it('isAvailable mirrors safeStorage.isEncryptionAvailable', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    const s1 = createCredentialStore(dir);
    expect(s1.isAvailable()).toBe(false);
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    const s2 = createCredentialStore(dir);
    expect(s2.isAvailable()).toBe(true);
  });
});
