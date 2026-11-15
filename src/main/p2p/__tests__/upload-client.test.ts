import { describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUploadClient, uploadClientDeps, type UploadClientDeps, type UploadMethod } from '../upload-client';
import { RpcError, MAX_RPC_FRAME_BYTES } from '../rpc';
import { encodeFrame } from '../../../shared/signaling-wire';
import {
  MAX_STAGED_BYTES,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_CONFIRM_ABOVE_BYTES,
  type UploadProgressEvent,
  type UploadRequest,
} from '../../../shared/remote-upload-contract';
import type { Params } from '../../../shared/p2p-contract';

type Call = { method: UploadMethod; params: Record<string, unknown> };

/** In-memory host: records every call, and can be told to fail a method with an RpcError code. */
function fakeHost(opts: { failOn?: Partial<Record<UploadMethod, string>>; platform?: string; chunkBytes?: number } = {}) {
  const calls: Call[] = [];
  const received: Buffer[] = [];
  const call = vi.fn(async (_deviceId: string, method: UploadMethod, params: Params<UploadMethod>) => {
    calls.push({ method, params: params as Record<string, unknown> });
    const code = opts.failOn?.[method];
    if (code) throw new RpcError(code, code);
    switch (method) {
      case 'drops.uploadBegin': return { uploadId: 'host-1', chunkBytes: opts.chunkBytes ?? UPLOAD_CHUNK_BYTES };
      case 'drops.uploadChunk': {
        received.push(Buffer.from((params as { data: string }).data, 'base64'));
        return { received: Buffer.concat(received).byteLength };
      }
      case 'drops.uploadCommit': return { path: '/tmp/metaide-drops-1000/a.txt', platform: opts.platform ?? 'linux' };
      default: return { ok: true };
    }
  });
  const methods = () => calls.map((c) => c.method);
  return { call, calls, methods, received: () => Buffer.concat(received) };
}

function client(host: ReturnType<typeof fakeHost>, overrides: Partial<UploadClientDeps> = {}) {
  const progress: UploadProgressEvent[] = [];
  let clock = 0;
  const deps: UploadClientDeps = {
    call: host.call as unknown as UploadClientDeps['call'],
    locateAppFile: vi.fn(async () => ({ kind: 'ok', path: '/proj/a.txt', name: 'a.txt', size: 3, isDirectory: false }) as const),
    readFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
    readClipboardPng: vi.fn(() => new Uint8Array([137, 80, 78, 71])),
    emitProgress: (e) => progress.push(e),
    now: () => (clock += 30),
    ...overrides,
  };
  return { uc: createUploadClient(deps), deps, progress };
}

const bytesReq = (size: number, extra: Partial<UploadRequest> = {}): UploadRequest => ({
  uploadId: 'u1',
  deviceId: 'dev',
  source: { kind: 'bytes', name: 'a.txt', mime: 'text/plain', bytes: new Uint8Array(size).map((_, i) => i % 251) },
  ...extra,
});

