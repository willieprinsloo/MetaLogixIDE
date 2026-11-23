/** Owns shared session publication, durable transitions and epoch fences. */
import { randomUUID } from 'node:crypto';
import { parseMetaprojectOrigin, type MetaprojectActor, type MetaprojectFailure, type MetaprojectOrigin, type MetaprojectResult, type MetaprojectSessionSnapshot, type PersistenceWarning, type ValidMetaprojectRequest } from '@shared/metaproject-contract';
import type { MetaprojectClient } from './client';
import type { RememberedAccount, RememberedGrant } from './remembered-account';
import { WebFailure, type AuthenticationResult, type Credentials } from './web-session';

export interface SessionTransport {
  authenticate(credentials: Credentials, signal: AbortSignal): Promise<AuthenticationResult>;
  client(input: { actor: MetaprojectActor; signal: AbortSignal; changed(connected: boolean): void; rejected(): void; forward(event: string, payload: unknown): void }): MetaprojectClient;
  retire(logout: boolean): Promise<void>;
}

interface SessionOptions {
  configuredOrigin: string;
  allowLoopback: boolean;
  account: Pick<RememberedAccount, 'current' | 'credentials' | 'forget' | 'save' | 'clearLegacy'>;
  transport(origin: MetaprojectOrigin): SessionTransport;
  publish(snapshot: MetaprojectSessionSnapshot): void;
  chat(epoch: number, event: string, payload: unknown): void;
}

interface Attempt {
  epoch: number;
  origin: MetaprojectOrigin;
  controller: AbortController;
  transport: SessionTransport;
}
interface LiveSession extends Attempt { client: MetaprojectClient }
type Login = ValidMetaprojectRequest<'metaproject:session-login'>;
type SnapshotResult = MetaprojectResult<MetaprojectSessionSnapshot>;

/** Wrap a successful value in the shared result envelope. */
export function ok<T>(value: T): MetaprojectResult<T> { return { ok: true, value }; }
/** Wrap a safe failure reason in the shared result envelope. */
export function failure<T = never>(reason: MetaprojectFailure): MetaprojectResult<T> { return { ok: false, reason }; }
/** Keep adapter details out of IPC results. */
export function failureReason(error: unknown): MetaprojectFailure { return error instanceof WebFailure ? error.reason : 'unavailable'; }

/** Makes one verified jar and one Chat client available at a time. */
export class SessionService {
  private state: MetaprojectSessionSnapshot;
  private attempt: Attempt | null = null;
  private live: LiveSession | null = null;
  private started = false;
  private disposed = false;
  private retiring = false;
  private loginAfter = 0;

  constructor(private readonly options: SessionOptions) {
    const { configuredOrigin, allowLoopback } = options;
    const origin = parseMetaprojectOrigin(configuredOrigin, allowLoopback);
    this.state = { epoch: 0, phase: 'signed-out', configuredOrigin: origin ?? '', origin, ...(origin ? {} : { reason: 'invalid-origin' }) };
  }

  /** Return the latest public state, without starting authentication. */
  snapshot(): MetaprojectSessionSnapshot { return this.state; }

  /** Restore only once per lifetime; simultaneous callers observe the same state. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    if (this.state.phase === 'signed-out' && this.state.reason === undefined) void this.restore();
  }

  /** Accept a single explicit login under the current origin and epoch. */
  async login(input: Login): Promise<SnapshotResult> {
    if (this.disposed || input.epoch !== this.state.epoch) return failure('stale');
    if (!this.state.origin) return failure('invalid-origin');
    if (this.attempt || this.retiring || this.live) return failure('conflict');
    if (Date.now() < this.loginAfter) return failure('throttled');
    this.started = true;
    const attempt = this.begin('signing-in', input.attemptId, this.state.origin);
    const credentials = { username: input.username, password: input.password };
    const result = await this.authenticate(attempt, credentials);
    if (!this.owns(attempt)) return failure('stale');
    if (!result.ok) {
      this.applyLoginDelay(result);
      return this.abortAttempt(result.reason);
    }
    return this.finishLogin(attempt, result.value, input);
  }

