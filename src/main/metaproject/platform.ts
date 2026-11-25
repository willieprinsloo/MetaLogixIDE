import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { MetaprojectKeyring } from './ipc-handlers';

type MetaprojectPlatform = { keyring: MetaprojectKeyring; openExternal: (url: string) => Promise<void> };

function isKeyring(raw: unknown): raw is MetaprojectKeyring {
  return typeof raw === 'object' && raw !== null &&
    'getPassword' in raw && typeof raw.getPassword === 'function' &&
    'setPassword' in raw && typeof raw.setPassword === 'function' &&
    'deletePassword' in raw && typeof raw.deletePassword === 'function';
}

async function loadKeyring(): Promise<MetaprojectKeyring> {
  const keytar: unknown = await import('keytar');
  if (isKeyring(keytar)) return keytar;
  if (typeof keytar === 'object' && keytar !== null && 'default' in keytar && isKeyring(keytar.default)) {
    return keytar.default; // Electron's packaged ESM wrapper can expose only the CJS default.
  }
  throw new Error('Metaproject credential store unavailable');
}

const systemKeyring: MetaprojectKeyring = {
  async getPassword(service, account) { return (await loadKeyring()).getPassword(service, account); },
  async setPassword(service, account, value) { await (await loadKeyring()).setPassword(service, account, value); },
  async deletePassword(service, account) { return (await loadKeyring()).deletePassword(service, account); },
};

/** Only the unpackaged, isolated fixture profile exposes this adapter; no test-mode IPC success bypass. */
function fixturePlatform(profile: string): MetaprojectPlatform {
  const dir = join(profile, 'metaproject-fixture');
  function slot(service: string, account: string): string {
    const key = createHash('sha256').update(JSON.stringify([service, account])).digest('hex');
    return join(dir, key);
  }
  return {
    keyring: {
      async getPassword(service, account) {
        try { return await readFile(slot(service, account), 'utf8'); }
        catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
          throw error;
        }
      },
      async setPassword(service, account, value) {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(slot(service, account), value, { mode: 0o600, flag: 'wx' });
      },
      async deletePassword(service, account) {
        await rm(slot(service, account), { force: true });
        return true;
      },
    },
    async openExternal(url) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await appendFile(join(dir, 'opened.jsonl'), `${JSON.stringify(url)}\n`, { mode: 0o600 });
    },
  };
}

export function metaprojectPlatform(
  fixtureProfile: string | null,
  openExternal: MetaprojectPlatform['openExternal'],
): MetaprojectPlatform {
  return fixtureProfile === null ? { keyring: systemKeyring, openExternal } : fixturePlatform(fixtureProfile);
}
