/**
 * Viewer-side upload client (docs/specs/remote-clipboard.md AC-U2..U5, AC-U12, AC-I5, AC-D2, AC-D6).
 * Runs in the viewer's main process: it validates the renderer's request, resolves the bytes
 * (renderer-supplied, a Files-tree file read here, or the clipboard PNG read in memory, never
 * staged locally), then drives `drops.uploadBegin` → ordered `drops.uploadChunk` → `drops.uploadCommit`
 * on the host, one chunk in flight. Begin goes first so an old host answers `unknown_method`
 * before any byte is read or sent. Every outcome is an `UploadResult` value; `upload` never rejects.
 */
import { readFile } from 'node:fs/promises';
import { pathStyleFor } from '../../shared/shell-escape';
import { RpcMethods, type Params, type Result } from '../../shared/p2p-contract';
import { locateAppFile, type LocatedAppFile } from '../drops/handlers';
import type { Services } from '../services';
import type { UploadKind } from '../drops/staging';
import {
  MAX_STAGED_BYTES,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_CONFIRM_ABOVE_BYTES,
  type UploadProgressEvent,
  type UploadRequest,
  type UploadResult,
} from '../../shared/remote-upload-contract';

export type UploadMethod = 'drops.uploadBegin' | 'drops.uploadChunk' | 'drops.uploadCommit' | 'drops.uploadAbort';

export interface UploadClientDeps {
  /** One RPC call on the device's link; rejects with an error carrying the RPC `code`. */
  call<M extends UploadMethod>(deviceId: string, method: M, params: Params<M>): Promise<Result<M>>;
  locateAppFile(payload: { projectId: number; relPath: string }): Promise<LocatedAppFile>;
  readFile(path: string): Promise<Uint8Array>;
  /** PNG bytes of the viewer clipboard image, or null when there is none. */
  readClipboardPng(): Uint8Array | null;
  emitProgress(event: UploadProgressEvent): void;
  /** Monotonic-enough milliseconds, for the progress throttle. */
  now(): number;
}

export interface UploadClient {
  upload(req: UploadRequest): Promise<UploadResult>;
  /** Stops the upload between chunks and aborts it on the host; no-op for an unknown id. */
  cancel(uploadId: string): void;
}

const PROGRESS_INTERVAL_MS = 100;
const MAX_ID_CHARS = 128;
const MAX_NAME_CHARS = 1024;
const MAX_MIME_CHARS = 255;
const CANCELLED = Symbol('cancelled');

interface Prepared {
  readonly name: string;
  readonly mime: string;
  readonly kind: UploadKind;
  readonly size: number;
  load(): Promise<Uint8Array>;
}

interface Active {
  cancelled: boolean;
  readonly signal: Promise<typeof CANCELLED>;
  fire(): void;
}

/** Narrows an untrusted value to a readable record. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** True for a string of at most `max` characters. */
function isShortString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length <= max;
}

/** True when `src` is one of the three `UploadSource` shapes within the field limits; there is no path source (B-S8). */
function isSource(src: unknown): boolean {
  if (!isRecord(src)) return false;
  if (src.kind === 'clipboard-image') return true;
  if (src.kind === 'app-file') return Number.isInteger(src.projectId) && typeof src.relPath === 'string';
  return src.kind === 'bytes' && isShortString(src.name, MAX_NAME_CHARS) && isShortString(src.mime, MAX_MIME_CHARS) && src.bytes instanceof Uint8Array;
}

/** True when `req` is a well-formed upload request from the renderer. */
function isUploadRequest(req: unknown): req is UploadRequest {
  return isRecord(req) && isShortString(req.uploadId, MAX_ID_CHARS) && typeof req.deviceId === 'string' && isSource(req.source);
}

/** Human-readable message of any thrown value. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Host and link error codes with a dedicated result; any other code is `failed` with the code as reason. */
const RESULT_BY_CODE: Readonly<Record<string, UploadResult>> = {
  unknown_method: { kind: 'unsupported-host' },
  upload_too_large: { kind: 'too-large', limitBytes: MAX_STAGED_BYTES },
  drop_folder_full: { kind: 'refused', reason: 'drop-folder-full' },
  too_many_uploads: { kind: 'refused', reason: 'too-many-uploads' },
  closed: { kind: 'link-lost' },
  request_timeout: { kind: 'link-lost' },
};

