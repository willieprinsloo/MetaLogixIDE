/**
 * Host-side upload service for one P2P link (docs/specs/remote-clipboard.md AC-U1, AC-U5..U9).
 * A paired viewer begins an upload, sends it in ordered base64 chunks that are appended to a
 * temp file in the drop folder, then commits or aborts it. Sessions live in this instance only,
 * so an upload id is meaningless on any other link (B-S2). Refusals throw `RpcError` with an
 * `UploadRpcErrorCode` the viewer maps to a toast; staging failures throw a plain `Error`, which
 * the RPC layer reports to the peer as a generic `handler_error`. Every session that opened ends
 * in exactly one `onOutcome` call, for the audit log.
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

export interface UploadServiceOptions {
  readonly staging: Pick<DropStaging, 'openUpload' | 'usageBytes' | 'pruneOlderThan'>;
  /** This host's `process.platform`, returned on commit so the viewer escapes for this shell (AC-U2). */
  readonly platform: string;
  readonly onOutcome: (outcome: UploadOutcome) => void;
  /** Test knob; defaults to `MAX_STAGING_TOTAL_BYTES`. */
  readonly maxTotalBytes?: number;
}

export interface UploadService {
  begin(p: Params<'drops.uploadBegin'>): Promise<Result<'drops.uploadBegin'>>;
  chunk(p: Params<'drops.uploadChunk'>): Promise<Result<'drops.uploadChunk'>>;
  commit(p: Params<'drops.uploadCommit'>): Promise<Result<'drops.uploadCommit'>>;
  abort(p: Params<'drops.uploadAbort'>): Promise<Result<'drops.uploadAbort'>>;
  /** Aborts every upload and refuses new ones; called when the link closes. */
  disposeAll(): Promise<void>;
}

interface Session {
  readonly auditName: string;
  readonly name: string;
  readonly mime: string;
  readonly kind: UploadKind;
  readonly size: number;
  readonly sink: UploadSink;
  received: number;
  tail: Promise<void>;
  timer: NodeJS.Timeout | null;
}

/** An `RpcError` carrying one of the upload refusal codes. */
function refusal(code: UploadRpcErrorCode | 'closed' | 'invalid_params', message: string): RpcError {
  return new RpcError(code, message);
}

/** Builds the upload service for one link. */
export function createUploadService(opts: UploadServiceOptions): UploadService {
  const sessions = new Map<string, Session>();
  const maxTotal = opts.maxTotalBytes ?? MAX_STAGING_TOTAL_BYTES;
  let opening = 0;
  let disposed = false;

  const reservedBytes = (): number =>
    [...sessions.values()].reduce((sum, s) => sum + (s.size - s.received), 0);

  function take(uploadId: string): Session {
    const s = sessions.get(uploadId);
    if (!s) throw refusal('upload_unknown', 'no such upload');
    return s;
  }

  function release(id: string, s: Session): void {
    if (s.timer) clearTimeout(s.timer);
    sessions.delete(id);
  }

  async function end(id: string, s: Session, reason: AbortReason): Promise<void> {
    release(id, s);
    await s.tail.catch(() => undefined);
    await s.sink.abort();
    opts.onOutcome({ name: s.auditName, size: s.size, outcome: `aborted:${reason}` });
  }

  function armIdle(id: string, s: Session): void {
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => void end(id, s, 'idle'), UPLOAD_IDLE_TIMEOUT_MS);
    s.timer.unref?.();
  }

  async function fits(size: number): Promise<boolean> {
    const over = async (): Promise<boolean> => (await opts.staging.usageBytes()) + reservedBytes() + size > maxTotal;
    if (!(await over())) return true;
    await opts.staging.pruneOlderThan(DROP_MAX_AGE_MS);
    return !(await over());
  }

  async function openSink(size: number): Promise<UploadSink> {
    if (!(await fits(size))) throw refusal('drop_folder_full', 'drop folder is full');
    const opened = await opts.staging.openUpload();
    if (opened.kind === 'failed') throw new Error(opened.reason);
    if (!disposed) return opened.sink;
    await opened.sink.abort();
    throw refusal('closed', 'link closed');
  }

  async function begin(p: Params<'drops.uploadBegin'>): Promise<Result<'drops.uploadBegin'>> {
    if (disposed) throw refusal('closed', 'link closed');
    if (p.size > MAX_STAGED_BYTES) throw refusal('upload_too_large', `upload exceeds ${MAX_STAGED_BYTES} bytes`);
    if (sessions.size + opening >= MAX_UPLOADS_PER_PEER) throw refusal('too_many_uploads', 'too many uploads in progress');
    opening += 1;
    let sink: UploadSink;
    try {
      sink = await openSink(p.size);
    } finally {
      opening -= 1;
    }
    const id = randomUUID();
    const auditName = safeFileName(p.name, p.mime, new Date(), opts.platform);
    const s: Session = { auditName, name: p.name, mime: p.mime, kind: p.kind, size: p.size, sink, received: 0, tail: Promise.resolve(), timer: null };
    sessions.set(id, s);
    armIdle(id, s);
    return { uploadId: id, chunkBytes: UPLOAD_CHUNK_BYTES };
  }

  async function chunk(p: Params<'drops.uploadChunk'>): Promise<Result<'drops.uploadChunk'>> {
    const s = take(p.uploadId);
    const fail = async (reason: AbortReason, err: Error): Promise<never> => {
      await end(p.uploadId, s, reason);
      throw err;
    };
    if (p.offset !== s.received) return fail('offset', refusal('upload_offset', `expected offset ${s.received}`));
    if (!BASE64.test(p.data)) return fail('failed', refusal('invalid_params', 'data is not base64'));
    const bytes = Buffer.from(p.data, 'base64');
    if (s.received + bytes.byteLength > s.size) return fail('overrun', refusal('upload_overrun', 'more bytes than declared'));
    // Claimed before the await so a concurrent chunk for the same offset is refused, not interleaved.
    s.received += bytes.byteLength;
    armIdle(p.uploadId, s);
    const write = s.tail.then(() => s.sink.append(bytes));
    s.tail = write;
    try {
      await write;
    } catch (err) {
      return fail('failed', err instanceof Error ? err : new Error(String(err)));
    }
    return { received: s.received };
  }

  async function commit(p: Params<'drops.uploadCommit'>): Promise<Result<'drops.uploadCommit'>> {
    const s = take(p.uploadId);
    if (s.received !== s.size) {
      await end(p.uploadId, s, 'incomplete');
      throw refusal('upload_incomplete', `received ${s.received} of ${s.size} bytes`);
    }
    release(p.uploadId, s);
    await s.tail;
    const staged = await s.sink.commit(s.name, s.mime, s.kind);
    if (staged.kind !== 'staged') {
      opts.onOutcome({ name: s.auditName, size: s.size, outcome: 'aborted:failed' });
      throw new Error(staged.kind === 'failed' ? staged.reason : staged.kind);
    }
    opts.onOutcome({ name: basename(staged.path), size: s.size, outcome: 'staged' });
    return { path: staged.path, platform: opts.platform };
  }

  async function abort(p: Params<'drops.uploadAbort'>): Promise<Result<'drops.uploadAbort'>> {
    const s = sessions.get(p.uploadId);
    if (s) await end(p.uploadId, s, 'cancelled');
    return { ok: true };
  }

  async function disposeAll(): Promise<void> {
    disposed = true;
    await Promise.all([...sessions].map(([id, s]) => end(id, s, 'link-closed')));
  }

  return { begin, chunk, commit, abort, disposeAll };
}
