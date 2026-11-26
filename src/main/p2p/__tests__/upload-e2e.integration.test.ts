import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  app: { getVersion: () => '0.0.0-test' },
}));

import { RpcPeer } from '../rpc';
import { pairedTransports, type MockTransport } from './_pairedTransports';
import { wireHub } from '../hub';
import { createDropStaging } from '../../drops/staging';
import { createUploadClient, type UploadClient, type UploadClientDeps } from '../upload-client';
import type { UploadProgressEvent, UploadRequest } from '../../../shared/remote-upload-contract';

/*
 * Stand-in for the two-machine test (plan "Testing limits"): the real viewer upload client talks
 * over paired in-memory transports to a real hub with real staging in a tmp dir.
 */

let root: string;
let dropDir: string;
let ta: MockTransport;
let tb: MockTransport;

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const chunkFramesSent = (): number =>
  ta.sent.filter((f) => new TextDecoder().decode(f).includes('"drops.uploadChunk"')).length;

function viewer(peer: RpcPeer, onProgress: (e: UploadProgressEvent) => void = () => {}): UploadClient {
  const call: UploadClientDeps['call'] = (_deviceId, method, params) => peer.call(method, params);
  return createUploadClient({
    call,
    locateAppFile: async () => ({ kind: 'failed', reason: 'unused' }),
    readFile: async () => new Uint8Array(),
    readClipboardPng: () => null,
    emitProgress: onProgress,
    now: () => Date.now(),
  });
}

function link(opts: { oldHost?: boolean } = {}) {
  [ta, tb] = pairedTransports();
  const viewerPeer = new RpcPeer(ta.asTransport(), { allowIncomingStreams: false });
  const hostPeer = new RpcPeer(tb.asTransport());
  viewerPeer.on('error', () => {});
  hostPeer.on('error', () => {});
  if (opts.oldHost) return { viewerPeer };
  const dropStaging = createDropStaging({ dir: dropDir, now: () => new Date(), uid: process.platform === 'win32' ? null : process.getuid!() });
  const hub = wireHub(hostPeer, { remoteDeviceId: 'viewer-1', services: { dropStaging } as never, auditLogPath: join(root, 'audit.log') });
  // Mirrors P2PRuntime.finishLink, which disposes the hub when the link ends.
  tb.on('close', () => void hub.dispose());
  return { viewerPeer, hub };
}

const request = (bytes: Uint8Array, uploadId = 'r-1'): UploadRequest => ({
  uploadId,
  deviceId: 'host-1',
  source: { kind: 'bytes', name: 'video.bin', mime: 'application/octet-stream', bytes },
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'upload-e2e-'));
  dropDir = join(root, 'drops');
  mkdirSync(dropDir, { mode: 0o700 });
  chmodSync(dropDir, 0o700);
  writeFileSync(join(dropDir, 'existing.txt'), 'keep');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('viewer upload client ↔ host hub', () => {
  test('a 12 MB file is staged on the host byte-identical (AC-U3)', async () => {
    const { viewerPeer } = link();
    const bytes = new Uint8Array(randomBytes(12 * 1024 * 1024));
    const progress: UploadProgressEvent[] = [];
    const result = await viewer(viewerPeer, (e) => progress.push(e)).upload(request(bytes));
    expect(result).toMatchObject({ kind: 'staged', path: join(dropDir, 'video.bin') });
    const staged = readFileSync(join(dropDir, 'video.bin'));
    expect(staged.byteLength).toBe(bytes.byteLength);
    expect(sha256(staged)).toBe(sha256(bytes));
    expect(readdirSync(dropDir).sort()).toEqual(['existing.txt', 'video.bin']);
    expect(chunkFramesSent()).toBe(48);
    expect(progress.at(-1)).toEqual({ uploadId: 'r-1', sentBytes: bytes.byteLength, totalBytes: bytes.byteLength });
    const summary = readFileSync(join(root, 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.method === 'drops.upload');
    expect(summary).toMatchObject([{ remoteDeviceId: 'viewer-1', name: 'video.bin', size: bytes.byteLength, outcome: 'staged' }]);
  });

  test('a viewer cancel mid-upload leaves the host drop folder unchanged (AC-U6, AC-D6)', async () => {
    const { viewerPeer } = link();
    let client!: UploadClient;
    client = viewer(viewerPeer, () => client.cancel('r-1'));
    const result = await client.upload(request(new Uint8Array(randomBytes(2 * 1024 * 1024))));
    expect(result).toEqual({ kind: 'cancelled' });
    expect(chunkFramesSent()).toBe(1);
    await vi.waitFor(() => expect(readdirSync(dropDir)).toEqual(['existing.txt']));
  });

  test('a cancel once the last chunk is sent, while commit is in flight, leaves no staged file (AC-U6)', async () => {
    const { viewerPeer } = link();
    let client!: UploadClient;
    const size = 64 * 1024;
    client = viewer(viewerPeer, (e) => { if (e.sentBytes === size) client.cancel('r-1'); });
    const result = await client.upload(request(new Uint8Array(randomBytes(size))));
    expect(result).toEqual({ kind: 'cancelled' });
    await vi.waitFor(() => expect(readdirSync(dropDir)).toEqual(['existing.txt']));
    await new Promise((r) => setTimeout(r, 50));
    expect(readdirSync(dropDir)).toEqual(['existing.txt']);
  });

  test('the link closing mid-upload is link-lost and the host keeps no partial file (AC-U6)', async () => {
    const { viewerPeer } = link();
    const client = viewer(viewerPeer, () => { ta.close(); tb.close(); });
    const result = await client.upload(request(new Uint8Array(randomBytes(2 * 1024 * 1024))));
    expect(result).toEqual({ kind: 'link-lost' });
    await vi.waitFor(() => expect(readdirSync(dropDir)).toEqual(['existing.txt']));
  });

  test('a host without the upload methods gives unsupported-host and no byte is sent (AC-U12)', async () => {
    const { viewerPeer } = link({ oldHost: true });
    const result = await viewer(viewerPeer).upload(request(new Uint8Array(1024)));
    expect(result).toEqual({ kind: 'unsupported-host' });
    expect(ta.sent).toHaveLength(1);
    expect(chunkFramesSent()).toBe(0);
  });

  test('a hub disposed while an upload is open discards it; the viewer then fails cleanly', async () => {
    const { viewerPeer, hub } = link();
    let disposing: Promise<void> | null = null;
    const client = viewer(viewerPeer, () => {
      disposing ??= hub!.dispose();
    });
    const result = await client.upload(request(new Uint8Array(randomBytes(1024 * 1024))));
    expect(result).toEqual({ kind: 'failed', reason: 'upload_unknown' });
    // The viewer can see the refusal before the host has finished deleting the partial file.
    await disposing;
    expect(readdirSync(dropDir)).toEqual(['existing.txt']);
  });
});