/** Maps a thrown RPC or local error to the result the renderer shows. */
export function resultForError(err: unknown): UploadResult {
  const code = isRecord(err) && typeof err.code === 'string' ? err.code : undefined;
  if (code === undefined) return { kind: 'failed', reason: messageOf(err) };
  return Object.hasOwn(RESULT_BY_CODE, code) ? RESULT_BY_CODE[code]! : { kind: 'failed', reason: code };
}

/** Resolves the source to a name, size and lazy loader, or to an early result. */
async function prepare(src: UploadRequest['source'], deps: UploadClientDeps): Promise<Prepared | UploadResult> {
  if (src.kind === 'bytes') {
    return { name: src.name, mime: src.mime, kind: 'file', size: src.bytes.byteLength, load: async () => src.bytes };
  }
  if (src.kind === 'clipboard-image') {
    const png = deps.readClipboardPng();
    if (png === null) return { kind: 'no-image' };
    return { name: 'pasted.png', mime: 'image/png', kind: 'clipboard-image', size: png.byteLength, load: async () => png };
  }
  const located = await deps.locateAppFile({ projectId: src.projectId, relPath: src.relPath });
  if (located.kind === 'failed') return located;
  if (located.isDirectory) return { kind: 'failed', reason: 'is a directory' };
  return { name: located.name, mime: '', kind: 'file', size: located.size, load: () => deps.readFile(located.path) };
}

/** Size gates that need no host: the 50 MB limit (AC-U5) and the clipboard-image confirm (decision Q2). */
function gate(p: Prepared, req: UploadRequest): UploadResult | null {
  if (p.size > MAX_STAGED_BYTES) return { kind: 'too-large', limitBytes: MAX_STAGED_BYTES };
  const askFirst = p.kind === 'clipboard-image' && req.confirmed !== true && p.size > UPLOAD_CONFIRM_ABOVE_BYTES;
  return askFirst ? { kind: 'needs-confirm', size: p.size } : null;
}

/** A fresh cancellation handle whose `signal` settles once `fire` is called. */
function newActive(): Active {
  let fire!: () => void;
  const signal = new Promise<typeof CANCELLED>((resolve) => { fire = () => resolve(CANCELLED); });
  const active: Active = { cancelled: false, signal, fire: () => { active.cancelled = true; fire(); } };
  return active;
}

/** One transfer in progress: the renderer request, its cancellation handle and the host's upload id. */
interface Transfer {
  readonly req: UploadRequest;
  readonly a: Active;
  readonly hostId: string;
}

/** Awaits `p` unless the upload is cancelled first, in which case it throws `CANCELLED`. */
async function step<T>(a: Active, p: Promise<T>): Promise<T> {
  p.catch(() => undefined);
  const r = await Promise.race([p, a.signal]);
  if (r === CANCELLED) throw CANCELLED;
  return r as T;
}

/** Calls a host method whose reply the viewer acts on and checks it against the method's result schema (L4). */
async function callChecked<M extends 'drops.uploadBegin' | 'drops.uploadCommit'>(
  deps: UploadClientDeps,
  deviceId: string,
  method: M,
  params: Params<M>,
): Promise<Result<M>> {
  const parsed = RpcMethods[method].result.safeParse(await deps.call(deviceId, method, params));
  if (!parsed.success) throw new Error(`host sent an invalid ${method} reply`);
  return parsed.data as Result<M>;
}

/** Fire-and-forget host abort; the host's idle timeout backstops a lost one. */
function abortQuietly(deps: UploadClientDeps, deviceId: string, uploadId: string): void {
  deps.call(deviceId, 'drops.uploadAbort', { uploadId }).catch(() => undefined);
}