describe('upload happy path', () => {
  test('begins, sends ordered chunks, commits, and returns the host path with the host style (AC-U2)', async () => {
    const host = fakeHost({ platform: 'win32' });
    const { uc } = client(host);
    const req = bytesReq(UPLOAD_CHUNK_BYTES * 2 + 5);
    const result = await uc.upload(req);
    expect(result).toEqual({ kind: 'staged', path: '/tmp/metaide-drops-1000/a.txt', style: 'windows' });
    expect(host.methods()).toEqual(['drops.uploadBegin', 'drops.uploadChunk', 'drops.uploadChunk', 'drops.uploadChunk', 'drops.uploadCommit']);
    expect(host.calls[0]!.params).toEqual({ name: 'a.txt', mime: 'text/plain', size: UPLOAD_CHUNK_BYTES * 2 + 5, kind: 'file' });
    expect(host.calls.slice(1, 4).map((c) => c.params.offset)).toEqual([0, UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES * 2]);
    expect(host.received().equals(Buffer.from((req.source as { bytes: Uint8Array }).bytes))).toBe(true);
  });

  test('a POSIX host gets the posix style', async () => {
    const { uc } = client(fakeHost({ platform: 'darwin' }));
    expect(await uc.upload(bytesReq(1))).toMatchObject({ style: 'posix' });
  });

  test('a zero-byte file begins and commits with no chunk (AC-D10)', async () => {
    const host = fakeHost();
    const { uc } = client(host);
    expect((await uc.upload(bytesReq(0))).kind).toBe('staged');
    expect(host.methods()).toEqual(['drops.uploadBegin', 'drops.uploadCommit']);
  });

  test('never sends a chunk larger than its own limit even when the host offers more', async () => {
    const host = fakeHost({ chunkBytes: 8 * 1024 * 1024 });
    const { uc } = client(host);
    await uc.upload(bytesReq(UPLOAD_CHUNK_BYTES + 1));
    const sizes = host.calls.filter((c) => c.method === 'drops.uploadChunk').map((c) => Buffer.from(String(c.params.data), 'base64').byteLength);
    expect(sizes).toEqual([UPLOAD_CHUNK_BYTES, 1]);
  });

  test('honours a smaller chunk size from the host', async () => {
    const host = fakeHost({ chunkBytes: 1000 });
    const { uc } = client(host);
    await uc.upload(bytesReq(2500));
    expect(host.methods().filter((m) => m === 'drops.uploadChunk')).toHaveLength(3);
  });

  test('every chunk request frame fits under the 1 MiB RPC frame cap (AC-U3)', async () => {
    const host = fakeHost();
    const { uc } = client(host);
    await uc.upload(bytesReq(UPLOAD_CHUNK_BYTES * 2));
    for (const c of host.calls.filter((x) => x.method === 'drops.uploadChunk')) {
      const json = JSON.stringify({ kind: 'req', id: Number.MAX_SAFE_INTEGER, method: c.method, params: c.params });
      expect(encodeFrame(new TextEncoder().encode(json)).byteLength).toBeLessThan(MAX_RPC_FRAME_BYTES);
    }
  });
});

