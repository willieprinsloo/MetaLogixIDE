/**
 * Host-side upload service for one P2P link (docs/specs/remote-clipboard.md AC-U1, AC-U5..U9).
 * A paired viewer begins an upload, sends it in ordered base64 chunks that are appended to a
 * temp file in the drop folder, then commits or aborts it. Sessions live in this instance only,
 * so an upload id is meaningless on any other link (B-S2), while the size and concurrency caps
 * live in one host-wide `UploadQuota` shared by every link (AC-U8). Refusals throw `RpcError` with an
 * `UploadRpcErrorCode` the viewer maps to a toast; staging failures throw a plain `Error`, which
 * the RPC layer reports to the peer as a generic `handler_error`. Every session that opened ends
 * in one `onOutcome` call, for the audit log; a staged upload the viewer cancels just after
 * commit gets a second, `aborted:cancelled` record when its file is discarded.
 */
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { DROP_MAX_AGE_MS, type DropStaging, type UploadKind, type UploadSink } from '../drops/staging';
import { safeFileName } from '../drops/file-name';
import {
  MAX_STAGED_BYTES,
  MAX_STAGING_TOTAL_BYTES,
  MAX_UPLOADS_PER_PEER,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_IDLE_TIMEOUT_MS,
  type UploadRpcErrorCode,
} from '../../shared/remote-upload-contract';
import type { Params, Result } from '../../shared/p2p-contract';
import { RpcError } from './rpc';

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Why an opened upload ended without being staged. */
export type AbortReason = 'cancelled' | 'idle' | 'link-closed' | 'offset' | 'overrun' | 'incomplete' | 'failed';

/** One audit summary per opened upload; `name` is sanitised, never the raw peer-supplied name. */
export interface UploadOutcome {
  readonly name: string;
  readonly size: number;
  readonly outcome: 'staged' | `aborted:${AbortReason}`;
}

/** Bytes an open upload has claimed toward the folder total: `size - received` are still to come. */
export interface Reservation {
  readonly size: number;
  readonly received: number;
}

/**
 * Host-wide upload caps shared by every link's service (AC-U8): the bytes still owed by open
 * uploads on any link count toward the folder total, and active uploads are counted per remote
 * device across all of its links. Both checks are synchronous so concurrent begins cannot overshoot.
 */
export interface UploadQuota {
  /** Takes one of `deviceId`'s upload slots; false when it already has `MAX_UPLOADS_PER_PEER`. */
  claimSlot(deviceId: string): boolean;
  releaseSlot(deviceId: string): void;
  /** Adds `r` when `usageBytes` plus every reservation plus `r` stays within `maxTotal`; returns whether it did. */
  reserve(r: Reservation, usageBytes: number, maxTotal: number): boolean;
  unreserve(r: Reservation): void;
}

/** Builds the quota; the host creates exactly one and passes it to every link's upload service. */
export function createUploadQuota(): UploadQuota {
  const active = new Map<string, number>();
  const reserved = new Set<Reservation>();
  const owed = (r: Reservation): number => r.size - r.received;
  return {
    claimSlot(deviceId) {
      const n = active.get(deviceId) ?? 0;
      if (n >= MAX_UPLOADS_PER_PEER) return false;
      active.set(deviceId, n + 1);
      return true;
    },
    releaseSlot(deviceId) {
      const n = (active.get(deviceId) ?? 0) - 1;
      if (n > 0) active.set(deviceId, n);
      else active.delete(deviceId);
    },
    reserve(r, usageBytes, maxTotal) {
      const total = [...reserved].reduce((sum, x) => sum + owed(x), usageBytes);
      if (total + owed(r) > maxTotal) return false;
      reserved.add(r);
      return true;
    },
    unreserve: (r) => void reserved.delete(r),
  };
}

/** The slice of staging an upload service uses. */
export type UploadStaging = Pick<DropStaging, 'openUpload' | 'usageBytes' | 'pruneOlderThan'> &
  Partial<Pick<DropStaging, 'removeStaged'>>;

export interface UploadServiceOptions {
  /** `removeStaged` is optional only for doubles that never cancel a commit; production passes the real staging. */
  readonly staging: UploadStaging;
  /** This host's `process.platform`, returned on commit so the viewer escapes for this shell (AC-U2). */
  readonly platform: string;
  readonly onOutcome: (outcome: UploadOutcome) => void;
  /** Host-wide caps; defaults to a private quota, which is only right when this link is the whole host (tests). */
  readonly quota?: UploadQuota;
  /** The peer whose slots this link's uploads take; defaults to a single anonymous peer. */
  readonly remoteDeviceId?: string;
  /** Test knob; defaults to `MAX_STAGING_TOTAL_BYTES`. */
  readonly maxTotalBytes?: number;
}

