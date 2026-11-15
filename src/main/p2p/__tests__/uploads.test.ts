import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDropStaging, DROP_MAX_AGE_MS, type DropStaging, type UploadSink } from '../../drops/staging';
import { createUploadService, type UploadOutcome, type UploadService } from '../uploads';
import { RpcError } from '../rpc';
import {
  MAX_STAGED_BYTES,
  MAX_STAGING_TOTAL_BYTES,
  MAX_UPLOADS_PER_PEER,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_IDLE_TIMEOUT_MS,
} from '../../../shared/remote-upload-contract';

const posix = process.platform !== 'win32';
const b64 = (text: string): string => Buffer.from(text).toString('base64');

let root: string;
let dir: string;
let outcomes: UploadOutcome[];

function realStaging(): DropStaging {
  return createDropStaging({ dir, now: () => new Date(), uid: posix ? process.getuid!() : null });
}

function service(staging: Pick<DropStaging, 'openUpload' | 'usageBytes' | 'pruneOlderThan'> = realStaging()): UploadService {
  return createUploadService({ staging, platform: 'linux', onOutcome: (o) => outcomes.push(o) });
}

/** A staging double whose usage and prune are scripted; sinks record what they were asked to do. */
function fakeStaging(opts: { usage: number[]; pruneFrees?: boolean } = { usage: [0] }) {
  const sinks: { appended: number; aborted: boolean; committed: boolean }[] = [];
  let usageCall = 0;
  const staging = {
    openUpload: vi.fn(async () => {
      const rec = { appended: 0, aborted: false, committed: false };
      sinks.push(rec);
      const sink: UploadSink = {
        append: async (b) => { rec.appended += b.byteLength; },
        commit: async () => { rec.committed = true; return { kind: 'staged', path: '/staged/x' } as const; },
        abort: async () => { rec.aborted = true; },
      };
      return { kind: 'open', sink } as const;
    }),
    usageBytes: vi.fn(async () => opts.usage[Math.min(usageCall++, opts.usage.length - 1)]!),
    pruneOlderThan: vi.fn(async () => ({ removed: opts.pruneFrees ? 1 : 0, failed: 0 })),
  };
  return { staging, sinks };
}

async function rpcCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return err instanceof RpcError ? err.code : `non-rpc:${String(err)}`;
  }
  return 'resolved';
}

const begin = (svc: UploadService, size: number, name = 'a.txt', kind: 'file' | 'clipboard-image' = 'file') =>
  svc.begin({ name, mime: 'text/plain', size, kind });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uploads-'));
  dir = join(root, 'drops');
  outcomes = [];
});

afterEach(() => {
  vi.useRealTimers();
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
});