/** Sends `bytes` in ordered chunks, one in flight, emitting throttled progress. */
async function sendChunks(deps: UploadClientDeps, t: Transfer, bytes: Uint8Array, chunkBytes: number): Promise<void> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let lastEmit = Number.NEGATIVE_INFINITY;
  for (let offset = 0; offset < buf.byteLength; offset += chunkBytes) {
    if (t.a.cancelled) throw CANCELLED;
    const data = buf.subarray(offset, offset + chunkBytes).toString('base64');
    await step(t.a, deps.call(t.req.deviceId, 'drops.uploadChunk', { uploadId: t.hostId, offset, data }));
    const sentBytes = Math.min(offset + chunkBytes, buf.byteLength);
    const now = deps.now();
    if (now - lastEmit < PROGRESS_INTERVAL_MS && sentBytes < buf.byteLength) continue;
    lastEmit = now;
    deps.emitProgress({ uploadId: t.req.uploadId, sentBytes, totalBytes: buf.byteLength });
  }
}

/** Begin, chunks and commit for a prepared upload; any failure aborts the host side unless the link is gone. */
async function transfer(deps: UploadClientDeps, req: UploadRequest, a: Active, p: Prepared): Promise<UploadResult> {
  const beginP = callChecked(deps, req.deviceId, 'drops.uploadBegin', { name: p.name, mime: p.mime, size: p.size, kind: p.kind });
  let hostId: string | undefined;
  try {
    const begun = await step(a, beginP);
    hostId = begun.uploadId;
    const bytes = await step(a, p.load());
    if (bytes.byteLength !== p.size) throw new Error('file changed while reading');
    await sendChunks(deps, { req, a, hostId }, bytes, Math.min(begun.chunkBytes, UPLOAD_CHUNK_BYTES));
    const { path, platform } = await step(a, callChecked(deps, req.deviceId, 'drops.uploadCommit', { uploadId: hostId }));
    return { kind: 'staged', path, style: pathStyleFor(platform) };
  } catch (err) {
    const result = err === CANCELLED ? ({ kind: 'cancelled' } as const) : resultForError(err);
    if (hostId !== undefined && result.kind !== 'link-lost') abortQuietly(deps, req.deviceId, hostId);
    if (hostId === undefined && err === CANCELLED) beginP.then((r) => abortQuietly(deps, req.deviceId, r.uploadId), () => undefined);
    return result;
  }
}

/** Prepares, gates and transfers one request. */
async function run(deps: UploadClientDeps, req: UploadRequest, a: Active): Promise<UploadResult> {
  const prepared = await prepare(req.source, deps);
  if (!('load' in prepared)) return prepared;
  return gate(prepared, req) ?? (await transfer(deps, req, a, prepared));
}

/** See `UploadClient.upload`; `active` holds the cancellation handle of every upload in progress. */
async function upload(deps: UploadClientDeps, active: Map<string, Active>, req: UploadRequest): Promise<UploadResult> {
  if (!isUploadRequest(req)) return { kind: 'failed', reason: 'invalid request' };
  if (active.has(req.uploadId)) return { kind: 'failed', reason: 'upload id already in use' };
  const a = newActive();
  active.set(req.uploadId, a);
  try {
    return await run(deps, req, a);
  } catch (err) {
    return { kind: 'failed', reason: messageOf(err) };
  } finally {
    active.delete(req.uploadId);
  }
}

/** Builds the upload client over `deps`. */
export function createUploadClient(deps: UploadClientDeps): UploadClient {
  const active = new Map<string, Active>();
  return { upload: (req) => upload(deps, active, req), cancel: (uploadId) => active.get(uploadId)?.fire() };
}

/**
 * Production deps over the viewer's services: Files-tree files are located with the
 * drop containment rules and read from disk, and the clipboard PNG is read in memory.
 */
export function uploadClientDeps(
  services: Pick<Services, 'projects' | 'clipboardImage'>,
  call: UploadClientDeps['call'],
  emitProgress: UploadClientDeps['emitProgress'],
): UploadClientDeps {
  return {
    call,
    locateAppFile: (payload) => locateAppFile(services, payload),
    readFile: (path) => readFile(path),
    readClipboardPng: () => services.clipboardImage.readPng(),
    emitProgress,
    now: () => Date.now(),
  };
}