describe('sources', () => {
  test('an app file is located, begun, and only then read (AC-D2, AC-U12)', async () => {
    const host = fakeHost();
    const order: string[] = [];
    const { uc, deps } = client(host, {
      readFile: vi.fn(async () => { order.push(`read after ${host.methods().join(',')}`); return new Uint8Array([1, 2, 3]); }),
    });
    const result = await uc.upload({ uploadId: 'u1', deviceId: 'dev', source: { kind: 'app-file', projectId: 7, relPath: 'a.txt' } });
    expect(result.kind).toBe('staged');
    expect(deps.locateAppFile).toHaveBeenCalledWith({ projectId: 7, relPath: 'a.txt' });
    expect(order).toEqual(['read after drops.uploadBegin']);
    expect(host.calls[0]!.params).toMatchObject({ name: 'a.txt', size: 3, kind: 'file' });
  });

  test('an app file that cannot be located fails before any host call', async () => {
    const host = fakeHost();
    const { uc } = client(host, { locateAppFile: async () => ({ kind: 'failed', reason: 'relPath resolves outside the project' }) });
    expect(await uc.upload({ uploadId: 'u1', deviceId: 'dev', source: { kind: 'app-file', projectId: 7, relPath: '../x' } }))
      .toEqual({ kind: 'failed', reason: 'relPath resolves outside the project' });
    expect(host.calls).toEqual([]);
  });

  test('an app-file directory is refused before any host call', async () => {
    const host = fakeHost();
    const { uc } = client(host, { locateAppFile: async () => ({ kind: 'ok', path: '/p/src', name: 'src', size: 96, isDirectory: true }) });
    expect((await uc.upload({ uploadId: 'u1', deviceId: 'dev', source: { kind: 'app-file', projectId: 7, relPath: 'src' } })).kind).toBe('failed');
    expect(host.calls).toEqual([]);
  });

  test('an app file whose size changed while reading is aborted, not staged', async () => {
    const host = fakeHost();
    const { uc } = client(host, { readFile: async () => new Uint8Array(10) });
    const r = await uc.upload({ uploadId: 'u1', deviceId: 'dev', source: { kind: 'app-file', projectId: 7, relPath: 'a.txt' } });
    expect(r).toEqual({ kind: 'failed', reason: 'file changed while reading' });
    expect(host.methods()).toEqual(['drops.uploadBegin', 'drops.uploadAbort']);
  });

  test('an app file read error aborts the host upload', async () => {
    const host = fakeHost();
    const { uc } = client(host, { readFile: async () => { throw new Error('EACCES'); } });
    const r = await uc.upload({ uploadId: 'u1', deviceId: 'dev', source: { kind: 'app-file', projectId: 7, relPath: 'a.txt' } });
    expect(r).toEqual({ kind: 'failed', reason: 'EACCES' });
    expect(host.methods()).toEqual(['drops.uploadBegin', 'drops.uploadAbort']);
  });

  test('the clipboard image is sent as a clipboard-image PNG (AC-I1)', async () => {
    const host = fakeHost();
    const { uc } = client(host);
    expect((await uc.upload({ uploadId: 'u1', deviceId: 'dev', source: { kind: 'clipboard-image' } })).kind).toBe('staged');
    expect(host.calls[0]!.params).toEqual({ name: 'pasted.png', mime: 'image/png', size: 4, kind: 'clipboard-image' });
  });

  test('no clipboard image gives no-image and no host call (AC-I3)', async () => {
    const host = fakeHost();
    const { uc } = client(host, { readClipboardPng: () => null });
    expect(await uc.upload({ uploadId: 'u1', deviceId: 'dev', source: { kind: 'clipboard-image' } })).toEqual({ kind: 'no-image' });
    expect(host.calls).toEqual([]);
  });

  test('a clipboard read error is a failed result, not a rejection', async () => {
    const { uc } = client(fakeHost(), { readClipboardPng: () => { throw new Error('clipboard unavailable'); } });
    expect(await uc.upload({ uploadId: 'u1', deviceId: 'dev', source: { kind: 'clipboard-image' } }))
      .toEqual({ kind: 'failed', reason: 'clipboard unavailable' });
  });

  test('a clipboard image over 10 MB asks first and sends nothing until confirmed (decision Q2)', async () => {
    const host = fakeHost();
    const big = new Uint8Array(UPLOAD_CONFIRM_ABOVE_BYTES + 1);
    const { uc } = client(host, { readClipboardPng: () => big });
    expect(await uc.upload({ uploadId: 'u1', deviceId: 'dev', source: { kind: 'clipboard-image' } }))
      .toEqual({ kind: 'needs-confirm', size: big.byteLength });
    expect(host.calls).toEqual([]);
    expect((await uc.upload({ uploadId: 'u2', deviceId: 'dev', source: { kind: 'clipboard-image' }, confirmed: true })).kind).toBe('staged');
  });

  test('a clipboard image of exactly 10 MB needs no confirm', async () => {
    const { uc } = client(fakeHost(), { readClipboardPng: () => new Uint8Array(UPLOAD_CONFIRM_ABOVE_BYTES) });
    expect((await uc.upload({ uploadId: 'u1', deviceId: 'dev', source: { kind: 'clipboard-image' } })).kind).toBe('staged');
  });

  test('a large OS file is not gated in main: the renderer already confirmed it', async () => {
    const { uc } = client(fakeHost());
    expect((await uc.upload(bytesReq(UPLOAD_CONFIRM_ABOVE_BYTES + 1))).kind).toBe('staged');
  });

  test.each([
    ['bytes', () => bytesReq(MAX_STAGED_BYTES + 1)],
    ['clipboard', () => ({ uploadId: 'u1', deviceId: 'dev', source: { kind: 'clipboard-image' }, confirmed: true }) as UploadRequest],
    ['app file', () => ({ uploadId: 'u1', deviceId: 'dev', source: { kind: 'app-file', projectId: 7, relPath: 'big' } }) as UploadRequest],
  ])('a %s source over 50 MB is too-large before any host call (AC-U5)', async (_label, req) => {
    const host = fakeHost();
    const huge = MAX_STAGED_BYTES + 1;
    const { uc } = client(host, {
      readClipboardPng: () => new Uint8Array(huge),
      locateAppFile: async () => ({ kind: 'ok', path: '/p/big', name: 'big', size: huge, isDirectory: false }),
    });
    expect(await uc.upload(req())).toEqual({ kind: 'too-large', limitBytes: MAX_STAGED_BYTES });
    expect(host.calls).toEqual([]);
  });
});