describe('begin', () => {
  test('returns an opaque id and the chunk size, and opens a sink', async () => {
    const { staging } = fakeStaging();
    const r = await begin(service(staging), 10);
    expect(r.uploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.chunkBytes).toBe(UPLOAD_CHUNK_BYTES);
    expect(staging.openUpload).toHaveBeenCalledTimes(1);
  });

  test('refuses a size over 50 MB with upload_too_large before opening any sink (AC-U5)', async () => {
    const { staging } = fakeStaging();
    expect(await rpcCode(begin(service(staging), MAX_STAGED_BYTES + 1))).toBe('upload_too_large');
    expect(staging.openUpload).not.toHaveBeenCalled();
    expect(staging.usageBytes).not.toHaveBeenCalled();
  });

  test('accepts exactly 50 MB', async () => {
    const { staging } = fakeStaging();
    await expect(begin(service(staging), MAX_STAGED_BYTES)).resolves.toBeDefined();
  });

  test('refuses the fifth concurrent upload with too_many_uploads, even when begun together (AC-U8)', async () => {
    const { staging } = fakeStaging();
    const svc = service(staging);
    const results = await Promise.allSettled(
      Array.from({ length: MAX_UPLOADS_PER_PEER + 1 }, () => begin(svc, 1)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX_UPLOADS_PER_PEER);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as RpcError).code).toBe('too_many_uploads');
    expect(staging.openUpload).toHaveBeenCalledTimes(MAX_UPLOADS_PER_PEER);
  });

  test('frees a slot once an upload finishes', async () => {
    const { staging } = fakeStaging();
    const svc = service(staging);
    const ids = await Promise.all(Array.from({ length: MAX_UPLOADS_PER_PEER }, () => begin(svc, 0)));
    await svc.commit({ uploadId: ids[0]!.uploadId });
    await expect(begin(svc, 0)).resolves.toBeDefined();
  });

  test('prunes stale files when the folder would exceed 500 MB, then refuses with drop_folder_full (AC-U8, AC-U9)', async () => {
    const { staging } = fakeStaging({ usage: [MAX_STAGING_TOTAL_BYTES - 5] });
    expect(await rpcCode(begin(service(staging), 10))).toBe('drop_folder_full');
    expect(staging.pruneOlderThan).toHaveBeenCalledWith(DROP_MAX_AGE_MS);
    expect(staging.openUpload).not.toHaveBeenCalled();
  });

  test('proceeds when the prune frees enough space (AC-U9)', async () => {
    const { staging } = fakeStaging({ usage: [MAX_STAGING_TOTAL_BYTES, 0], pruneFrees: true });
    await expect(begin(service(staging), 10)).resolves.toBeDefined();
    expect(staging.usageBytes).toHaveBeenCalledTimes(2);
  });

  test('does not prune when the upload fits exactly', async () => {
    const { staging } = fakeStaging({ usage: [MAX_STAGING_TOTAL_BYTES - 10] });
    await expect(begin(service(staging), 10)).resolves.toBeDefined();
    expect(staging.pruneOlderThan).not.toHaveBeenCalled();
  });

  test('counts bytes still to arrive for uploads in progress against the cap', async () => {
    const { staging } = fakeStaging({ usage: [0] });
    const svc = createUploadService({ staging, platform: 'linux', onOutcome: () => {}, maxTotalBytes: 100 });
    const { uploadId } = await begin(svc, 60);
    expect(await rpcCode(begin(svc, 41))).toBe('drop_folder_full');
    await svc.chunk({ uploadId, offset: 0, data: Buffer.alloc(30).toString('base64') });
    staging.usageBytes.mockResolvedValue(30);
    expect(await rpcCode(begin(svc, 41))).toBe('drop_folder_full');
    await expect(begin(svc, 40)).resolves.toBeDefined();
  });

  test('a staging that cannot open a sink fails the begin without leaking a slot', async () => {
    const { staging } = fakeStaging();
    staging.openUpload.mockResolvedValue({ kind: 'failed', reason: 'drop directory is a symlink' } as never);
    const svc = service(staging);
    for (let i = 0; i < MAX_UPLOADS_PER_PEER + 1; i++) expect(await rpcCode(begin(svc, 1))).toMatch(/^non-rpc:.*symlink/);
  });

  test('a usage read failure fails the begin without leaking a slot', async () => {
    const { staging } = fakeStaging();
    staging.usageBytes.mockRejectedValue(new Error('untrusted'));
    const svc = service(staging);
    for (let i = 0; i < MAX_UPLOADS_PER_PEER + 1; i++) expect(await rpcCode(begin(svc, 1))).toBe('non-rpc:Error: untrusted');
  });
});