export interface UploadService {
  begin(p: Params<'drops.uploadBegin'>): Promise<Result<'drops.uploadBegin'>>;
  chunk(p: Params<'drops.uploadChunk'>): Promise<Result<'drops.uploadChunk'>>;
  commit(p: Params<'drops.uploadCommit'>): Promise<Result<'drops.uploadCommit'>>;
  /** Discards an open upload, or the file of one committed within the last `UPLOAD_IDLE_TIMEOUT_MS`. */
  abort(p: Params<'drops.uploadAbort'>): Promise<Result<'drops.uploadAbort'>>;
  /** Aborts every upload, discards any commit still in flight, and refuses new ones; called when the link closes. */
  disposeAll(): Promise<void>;
}

interface Session {
  readonly auditName: string;
  readonly name: string;
  readonly mime: string;
  readonly kind: UploadKind;
  readonly sink: UploadSink;
  readonly ticket: { readonly size: number; received: number };
  tail: Promise<void>;
  timer: NodeJS.Timeout | null;
}

/** A commit in flight (`path` null) or just finished, kept so a late abort can still discard its file (AC-U6). */
interface Settled {
  readonly size: number;
  cancelled: boolean;
  path: string | null;
  timer: NodeJS.Timeout | null;
}

interface ServiceState {
  readonly opts: UploadServiceOptions;
  readonly quota: UploadQuota;
  readonly deviceId: string;
  readonly maxTotal: number;
  readonly sessions: Map<string, Session>;
  readonly settled: Map<string, Settled>;
  disposed: boolean;
}

/** An `RpcError` carrying one of the upload refusal codes. */
function refusal(code: UploadRpcErrorCode | 'closed' | 'invalid_params', message: string): RpcError {
  return new RpcError(code, message);
}

/** The open session for `uploadId`, or an `upload_unknown` refusal. */
function take(st: ServiceState, uploadId: string): Session {
  const s = st.sessions.get(uploadId);
  if (!s) throw refusal('upload_unknown', 'no such upload');
  return s;
}

/** Forgets the session and returns its slot and reservation; a second call for the same session is a no-op. */
function release(st: ServiceState, id: string, s: Session): void {
  if (s.timer) clearTimeout(s.timer);
  if (st.sessions.get(id) !== s) return;
  st.sessions.delete(id);
  st.quota.unreserve(s.ticket);
  st.quota.releaseSlot(st.deviceId);
}

/** Ends an open upload without staging it and records why. */
async function end(st: ServiceState, id: string, s: Session, reason: AbortReason): Promise<void> {
  release(st, id, s);
  await s.tail.catch(() => undefined);
  await s.sink.abort();
  st.opts.onOutcome({ name: s.auditName, size: s.ticket.size, outcome: `aborted:${reason}` });
}

/** (Re)starts the idle timer that aborts a silent upload. */
function armIdle(st: ServiceState, id: string, s: Session): void {
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => void end(st, id, s, 'idle'), UPLOAD_IDLE_TIMEOUT_MS);
  s.timer.unref?.();
}

/** Reserves `ticket` within the folder total, pruning stale files once before refusing (AC-U9). */
async function fits(st: ServiceState, ticket: Reservation): Promise<boolean> {
  if (st.quota.reserve(ticket, await st.opts.staging.usageBytes(), st.maxTotal)) return true;
  await st.opts.staging.pruneOlderThan(DROP_MAX_AGE_MS);
  return st.quota.reserve(ticket, await st.opts.staging.usageBytes(), st.maxTotal);
}

/** Reserves room and opens a temp-file sink, discarding it when the link closed meanwhile. */
async function openSink(st: ServiceState, ticket: Reservation): Promise<UploadSink> {
  if (!(await fits(st, ticket))) throw refusal('drop_folder_full', 'drop folder is full');
  const opened = await st.opts.staging.openUpload();
  if (opened.kind === 'failed') throw new Error(opened.reason);
  if (!st.disposed) return opened.sink;
  await opened.sink.abort();
  throw refusal('closed', 'link closed');
}

/** See `UploadService.begin`. */
async function begin(st: ServiceState, p: Params<'drops.uploadBegin'>): Promise<Result<'drops.uploadBegin'>> {
  if (st.disposed) throw refusal('closed', 'link closed');
  if (p.size > MAX_STAGED_BYTES) throw refusal('upload_too_large', `upload exceeds ${MAX_STAGED_BYTES} bytes`);
  if (!st.quota.claimSlot(st.deviceId)) throw refusal('too_many_uploads', 'too many uploads in progress');
  const ticket = { size: p.size, received: 0 };
  let sink: UploadSink;
  try {
    sink = await openSink(st, ticket);
  } catch (err) {
    st.quota.unreserve(ticket);
    st.quota.releaseSlot(st.deviceId);
    throw err;
  }
  const id = randomUUID();
  const auditName = safeFileName(p.name, p.mime, new Date(), st.opts.platform);
  const s: Session = { auditName, name: p.name, mime: p.mime, kind: p.kind, sink, ticket, tail: Promise.resolve(), timer: null };
  st.sessions.set(id, s);
  armIdle(st, id, s);
  return { uploadId: id, chunkBytes: UPLOAD_CHUNK_BYTES };
}

