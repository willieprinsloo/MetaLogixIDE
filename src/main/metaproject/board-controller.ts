/** Owns the Board context lease and main-derived destinations. */
import { randomUUID } from 'node:crypto';
import type { MetaprojectBoardState, MetaprojectExternalCandidate, MetaprojectFailure, MetaprojectOrigin, MetaprojectResult, ValidMetaprojectRequest } from '@shared/metaproject-contract';
import type { AssignmentService } from './assignment-service';
import { failure, failureReason, ok, type SessionService } from './session-service';
import type { BoardGuest, GuestEvents } from './board-view';

type Open = ValidMetaprojectRequest<'metaproject:board-open'>;
type Target = ValidMetaprojectRequest<'metaproject:board-browser'>;
export type Bounds = NonNullable<ValidMetaprojectRequest<'metaproject:board-layout'>['bounds']>;
type Live = NonNullable<ReturnType<SessionService['client']>>;
type Phase = { phase: 'ready' | 'loading' } | { phase: 'error'; reason: MetaprojectFailure };
interface Lease {
  context: Open;
  ownerId: number;
  bounds: Bounds | null;
  attached: boolean;
  guest: BoardGuest | null;
  phase: Phase;
  candidate: { url: string; id: string; expires: number } | null;
}
interface BoardOptions {
  assignments: Pick<AssignmentService, 'get'>;
  session: Pick<SessionService, 'snapshot' | 'client' | 'expire' | 'logout'>;
  guest(ownerId: number, live: Live, events: GuestEvents): BoardGuest;
  openExternal(url: string): Promise<void>;
  state(event: MetaprojectBoardState): void;
  candidate(event: MetaprojectExternalCandidate): void;
  returnFocus(viewId: string): void;
}

/** Round inward and clip to the owning native content rectangle in DIPs. */
export function clampBoardBounds(rect: Bounds, content: Pick<Bounds, 'width' | 'height'>): Bounds | null {
  const x = Math.ceil(Math.max(0, rect.x));
  const y = Math.ceil(Math.max(0, rect.y));
  const width = Math.floor(Math.min(content.width, rect.x + rect.width)) - x;
  const height = Math.floor(Math.min(content.height, rect.y + rect.height)) - y;
  return width > 0 && height > 0 && Number.isSafeInteger(width) && Number.isSafeInteger(height) ? { x, y, width, height } : null;
}

/** Drop credentials, search and fragment before storing a bounded cross-site launch candidate. */
export function safeExternalCandidate(raw: string): string | null {
  if (raw.length > 2048) return null;
  const url = URL.parse(raw);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  return `${url.origin}${url.pathname}`;
}

/** One owner and one view generation; temporary null bounds never retire the view. */
export class BoardController {
  private lease: Lease | null = null;

  constructor(private readonly options: BoardOptions) {}

  /** Drop the current view before publishing an auth/project/window transition. */
  drop(projectId?: number): void {
    const lease = this.lease;
    if (!lease || (projectId !== undefined && lease.context.projectId !== projectId)) return;
    this.lease = null;
    lease.guest?.close();
  }

  /** Invalidate views whose session was replaced or signed out. */
  invalidate(epoch: number): void {
    if (this.lease?.context.epoch !== epoch) this.drop();
  }

  /** Check an existing lease when the IDE rescans or changes registered roots. */
  projectAuthorityChanged(): void {
    if (this.lease) this.revalidate(this.lease);
  }

  /** Preflight current access before constructing the top-level guest. */
  async open(context: Open, ownerId: number): Promise<MetaprojectResult<MetaprojectBoardState>> {
    const target = this.target(context);
    if (!target.ok) return target;
    const live = this.options.session.client(context.epoch);
    if (!live) return failure(this.options.session.snapshot().epoch === context.epoch ? 'signed-out' : 'stale');
    this.drop();
    const lease: Lease = { context, ownerId, bounds: null, attached: false, guest: null, phase: { phase: 'loading' }, candidate: null };
    this.lease = lease;
    this.options.state(this.state(lease));
    try {
      await live.client.checkProject(target.value.remoteId);
      if (!this.current(lease, live)) return this.superseded(lease);
      const checked = this.target(context);
      if (!checked.ok) return ok(this.update(lease, { phase: 'error', reason: checked.reason }));
      return await this.loadGuest(lease, live, checked.value);
    } catch (error) {
      if (this.lease !== lease) return failure('stale');
      const reason = failureReason(error);
      return ok(this.update(lease, { phase: 'error', reason }));
    }
  }

  /** Hide or clip this view, without affecting an unrelated or superseded lease. */
  layout(ownerId: number, viewId: string, bounds: Bounds | null): MetaprojectResult<undefined> {
    const lease = this.match(ownerId, viewId);
    if (!lease) return failure('stale');
    lease.bounds = bounds;
    let result: MetaprojectResult<undefined> = ok(undefined);
    this.layoutGuest(lease, () => { result = this.revalidate(lease); return result.ok; });
    return result;
  }

  /** Focus only the attached, current guest. */
  focus(ownerId: number, viewId: string): MetaprojectResult<undefined> {
    const lease = this.match(ownerId, viewId);
    if (!lease?.attached) return failure('stale');
    const authority = this.revalidate(lease);
    if (!authority.ok) return authority;
    return lease.guest?.focus() ? ok(undefined) : failure('stale');
  }

  /** Release this exact lease even if preflight or load is pending. */
  close(ownerId: number, viewId: string): MetaprojectResult<undefined> {
    if (!this.match(ownerId, viewId)) return failure('stale');
    this.drop();
    return ok(undefined);
  }