describe('chunk', () => {
  test('appends in order and reports the running total', async () => {
    const { staging, sinks } = fakeStaging();
    const svc = service(staging);
    const { uploadId } = await begin(svc, 6);
    await expect(svc.chunk({ uploadId, offset: 0, data: b64('abc') })).resolves.toEqual({ received: 3 });
    await expect(svc.chunk({ uploadId, offset: 3, data: b64('def') })).resolves.toEqual({ received: 6 });
    expect(sinks[0]!.appended).toBe(6);
  });

  test('a wrong offset gives upload_offset and aborts the upload', async () => {
    const { staging, sinks } = fakeStaging();
    const svc = service(staging);
    const { uploadId } = await begin(svc, 6);
    expect(await rpcCode(svc.chunk({ uploadId, offset: 1, data: b64('abc') }))).toBe('upload_offset');
    expect(sinks[0]!.aborted).toBe(true);
    expect(await rpcCode(svc.chunk({ uploadId, offset: 0, data: b64('abc') }))).toBe('upload_unknown');
    expect(outcomes).toEqual([{ name: 'a.txt', size: 6, outcome: 'aborted:offset' }]);
  });

  test('two chunks racing for the same offset: the second is refused and the upload aborted', async () => {
    const { staging, sinks } = fakeStaging();
    const svc = service(staging);
    const { uploadId } = await begin(svc, 6);
    const [a, b] = await Promise.allSettled([
      svc.chunk({ uploadId, offset: 0, data: b64('abc') }),
      svc.chunk({ uploadId, offset: 0, data: b64('abc') }),
    ]);
    expect(a.status).toBe('fulfilled');
    expect(((b as PromiseRejectedResult).reason as RpcError).code).toBe('upload_offset');
    expect(sinks[0]!.aborted).toBe(true);
  });

  test('more bytes than declared gives upload_overrun and aborts (AC-U7)', async () => {
    const { staging, sinks } = fakeStaging();
    const svc = service(staging);
    const { uploadId } = await begin(svc, 4);
    await svc.chunk({ uploadId, offset: 0, data: b64('abc') });
    expect(await rpcCode(svc.chunk({ uploadId, offset: 3, data: b64('de') }))).toBe('upload_overrun');
    expect(sinks[0]!.appended).toBe(3);
    expect(sinks[0]!.aborted).toBe(true);
    expect(outcomes.at(-1)?.outcome).toBe('aborted:overrun');
  });

  test('data that is not base64 is refused as invalid_params and aborts', async () => {
    const { staging, sinks } = fakeStaging();
    const svc = service(staging);
    const { uploadId } = await begin(svc, 100);
    expect(await rpcCode(svc.chunk({ uploadId, offset: 0, data: 'not*base64!' }))).toBe('invalid_params');
    expect(sinks[0]!.appended).toBe(0);
    expect(sinks[0]!.aborted).toBe(true);
  });

  test('an unknown id gives upload_unknown', async () => {
    expect(await rpcCode(service(fakeStaging().staging).chunk({ uploadId: 'nope', offset: 0, data: '' }))).toBe('upload_unknown');
  });

  test('an id from another session gives upload_unknown and leaves that upload alone (B-S2)', async () => {
    const { staging, sinks } = fakeStaging();
    const a = service(staging);
    const b = service(staging);
    const { uploadId } = await begin(a, 3);
    expect(await rpcCode(b.chunk({ uploadId, offset: 0, data: b64('abc') }))).toBe('upload_unknown');
    expect(await rpcCode(b.commit({ uploadId }))).toBe('upload_unknown');
    await b.abort({ uploadId });
    expect(sinks[0]!.aborted).toBe(false);
    await expect(a.chunk({ uploadId, offset: 0, data: b64('abc') })).resolves.toEqual({ received: 3 });
  });

  test('a sink write failure aborts the upload and rejects', async () => {
    const { staging, sinks } = fakeStaging();
    staging.openUpload.mockImplementationOnce(async () => {
      const rec = { appended: 0, aborted: false, committed: false };
      sinks.push(rec);
      return {
        kind: 'open',
        sink: {
          append: async () => { throw new Error('ENOSPC'); },
          commit: async () => ({ kind: 'staged', path: '/x' }) as const,
          abort: async () => { rec.aborted = true; },
        },
      } as const;
    });
    const svc = service(staging);
    const { uploadId } = await begin(svc, 3);
    expect(await rpcCode(svc.chunk({ uploadId, offset: 0, data: b64('abc') }))).toBe('non-rpc:Error: ENOSPC');
    expect(sinks[0]!.aborted).toBe(true);
    expect(outcomes.at(-1)?.outcome).toBe('aborted:failed');
  });
});