describe('request validation (B-S8)', () => {
  test.each([
    ['no request', undefined],
    ['a non-string upload id', { uploadId: 1, deviceId: 'd', source: { kind: 'clipboard-image' } }],
    ['a missing device', { uploadId: 'u', source: { kind: 'clipboard-image' } }],
    ['a path source', { uploadId: 'u', deviceId: 'd', source: { kind: 'path', path: '/etc/passwd' } }],
    ['bytes that are not bytes', { uploadId: 'u', deviceId: 'd', source: { kind: 'bytes', name: 'a', mime: '', bytes: 'abc' } }],
    ['an oversized name', { uploadId: 'u', deviceId: 'd', source: { kind: 'bytes', name: 'n'.repeat(1025), mime: '', bytes: new Uint8Array(1) } }],
    ['an oversized mime', { uploadId: 'u', deviceId: 'd', source: { kind: 'bytes', name: 'n', mime: 'm'.repeat(256), bytes: new Uint8Array(1) } }],
    ['a non-integer project', { uploadId: 'u', deviceId: 'd', source: { kind: 'app-file', projectId: '7', relPath: 'a' } }],
    ['an oversized upload id', { uploadId: 'u'.repeat(129), deviceId: 'd', source: { kind: 'clipboard-image' } }],
  ])('refuses %s without touching the host or the filesystem', async (_label, req) => {
    const host = fakeHost();
    const { uc, deps } = client(host);
    expect(await uc.upload(req as never)).toEqual({ kind: 'failed', reason: 'invalid request' });
    expect(host.calls).toEqual([]);
    expect(deps.locateAppFile).not.toHaveBeenCalled();
    expect(deps.readClipboardPng).not.toHaveBeenCalled();
  });

  test('a second upload under an id already in flight is refused', async () => {
    let releaseBegin!: () => void;
    const host = fakeHost();
    const gated: UploadClientDeps['call'] = (async (id: string, m: UploadMethod, p: never) => {
      if (m === 'drops.uploadBegin') await new Promise<void>((r) => { releaseBegin = r; });
      return host.call(id, m, p);
    }) as never;
    const { uc } = client(host, { call: gated });
    const first = uc.upload(bytesReq(1));
    expect(await uc.upload(bytesReq(1))).toEqual({ kind: 'failed', reason: 'upload id already in use' });
    releaseBegin();
    expect((await first).kind).toBe('staged');
  });
});