  /** Open the canonical linked project in the separate default browser, including while signed out. */
  async browser(context: Target): Promise<MetaprojectResult<undefined>> {
    const target = this.target(context);
    return target.ok ? this.launch(this.url(target.value.origin, target.value.remoteId)) : target;
  }

  /** Consume a fresh, main-issued external candidate once, with no renderer-supplied URL. */
  async external(ownerId: number, viewId: string, candidateId: string): Promise<MetaprojectResult<undefined>> {
    const lease = this.match(ownerId, viewId);
    const candidate = lease?.candidate;
    if (!lease || !candidate || candidate.id !== candidateId || candidate.expires < Date.now()) return failure('stale');
    lease.candidate = null;
    if (!this.options.session.client(lease.context.epoch) || !this.target(lease.context).ok) return failure('stale');
    return this.launch(candidate.url);
  }

  /** Clear only the matching offer; the renderer controls focus and subsequent layout. */
  dismissExternal(ownerId: number, viewId: string, candidateId: string): MetaprojectResult<undefined> {
    const lease = this.match(ownerId, viewId);
    if (!lease || lease.candidate?.id !== candidateId) return failure('stale');
    lease.candidate = null;
    return ok(undefined);
  }

  private current(lease: Lease, live: Live): boolean {
    return this.lease === lease && this.options.session.client(lease.context.epoch) === live && lease.phase.phase === 'loading';
  }

  private superseded(lease: Lease): MetaprojectResult<MetaprojectBoardState> {
    return this.lease === lease && lease.phase.phase === 'error' ? ok(this.state(lease)) : failure('stale');
  }

  private async loadGuest(lease: Lease, live: Live, target: { origin: MetaprojectOrigin; remoteId: number }): Promise<MetaprojectResult<MetaprojectBoardState>> {
    lease.guest = this.options.guest(lease.ownerId, live, this.events(lease));
    const loaded = await lease.guest.load(this.url(target.origin, target.remoteId));
    if (!this.current(lease, live)) return this.superseded(lease);
    const checked = loaded.ok ? this.target(lease.context) : loaded;
    return ok(this.update(lease, checked.ok ? { phase: 'ready' } : { phase: 'error', reason: checked.reason }));
  }

  private revalidate(lease: Lease): MetaprojectResult<undefined> {
    if (lease.phase.phase === 'error') return failure(lease.phase.reason);
    const target = this.target(lease.context);
    if (target.ok) return ok(undefined);
    this.update(lease, { phase: 'error', reason: target.reason });
    return target;
  }

  private target(context: Target): MetaprojectResult<{ origin: MetaprojectOrigin; remoteId: Parameters<Live['client']['checkProject']>[0] }> {
    const result = this.options.assignments.get(context.projectId);
    if (!result.ok) return result;
    const assignment = result.value;
    if (assignment.kind === 'invalid') return failure('invalid-file');
    if (assignment.kind === 'origin-mismatch') return failure('origin-mismatch');
    if (assignment.kind !== 'linked') return failure('unavailable');
    if (assignment.revision !== context.revision) return failure('conflict');
    return ok(assignment);
  }

  private match(ownerId: number, viewId: string): Lease | null {
    return this.lease?.ownerId === ownerId && this.lease.context.viewId === viewId ? this.lease : null;
  }

  private events(lease: Lease): GuestEvents {
    return {
      expire: () => { if (this.lease === lease) this.options.session.expire(lease.context.epoch); },
      logout: () => { if (this.lease === lease) void this.options.session.logout(lease.context.epoch); },
      fail: reason => { if (this.lease === lease) this.update(lease, { phase: 'error', reason }); },
      candidate: raw => { if (this.lease === lease && lease.phase.phase === 'ready') this.offer(lease, raw); },
      returnFocus: () => { if (this.lease === lease) this.options.returnFocus(lease.context.viewId); },
    };
  }

  private offer(lease: Lease, raw: string): void {
    const url = safeExternalCandidate(raw);
    if (!url || (lease.candidate && lease.candidate.expires > Date.now())) return;
    const id = randomUUID();
    lease.candidate = { url, id, expires: Date.now() + 30_000 };
    this.layoutGuest(lease);
    this.options.candidate({ ...lease.context, candidateId: id, label: new URL(url).origin });
  }

  private state(lease: Lease): MetaprojectBoardState {
    const { phase } = lease;
    return phase.phase === 'error' ? { ...lease.context, ...phase } : { ...lease.context, phase: phase.phase };
  }

  private update(lease: Lease, phase: Phase): MetaprojectBoardState {
    if (phase.phase === 'error') { lease.guest?.close(); lease.guest = null; lease.candidate = null; }
    lease.phase = phase;
    this.layoutGuest(lease);
    const state = this.state(lease);
    this.options.state(state);
    return state;
  }

  private layoutGuest(lease: Lease, beforeAttach?: () => boolean): void {
    const bounds = lease.phase.phase === 'ready' && !lease.candidate ? lease.bounds : null;
    if (!lease.guest) { lease.attached = false; return; }
    lease.attached = beforeAttach ? lease.guest.layout(bounds, beforeAttach) : lease.guest.layout(bounds);
  }
  private url(origin: MetaprojectOrigin, remoteId: number): string { return `${origin}/projects/${remoteId}`; }
  private async launch(url: string): Promise<MetaprojectResult<undefined>> {
    try { await this.options.openExternal(url); return ok(undefined); }
    catch { return failure('unavailable'); }
  }
}
