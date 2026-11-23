/** Profile-authorized, origin-bound Keychain grants; legacy credentials are never read. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { accountId, parseMetaprojectOrigin, type MetaprojectOrigin, type PersistenceWarning } from '@shared/metaproject-contract';
import { decodeStoredSecret, encodeStoredSecret } from '@main/credential-encoding';
import type { MetaprojectKeyring } from './ipc-handlers';
import type { Credentials } from './web-session';

const service = 'metaIDE.metaproject.web.v1';
const legacyService = 'metaIDE.metaproject';
const grantSchema = z.object({ grantId: z.uuid(), origin: z.string(), actorId: accountId });
const secretSchema = grantSchema.extend({ username: z.string().trim().min(1).max(254), password: z.string().min(1).max(256) });
export type RememberedGrant = Omit<z.output<typeof grantSchema>, 'origin'> & { readonly origin: MetaprojectOrigin };

interface GrantStore {
  read(): unknown;
  write(grant: RememberedGrant | null, origin?: MetaprojectOrigin): void;
  legacyUsername(): string;
}

/** Rotates the profile's one authorized pointer without reusing a secure slot. */
export class RememberedAccount {
  constructor(private readonly store: GrantStore, private readonly keyring: MetaprojectKeyring, private readonly allowLoopback: boolean) {}

  /** Read only validated metadata, optionally constrained to the exact requested origin. */
  current(origin?: MetaprojectOrigin): RememberedGrant | null {
    const parsed = grantSchema.safeParse(this.store.read());
    if (!parsed.success) return null;
    const bound = parseMetaprojectOrigin(parsed.data.origin, this.allowLoopback);
    if (!bound || bound !== parsed.data.origin || (origin && origin !== bound)) return null;
    return { ...parsed.data, origin: bound };
  }

  /** Read one authorized record, rejecting malformed or mismatched values without replaying them. */
  async credentials(grant: RememberedGrant): Promise<Credentials | null> {
    const stored = await this.keyring.getPassword(service, grant.grantId);
    if (!stored || stored.length > 8192) return null;
    try {
      const decoded = decodeStoredSecret(stored);
      if (decoded.legacy) return null;
      const entry = secretSchema.parse(JSON.parse(decoded.text));
      if (entry.actorId !== grant.actorId || entry.grantId !== grant.grantId || entry.origin !== grant.origin) return null;
      return { username: entry.username, password: entry.password };
    } catch { return null; }
  }

  /** Revoke permission before awaiting deletion; origin is persisted atomically with revocation. */
  async forget(origin?: MetaprojectOrigin): Promise<{ committed: boolean; warning?: PersistenceWarning }> {
    let prior: RememberedGrant | null = null;
    let known = false;
    let committed = false;
    try { prior = this.current(); known = true; } catch { known = false; }
    try { this.store.write(null, origin); committed = true; } catch { committed = false; }
    const cleared = known && (!prior || await this.clear(service, prior.grantId));
    if (!committed && !cleared) return { committed, warning: 'forget-incomplete' };
    if (!cleared) return { committed, warning: 'keychain-not-cleared' };
    return { committed };
  }

  /** Publish only after secure save and rechecking ownership in the synchronous commit turn. */
  async save(origin: MetaprojectOrigin, actorId: RememberedGrant['actorId'], credentials: Credentials, current: () => boolean): Promise<PersistenceWarning | undefined> {
    const grant = { grantId: randomUUID(), origin, actorId };
    try {
      await this.keyring.setPassword(service, grant.grantId, encodeStoredSecret(JSON.stringify({ ...grant, ...credentials })));
      if (current()) {
        this.store.write(grant);
        return undefined;
      }
    } catch {
      const removed = await this.clear(service, grant.grantId);
      return removed ? 'not-remembered' : 'keychain-not-cleared';
    }
    await this.clear(service, grant.grantId);
    return undefined;
  }

  /** Retire only known legacy slots; an absent secure record is already clear. */
  async clearLegacy(entered?: string): Promise<boolean> {
    let last: string;
    try { last = this.store.legacyUsername(); } catch { return false; }
    const names = new Set([last, entered].filter((name): name is string => !!name && name.length <= 254));
    const cleared = await Promise.all([...names].map(name => this.clear(legacyService, name)));
    return cleared.every(Boolean);
  }

  private async clear(namespace: string, key: string): Promise<boolean> {
    try {
      if (await this.keyring.deletePassword(namespace, key)) return true;
      return await this.keyring.getPassword(namespace, key) === null;
    } catch { return false; }
  }
}