describe('host error mapping', () => {
  test('an old host answers unknown_method to begin: unsupported-host and zero chunks (AC-U12)', async () => {
    const host = fakeHost({ failOn: { 'drops.uploadBegin': 'unknown_method' } });
    const { uc, deps } = client(host, { readFile: vi.fn(async () => new Uint8Array(3)) });
    expect(await uc.upload({ uploadId: 'u1', deviceId: 'dev', source: { kind: 'app-file', projectId: 7, relPath: 'a.txt' } }))
      .toEqual({ kind: 'unsupported-host' });
    expect(host.methods()).toEqual(['drops.uploadBegin']);
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  test.each([
    ['upload_too_large', { kind: 'too-large', limitBytes: MAX_STAGED_BYTES }],
    ['drop_folder_full', { kind: 'refused', reason: 'drop-folder-full' }],
    ['too_many_uploads', { kind: 'refused', reason: 'too-many-uploads' }],
    ['closed', { kind: 'link-lost' }],
    ['request_timeout', { kind: 'link-lost' }],
    ['handler_error', { kind: 'failed', reason: 'handler_error' }],
    ['invalid_params', { kind: 'failed', reason: 'invalid_params' }],
  ])('begin failing with %s maps to %j and sends no chunk', async (code, expected) => {
    const host = fakeHost({ failOn: { 'drops.uploadBegin': code } });
    const { uc } = client(host);
    expect(await uc.upload(bytesReq(10))).toEqual(expected);
    expect(host.methods()).toEqual(['drops.uploadBegin']);
  });

  test('a non-RPC error before begin (device unreachable) is failed with its message', async () => {
    const { uc } = client(fakeHost(), { call: (async () => { throw new Error('no_device_code'); }) as never });
    expect(await uc.upload(bytesReq(1))).toEqual({ kind: 'failed', reason: 'no_device_code' });
  });

  test('the link closing mid-transfer is link-lost and no abort is attempted on a dead link', async () => {
    const host = fakeHost({ failOn: { 'drops.uploadChunk': 'closed' } });
    const { uc } = client(host);
    expect(await uc.upload(bytesReq(10))).toEqual({ kind: 'link-lost' });
    expect(host.methods()).toEqual(['drops.uploadBegin', 'drops.uploadChunk']);
  });

  test('a host refusal mid-transfer is failed and the host upload is aborted', async () => {
    const host = fakeHost({ failOn: { 'drops.uploadChunk': 'upload_offset' } });
    const { uc } = client(host);
    expect(await uc.upload(bytesReq(10))).toEqual({ kind: 'failed', reason: 'upload_offset' });
    expect(host.methods()).toEqual(['drops.uploadBegin', 'drops.uploadChunk', 'drops.uploadAbort']);
  });

  test('a failed commit is mapped and aborted', async () => {
    const host = fakeHost({ failOn: { 'drops.uploadCommit': 'upload_incomplete' } });
    const { uc } = client(host);
    expect(await uc.upload(bytesReq(3))).toEqual({ kind: 'failed', reason: 'upload_incomplete' });
    expect(host.methods().at(-1)).toBe('drops.uploadAbort');
  });

  test('a failing best-effort abort does not change the result', async () => {
    const host = fakeHost({ failOn: { 'drops.uploadChunk': 'handler_error', 'drops.uploadAbort': 'closed' } });
    const { uc } = client(host);
    expect(await uc.upload(bytesReq(3))).toEqual({ kind: 'failed', reason: 'handler_error' });
  });

  test('upload never rejects, even when a dependency throws synchronously', async () => {
    const { uc } = client(fakeHost(), { locateAppFile: () => { throw new Error('boom'); } });
    await expect(uc.upload({ uploadId: 'u1', deviceId: 'dev', source: { kind: 'app-file', projectId: 7, relPath: 'a' } }))
      .resolves.toEqual({ kind: 'failed', reason: 'boom' });
  });
});

describe('cancel (AC-D6)', () => {
  test('cancel between chunks stops sending, aborts the host upload, and returns cancelled', async () => {
    const host = fakeHost();
    let uc!: ReturnType<typeof createUploadClient>;
    const built = client(host, {
      emitProgress: () => uc.cancel('u1'),
    });
    uc = built.uc;
    expect(await uc.upload(bytesReq(UPLOAD_CHUNK_BYTES * 4))).toEqual({ kind: 'cancelled' });
    expect(host.methods()).toEqual(['drops.uploadBegin', 'drops.uploadChunk', 'drops.uploadAbort']);
    expect(host.calls.at(-1)!.params).toEqual({ uploadId: 'host-1' });
  });

  test('cancel while a chunk is in flight returns at once and still aborts the host upload', async () => {
    const host = fakeHost();
    let hang = false;
    const call = (async (id: string, m: UploadMethod, p: never) => {
      if (m === 'drops.uploadChunk' && hang) return new Promise(() => {});
      hang = m === 'drops.uploadChunk' || hang;
      return host.call(id, m, p);
    }) as never;
    const { uc } = client(host, { call, emitProgress: () => {} });
    const pending = uc.upload(bytesReq(UPLOAD_CHUNK_BYTES * 3));
    await vi.waitFor(() => expect(host.methods().filter((m) => m === 'drops.uploadChunk')).toHaveLength(1));
    await new Promise((r) => setImmediate(r));
    uc.cancel('u1');
    expect(await pending).toEqual({ kind: 'cancelled' });
    expect(host.methods().at(-1)).toBe('drops.uploadAbort');
  });

  test('cancel during begin aborts the host upload once begin answers', async () => {
    const host = fakeHost();
    let releaseBegin!: () => void;
    const call = (async (id: string, m: UploadMethod, p: never) => {
      if (m === 'drops.uploadBegin') await new Promise<void>((r) => { releaseBegin = r; });
      return host.call(id, m, p);
    }) as never;
    const { uc } = client(host, { call });
    const pending = uc.upload(bytesReq(10));
    await vi.waitFor(() => expect(releaseBegin).toBeDefined());
    uc.cancel('u1');
    expect(await pending).toEqual({ kind: 'cancelled' });
    releaseBegin();
    await vi.waitFor(() => expect(host.methods()).toEqual(['drops.uploadBegin', 'drops.uploadAbort']));
  });

  test('cancel of an unknown or finished upload is a no-op', async () => {
    const host = fakeHost();
    const { uc } = client(host);
    uc.cancel('nope');
    expect((await uc.upload(bytesReq(1))).kind).toBe('staged');
    uc.cancel('u1');
    expect(host.methods()).not.toContain('drops.uploadAbort');
  });
});

describe('progress (AC-D5)', () => {
  test('is throttled to at most one event per 100 ms, and always reports completion', async () => {
    const host = fakeHost({ chunkBytes: 1000 });
    const { uc, progress } = client(host);
    await uc.upload(bytesReq(10_000));
    expect(progress.length).toBeLessThan(10);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)).toEqual({ uploadId: 'u1', sentBytes: 10_000, totalBytes: 10_000 });
    const sent = progress.map((p) => p.sentBytes);
    expect([...sent].sort((a, b) => a - b)).toEqual(sent);
  });

  test('uses the renderer upload id, not the host one', async () => {
    const { uc, progress } = client(fakeHost());
    await uc.upload(bytesReq(5, { uploadId: 'renderer-7' }));
    expect(progress.every((p) => p.uploadId === 'renderer-7')).toBe(true);
  });
});