  private async finishLogin(attempt: Attempt, actor: MetaprojectActor, input: Login): Promise<SnapshotResult> {
    const { account } = this.options;
    const forgotten = await account.forget();
    if (!this.owns(attempt)) return failure('stale');
    if (forgotten.warning === 'forget-incomplete') return this.abortAttempt('unavailable', false, forgotten.warning);
    const saved = input.remember ? await account.save(attempt.origin, actor.id, { username: input.username, password: input.password }, () => this.owns(attempt)) : null;
    if (!this.owns(attempt)) return failure('stale');
    const warning = saved && !saved.remembered ? saved.warning ?? forgotten.warning : forgotten.warning;
    const response = this.activate(attempt, actor, saved?.remembered ?? false, warning);
    this.clearLegacyAfterLogin(attempt.epoch, input.username);
    return response;
  }

  private clearLegacyAfterLogin(epoch: number, username: string): void {
    const { account } = this.options;
    void account.clearLegacy(username).then(cleared => {
      if (!cleared && this.live?.epoch === epoch && this.state.phase === 'signed-in' && !this.state.warning) {
        this.set({ ...this.state, warning: 'keychain-not-cleared' });
      }
    });
  }

  /** Cancel only the request whose token is still current. */
  cancel(attemptId: string): MetaprojectSessionSnapshot {
    if ((this.state.phase === 'signing-in' || this.state.phase === 'restoring') && this.state.attemptId === attemptId) this.retire();
    return this.state;
  }

  /** Explicit retry only for transient restore failure at the same epoch. */
  async retry(epoch: number): Promise<SnapshotResult> {
    if (epoch !== this.state.epoch || this.disposed) return failure('stale');
    if (this.state.phase !== 'signed-out' || !this.state.retryRestore || this.retiring) return failure('conflict');
    if (Date.now() < this.loginAfter) return failure('throttled');
    return this.restore();
  }

  /** Hide live protected state immediately whether or not durable forget succeeds. */
  async logout(epoch: number): Promise<SnapshotResult> {
    if (this.disposed || epoch !== this.state.epoch) return failure('stale');
    if (this.retiring) return failure('conflict');
    return this.forgetSession();
  }

  /** Validate and atomically revoke grant permission when changing normalized service. */
  async changeOrigin(epoch: number, input: string): Promise<SnapshotResult> {
    if (this.disposed || epoch !== this.state.epoch) return failure('stale');
    if (this.retiring) return failure('conflict');
    const origin = parseMetaprojectOrigin(input, this.options.allowLoopback);
    if (!origin) return failure('invalid-origin');
    return origin === this.state.origin ? ok(this.state) : this.forgetSession(undefined, origin);
  }

  /** Return the owned API instance only for the calling epoch. */
  client(epoch: number): LiveSession | null { return this.live?.epoch === epoch ? this.live : null; }

  /** Reject an authoritative expiry or identity mismatch only from the current lease. */
  expire(epoch: number): void {
    if (this.live?.epoch === epoch) void this.forgetSession('expired');
  }

  /** Retire ephemeral resources without revoking a valid remembered grant on exit. */
  dispose(): void { this.disposed = true; this.retire(); }

  private set(snapshot: MetaprojectSessionSnapshot): void {
    this.state = snapshot;
    if (!this.disposed) this.options.publish(snapshot);
  }

  private begin(phase: 'restoring' | 'signing-in', attemptId: string, origin: MetaprojectOrigin): Attempt {
    const attempt = { epoch: this.state.epoch + 1, origin, controller: new AbortController(), transport: this.options.transport(origin) };
    this.attempt = attempt;
    this.set({ ...this.scope(attempt.epoch), phase, attemptId });
    return attempt;
  }

  private scope(epoch = this.state.epoch): Pick<MetaprojectSessionSnapshot, 'epoch' | 'origin' | 'configuredOrigin'> {
    const { origin, configuredOrigin } = this.state;
    return { epoch, origin, configuredOrigin };
  }

  private owns(attempt: Attempt): boolean { return this.attempt === attempt && !this.disposed; }

  private async authenticate(attempt: Attempt, credentials: Credentials): Promise<AuthenticationResult> {
    const deadline = AbortSignal.timeout(15_000);
    const result = await attempt.transport.authenticate(credentials, AbortSignal.any([deadline, attempt.controller.signal]));
    return deadline.aborted ? failure('network') : result;
  }

