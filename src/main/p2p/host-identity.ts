import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The (code, secret) pair mrsignald mints for a host on first connect (`assign_code`). The code is this
 * machine's public connect code (also its pairing/rendezvous address); the secret proves ownership of it on reconnect.
 */
export type HostIdentity = { code: string; secret: string };

export const DEFAULT_HOST_IDENTITY_PATH = path.join(os.homedir(), '.metaide', 'host-identity.json');

/** Returns null when the file is absent. Throws on a corrupt file (never silently mints over a damaged identity). */
export function loadHostIdentity(file: string = DEFAULT_HOST_IDENTITY_PATH): HostIdentity | null {
  if (!fs.existsSync(file)) return null;
  if ((fs.statSync(file).mode & 0o777) !== 0o600) fs.chmodSync(file, 0o600);
  const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { code?: unknown; secret?: unknown };
  if (typeof j.code !== 'string' || !j.code || typeof j.secret !== 'string' || !j.secret) {
    throw new Error('host-identity.json is corrupt');
  }
  return { code: j.code, secret: j.secret };
}

/** Atomic (tmp + rename), mode 0600, directory 0700. */
export function saveHostIdentity(id: HostIdentity, file: string = DEFAULT_HOST_IDENTITY_PATH): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ code: id.code, secret: id.secret }, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}