/** See `UploadService.chunk`. */
async function chunk(st: ServiceState, p: Params<'drops.uploadChunk'>): Promise<Result<'drops.uploadChunk'>> {
  const s = take(st, p.uploadId);
  const fail = async (reason: AbortReason, err: Error): Promise<never> => {
    await end(st, p.uploadId, s, reason);
    throw err;
  };
  const t = s.ticket;
  if (p.offset !== t.received) return fail('offset', refusal('upload_offset', `expected offset ${t.received}`));
  if (!BASE64.test(p.data)) return fail('failed', refusal('invalid_params', 'data is not base64'));
  const bytes = Buffer.from(p.data, 'base64');
  if (t.received + bytes.byteLength > t.size) return fail('overrun', refusal('upload_overrun', 'more bytes than declared'));
  // Claimed before the await so a concurrent chunk for the same offset is refused, not interleaved.
  t.received += bytes.byteLength;
  armIdle(st, p.uploadId, s);
  const write = s.tail.then(() => s.sink.append(bytes));
  s.tail = write;
  try {
    await write;
  } catch (err) {
    return fail('failed', err instanceof Error ? err : new Error(String(err)));
  }
  return { received: t.received };
}

/** Deletes a staged file the viewer will never type, then records why. */
async function discard(st: ServiceState, path: string, size: number, reason: AbortReason): Promise<void> {
  await st.opts.staging.removeStaged?.(path);
  st.opts.onOutcome({ name: basename(path), size, outcome: `aborted:${reason}` });
}

/** Finishes a staged commit: discards it when cancelled or the link closed meanwhile, else keeps it abortable briefly. */
async function settle(st: ServiceState, id: string, flight: Settled, path: string): Promise<Result<'drops.uploadCommit'>> {
  if (flight.cancelled || st.disposed) {
    st.settled.delete(id);
    await discard(st, path, flight.size, flight.cancelled ? 'cancelled' : 'link-closed');
    throw flight.cancelled ? refusal('upload_unknown', 'upload cancelled') : refusal('closed', 'link closed');
  }
  flight.path = path;
  flight.timer = setTimeout(() => st.settled.delete(id), UPLOAD_IDLE_TIMEOUT_MS);
  flight.timer.unref?.();
  st.opts.onOutcome({ name: basename(path), size: flight.size, outcome: 'staged' });
  return { path, platform: st.opts.platform };
}

/** See `UploadService.commit`. */
async function commit(st: ServiceState, p: Params<'drops.uploadCommit'>): Promise<Result<'drops.uploadCommit'>> {
  const s = take(st, p.uploadId);
  const { size, received } = s.ticket;
  if (received !== size) {
    await end(st, p.uploadId, s, 'incomplete');
    throw refusal('upload_incomplete', `received ${received} of ${size} bytes`);
  }
  release(st, p.uploadId, s);
  const flight: Settled = { size, cancelled: false, path: null, timer: null };
  st.settled.set(p.uploadId, flight);
  try {
    await s.tail;
    const staged = await s.sink.commit(s.name, s.mime, s.kind);
    if (staged.kind === 'staged') return await settle(st, p.uploadId, flight, staged.path);
    st.opts.onOutcome({ name: s.auditName, size, outcome: 'aborted:failed' });
    throw new Error(staged.kind === 'failed' ? staged.reason : staged.kind);
  } catch (err) {
    if (flight.path === null) st.settled.delete(p.uploadId);
    throw err;
  }
}

/** Cancels a commit in flight, or discards the file of one that just finished. */
async function cancelSettled(st: ServiceState, id: string): Promise<void> {
  const flight = st.settled.get(id);
  if (!flight) return;
  if (flight.path === null) {
    flight.cancelled = true;
    return;
  }
  st.settled.delete(id);
  if (flight.timer) clearTimeout(flight.timer);
  await discard(st, flight.path, flight.size, 'cancelled');
}

/** See `UploadService.abort`. */
async function abort(st: ServiceState, p: Params<'drops.uploadAbort'>): Promise<Result<'drops.uploadAbort'>> {
  const s = st.sessions.get(p.uploadId);
  if (s) await end(st, p.uploadId, s, 'cancelled');
  else await cancelSettled(st, p.uploadId);
  return { ok: true };
}

/** See `UploadService.disposeAll`. */
async function disposeAll(st: ServiceState): Promise<void> {
  st.disposed = true;
  for (const flight of st.settled.values()) if (flight.timer) clearTimeout(flight.timer);
  await Promise.all([...st.sessions].map(([id, s]) => end(st, id, s, 'link-closed')));
}

/** Builds the upload service for one link over the host-wide `opts.quota`. */
export function createUploadService(opts: UploadServiceOptions): UploadService {
  const st: ServiceState = {
    opts,
    quota: opts.quota ?? createUploadQuota(),
    deviceId: opts.remoteDeviceId ?? 'peer',
    maxTotal: opts.maxTotalBytes ?? MAX_STAGING_TOTAL_BYTES,
    sessions: new Map(),
    settled: new Map(),
    disposed: false,
  };
  return {
    begin: (p) => begin(st, p),
    chunk: (p) => chunk(st, p),
    commit: (p) => commit(st, p),
    abort: (p) => abort(st, p),
    disposeAll: () => disposeAll(st),
  };
}
