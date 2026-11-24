/**
 * Account → password store backed by Electron's safeStorage. Replaces the
 * keytar native module that broke in the bundled app (CJS/ESM interop
 * surfaced `setPassword is not a function` and credentials silently stopped
 * persisting). safeStorage uses the same OS keychains under the hood —
 * macOS Keychain, Windows DPAPI, libsecret on Linux — but as a pure
 * Electron API with no node-gyp build to go wrong.
 *
 * Encrypted bytes are stored base64 in `<dir>/credentials.enc.json`.
 * Plaintext never touches disk; a corrupted or missing file is treated as
 * "nothing stored" so one bad write cannot wedge the login flow.
 */
import { safeStorage } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';

const FILE = 'credentials.enc.json';

export interface CredentialStore {
  isAvailable(): boolean;
  save(account: string, password: string): Promise<boolean>;
  load(account: string): Promise<string | null>;
  clear(account: string): Promise<void>;
}

type Entries = Record<string, string>;

function readEntries(path: string): Entries {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Entries;
    }
    return {};
  } catch {
    // Missing file, malformed JSON, or anything else: start fresh. The next
    // save() rewrites the file, so one bad state does not persist.
    return {};
  }
}

function writeEntries(path: string, entries: Entries): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(entries), 'utf8');
}

export function createCredentialStore(dir: string): CredentialStore {
  const path = join(dir, FILE);
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    async save(account, password) {
      if (!safeStorage.isEncryptionAvailable()) return false;
      const encrypted = safeStorage.encryptString(password).toString('base64');
      const entries = readEntries(path);
      entries[account] = encrypted;
      writeEntries(path, entries);
      return true;
    },
    async load(account) {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const entries = readEntries(path);
      const b64 = entries[account];
      if (!b64) return null;
      try {
        return safeStorage.decryptString(Buffer.from(b64, 'base64'));
      } catch {
        return null;
      }
    },
    async clear(account) {
      const entries = readEntries(path);
      if (!(account in entries)) return;
      delete entries[account];
      writeEntries(path, entries);
    },
  };
}