describe('commit', () => {
  test('before every byte arrived gives upload_incomplete and aborts', async () => {
    const { staging, sinks } = fakeStaging();
    const svc = service(staging);
    const { uploadId } = await begin(svc, 6);
    await svc.chunk({ uploadId, offset: 0, data: b64('abc') });
    expect(await rpcCode(svc.commit({ uploadId }))).toBe('upload_incomplete');
    expect(sinks[0]!.aborted).toBe(true);
    expect(sinks[0]!.committed).toBe(false);
    expect(outcomes.at(-1)?.outcome).toBe('aborted:incomplete');
  });

  test('returns the staged path and the host platform (AC-U2)', async () => {
    const { staging } = fakeStaging();
    const svc = service(staging);
    const { uploadId } = await begin(svc, 0);
    await expect(svc.commit({ uploadId })).resolves.toEqual({ path: '/staged/x', platform: 'linux' });
    expect(outcomes).toEqual([{ name: 'x', size: 0, outcome: 'staged' }]);
  });

  test('a staging refusal at commit fails without leaking the session', async () => {
    const { staging } = fakeStaging();
    staging.openUpload.mockImplementationOnce(async () => ({
      kind: 'open',
      sink: {
        append: async () => {},
        commit: async () => ({ kind: 'failed', reason: 'drop directory became a symlink' }) as const,
        abort: async () => {},
      },
    }) as const);
    const svc = service(staging);
    const { uploadId } = await begin(svc, 0);
    expect(await rpcCode(svc.commit({ uploadId }))).toMatch(/^non-rpc:.*symlink/);
    expect(await rpcCode(svc.commit({ uploadId }))).toBe('upload_unknown');
    expect(outcomes.at(-1)?.outcome).toBe('aborted:failed');
  });

  test('end to end on real staging: the bytes land under the sanitised name, nothing else is left (AC-U1)', async () => {
    const svc = service();
    const { uploadId } = await begin(svc, 11, '../../etc/hello world.txt');
    await svc.chunk({ uploadId, offset: 0, data: b64('hello ') });
    await svc.chunk({ uploadId, offset: 6, data: b64('world') });
    const { path } = await svc.commit({ uploadId });
    expect(path).toBe(join(realStaging().dir, 'hello world.txt'));
    expect(readFileSync(path, 'utf8')).toBe('hello world');
    expect(readdirSync(dir)).toEqual(['hello world.txt']);
  });

  test('a zero-byte begin plus commit stages an empty file (AC-D10)', async () => {
    const svc = service();
    const { uploadId } = await begin(svc, 0, 'empty.txt');
    const { path } = await svc.commit({ uploadId });
    expect(readFileSync(path).byteLength).toBe(0);
  });

  test('a clipboard image is staged as pasted-<timestamp>.png', async () => {
    const svc = service();
    const { uploadId } = await begin(svc, 3, 'whatever.sh', 'clipboard-image');
    await svc.chunk({ uploadId, offset: 0, data: b64('png') });
    const { path } = await svc.commit({ uploadId });
    expect(path).toMatch(/pasted-\d{8}-\d{6}-\d{3}\.png$/);
  });
});