  private activate(attempt: Attempt, actor: MetaprojectActor, remembered: boolean, warning?: PersistenceWarning): SnapshotResult {
    const epoch = attempt.epoch;
    const client = attempt.transport.client({
      actor, signal: attempt.controller.signal,
      changed: connected => {
        if (this.live?.epoch === epoch && this.state.phase === 'signed-in') this.set({ ...this.state, connected });
      },
      rejected: () => this.expire(epoch),
      forward: (event, payload) => { if (this.live?.epoch === epoch) this.options.chat(epoch, event, payload); },
    });
    this.live = { ...attempt, client };
    this.attempt = null;
    this.set({ ...this.scope(), phase: 'signed-in', actor, remembered, connected: false, ...(warning ? { warning } : {}) });
    client.start();
    return ok(this.state);
  }

  private grantFor(origin: MetaprojectOrigin): RememberedGrant | null {
    try { return this.options.account.current(origin); }
    catch { return null; }
  }

  private async restore(): Promise<SnapshotResult> {
    const { origin } = this.state;
    if (!origin) return failure('invalid-origin');
    const grant = this.grantFor(origin);
    if (!grant) return ok(this.state);
    const attempt = this.begin('restoring', randomUUID(), origin);
    let credentials: Credentials | null;
    try { credentials = await this.options.account.credentials(grant); }
    catch { return this.owns(attempt) ? this.abortAttempt('unavailable', true) : failure('stale'); }
    if (!this.owns(attempt)) return failure('stale');
    const result = credentials ? await this.authenticate(attempt, credentials) : failure('rejected');
    return this.finishRestore(attempt, grant, result);
  }

  private async finishRestore(attempt: Attempt, grant: RememberedGrant, result: AuthenticationResult): Promise<SnapshotResult> {
    if (!this.owns(attempt)) return failure('stale');
    if (result.ok && result.value.id === grant.actorId && this.grantFor(grant.origin)?.grantId === grant.grantId) {
      return this.activate(attempt, result.value, true);
    }
    if (result.ok && result.value.id === grant.actorId) return this.abortAttempt('stale');
    if (result.ok || result.reason === 'rejected') {
      await this.forgetSession('rejected');
      return failure('rejected');
    }
    if (result.reason === 'throttled') this.applyLoginDelay(result);
    return this.abortAttempt(result.reason, true);
  }

  private applyLoginDelay(result: Extract<AuthenticationResult, { ok: false }>): void {
    const throttledDelay = 'retryAfterMs' in result ? result.retryAfterMs : 30_000;
    this.loginAfter = Date.now() + (result.reason === 'throttled' ? throttledDelay : 750);
  }

  private abortAttempt(reason: MetaprojectFailure, retryRestore = false, warning?: PersistenceWarning): SnapshotResult {
    this.retire(reason, retryRestore, warning);
    return failure(reason);
  }

  private retire(reason?: MetaprojectFailure, retryRestore = false, warning?: PersistenceWarning, logout = false): void {
    const live = this.live;
    const retiring = live ?? this.attempt;
    this.live = null;
    this.attempt = null;
    retiring?.controller.abort();
    this.set({ ...this.scope(this.state.epoch + 1), phase: 'signed-out', ...(reason ? { reason } : {}), ...(retryRestore ? { retryRestore } : {}), ...(warning ? { warning } : {}) });
    void retiring?.transport.retire(logout && live !== null).catch(() => undefined);
  }

  private async forgetSession(reason?: MetaprojectFailure, switchTo?: MetaprojectOrigin): Promise<SnapshotResult> {
    this.retiring = true;
    this.started = true;
    this.retire(reason, false, undefined, true);
    const epoch = this.state.epoch;
    const [forgotten, legacy] = await Promise.all([this.options.account.forget(switchTo), this.options.account.clearLegacy()]);
    this.retiring = false;
    if (this.disposed || this.state.epoch !== epoch) return failure('stale');
    const warning = forgotten.warning ?? (legacy ? undefined : 'keychain-not-cleared');
    const scope = switchTo && forgotten.committed ? { epoch, origin: switchTo, configuredOrigin: switchTo } : this.scope();
    if (switchTo && forgotten.committed) this.loginAfter = 0;
    this.set({ ...scope, phase: 'signed-out', ...(reason ? { reason } : {}), ...(warning ? { warning } : {}) });
    return switchTo && !forgotten.committed ? failure('unavailable') : ok(this.state);
  }
}