describe('uploadClientDeps (production wiring)', () => {
  test('locates Files-tree files with drop containment, reads them, and reads the clipboard PNG', async () => {
    const root = mkdtempSync(join(tmpdir(), 'upload-deps-'));
    try {
      writeFileSync(join(root, 'a.txt'), 'abc');
      const png = Buffer.from([137, 80]);
      const services = {
        projects: { get: (id: number) => (id === 7 ? { id, path: root } : null) },
        clipboardImage: { readPng: () => png },
      } as never;
      const emit = vi.fn();
      const deps = uploadClientDeps(services, vi.fn() as never, emit);
      const located = await deps.locateAppFile({ projectId: 7, relPath: 'a.txt' });
      expect(located).toEqual({ kind: 'ok', path: join(root, 'a.txt'), name: 'a.txt', size: 3, isDirectory: false });
      expect((await deps.locateAppFile({ projectId: 7, relPath: '../x' })).kind).toBe('failed');
      expect(Buffer.from(await deps.readFile(join(root, 'a.txt'))).toString()).toBe('abc');
      expect(deps.readClipboardPng()).toBe(png);
      expect(typeof deps.now()).toBe('number');
      deps.emitProgress({ uploadId: 'u', sentBytes: 1, totalBytes: 2 });
      expect(emit).toHaveBeenCalledWith({ uploadId: 'u', sentBytes: 1, totalBytes: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('host replies are validated (L4)', () => {
  /** A host whose begin or commit reply is replaced; it cancels after a few chunks so a stuck loop cannot hang. */
  function lyingHost(reply: Partial<Record<'drops.uploadBegin' | 'drops.uploadCommit', unknown>>) {
    const host = fakeHost();
    let chunks = 0;
    let cancel: () => void = () => {};
    const call = vi.fn(async (deviceId: string, method: UploadMethod, params: Params<UploadMethod>) => {
      const real = await host.call(deviceId, method, params);
      if (method === 'drops.uploadChunk' && ++chunks > 3) cancel();
      return method in reply ? reply[method as keyof typeof reply] : real;
    });
    return { host, call, setCancel: (fn: () => void) => { cancel = fn; } };
  }

  test.each([0, -5, 1.5, 'big'])('a begin reply with chunkBytes %s fails the upload before any chunk', async (chunkBytes) => {
    const liar = lyingHost({ 'drops.uploadBegin': { uploadId: 'host-1', chunkBytes } });
    const { uc } = client(liar.host, { call: liar.call as unknown as UploadClientDeps['call'] });
    liar.setCancel(() => uc.cancel('u1'));
    const result = await uc.upload(bytesReq(10));
    expect(result.kind).toBe('failed');
    expect(liar.host.methods()).not.toContain('drops.uploadChunk');
  });

  test('a commit reply without a path fails instead of typing undefined', async () => {
    const liar = lyingHost({ 'drops.uploadCommit': { platform: 'linux' } });
    const { uc } = client(liar.host, { call: liar.call as unknown as UploadClientDeps['call'] });
    expect(await uc.upload(bytesReq(4))).toMatchObject({ kind: 'failed' });
  });

  test('a commit reply that is not an object fails', async () => {
    const liar = lyingHost({ 'drops.uploadCommit': null });
    const { uc } = client(liar.host, { call: liar.call as unknown as UploadClientDeps['call'] });
    expect(await uc.upload(bytesReq(4))).toMatchObject({ kind: 'failed' });
  });
});