describe('abort, idle timeout and dispose (AC-U6)', () => {
  test('abort removes the partial file and leaves the directory unchanged', async () => {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    writeFileSync(join(dir, 'keep.txt'), 'k');
    const svc = service();
    const { uploadId } = await begin(svc, 6);
    await svc.chunk({ uploadId, offset: 0, data: b64('abc') });
    await expect(svc.abort({ uploadId })).resolves.toEqual({ ok: true });
    expect(readdirSync(dir)).toEqual(['keep.txt']);
    expect(outcomes.at(-1)?.outcome).toBe('aborted:cancelled');
  });

  test('abort of an unknown id is a harmless no-op', async () => {
    await expect(service(fakeStaging().staging).abort({ uploadId: 'gone' })).resolves.toEqual({ ok: true });
    expect(outcomes).toEqual([]);
  });

  test('an upload idle for 60 s is aborted; each chunk resets the timer', async () => {
    vi.useFakeTimers();
    const { staging, sinks } = fakeStaging();
    const svc = service(staging);
    const { uploadId } = await begin(svc, 6);
    await vi.advanceTimersByTimeAsync(UPLOAD_IDLE_TIMEOUT_MS - 1);
    await svc.chunk({ uploadId, offset: 0, data: b64('abc') });
    await vi.advanceTimersByTimeAsync(UPLOAD_IDLE_TIMEOUT_MS - 1);
    expect(sinks[0]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(sinks[0]!.aborted).toBe(true);
    expect(outcomes.at(-1)?.outcome).toBe('aborted:idle');
    expect(await rpcCode(svc.chunk({ uploadId, offset: 3, data: b64('def') }))).toBe('upload_unknown');
  });

  test('a finished upload never fires its idle timer', async () => {
    vi.useFakeTimers();
    const { staging } = fakeStaging();
    const svc = service(staging);
    const { uploadId } = await begin(svc, 0);
    await svc.commit({ uploadId });
    await vi.advanceTimersByTimeAsync(UPLOAD_IDLE_TIMEOUT_MS * 2);
    expect(outcomes).toEqual([{ name: 'x', size: 0, outcome: 'staged' }]);
  });

  test('idle timeout on real staging leaves the directory unchanged', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const svc = service();
    const { uploadId } = await begin(svc, 6);
    await svc.chunk({ uploadId, offset: 0, data: b64('abc') });
    await vi.advanceTimersByTimeAsync(UPLOAD_IDLE_TIMEOUT_MS);
    vi.useRealTimers();
    await vi.waitFor(() => expect(readdirSync(dir)).toEqual([]));
  });

  test('disposeAll aborts every upload and refuses new ones', async () => {
    const { staging, sinks } = fakeStaging();
    const svc = service(staging);
    await begin(svc, 6);
    await begin(svc, 6);
    await svc.disposeAll();
    expect(sinks.map((s) => s.aborted)).toEqual([true, true]);
    expect(outcomes.map((o) => o.outcome)).toEqual(['aborted:link-closed', 'aborted:link-closed']);
    expect(await rpcCode(begin(svc, 1))).toBe('closed');
  });

  test('a begin still opening when the link closes discards its sink', async () => {
    const { staging, sinks } = fakeStaging();
    let release!: () => void;
    staging.usageBytes.mockImplementationOnce(() => new Promise<number>((r) => { release = () => r(0); }));
    const svc = service(staging);
    const pending = begin(svc, 1);
    await vi.waitFor(() => expect(release).toBeDefined());
    const disposed = svc.disposeAll();
    release();
    expect(await rpcCode(pending)).toBe('closed');
    await disposed;
    expect(sinks.every((s) => s.aborted)).toBe(true);
  });

  test('prune of real stale files frees the cap for a new upload (AC-U9)', async () => {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    const stale = join(dir, 'old.bin');
    writeFileSync(stale, Buffer.alloc(16));
    const old = (Date.now() - DROP_MAX_AGE_MS - 60_000) / 1000;
    utimesSync(stale, old, old);
    const staging = realStaging();
    const svc = createUploadService({ staging, platform: 'linux', onOutcome: () => {}, maxTotalBytes: 20 });
    await expect(begin(svc, 10)).resolves.toBeDefined();
    expect(readdirSync(dir).filter((n) => n === 'old.bin')).toEqual([]);
  });
});
