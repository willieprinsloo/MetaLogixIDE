/**
 * Adapter tests for `createUploadClient`: channel names and payloads over a fake bridge, and the
 * mapping of an unexpected bridge rejection to a typed value.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@renderer/api', () => ({ api: {} }));

const { createUploadClient } = await import('@renderer/remote-upload/upload-client');
type UploadBridge = import('@renderer/remote-upload/upload-client').UploadBridge;

function bridge(invokeImpl: (channel: string, req: unknown) => Promise<unknown>) {
  const off = vi.fn();
  const on = vi.fn(() => off);
  const invoke = vi.fn(invokeImpl);
  return { b: { invoke, on } as unknown as UploadBridge, invoke, on, off };
}

describe('createUploadClient', () => {
  it('upload calls p2p:upload with the request and returns its result', async () => {
    const { b, invoke } = bridge(async () => ({ kind: 'staged', path: '/h/a', style: 'posix' }));
    const req = { uploadId: 'u', deviceId: 'd', source: { kind: 'clipboard-image' } as const };
    await expect(createUploadClient(b).upload(req)).resolves.toEqual({ kind: 'staged', path: '/h/a', style: 'posix' });
    expect(invoke).toHaveBeenCalledWith('p2p:upload', req);
  });

  it('upload maps a bridge rejection to failed', async () => {
    const { b } = bridge(async () => {
      throw new Error('ipc gone');
    });
    await expect(
      createUploadClient(b).upload({ uploadId: 'u', deviceId: 'd', source: { kind: 'clipboard-image' } }),
    ).resolves.toEqual({ kind: 'failed', reason: 'ipc gone' });
  });

  it('cancel calls p2p:upload-cancel and swallows nothing silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { b, invoke } = bridge(async () => {
      throw 'nope';
    });
    await expect(createUploadClient(b).cancel('u9')).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith('p2p:upload-cancel', { uploadId: 'u9' });
    expect(warn).toHaveBeenCalledWith('[metaide] upload cancel failed', 'nope');
    warn.mockRestore();
  });

  it('statAppFile calls drops:stat-app-file and maps a rejection to failed', async () => {
    const ok = bridge(async () => ({ kind: 'ok', name: 'a', size: 1, isDirectory: false }));
    await expect(createUploadClient(ok.b).statAppFile({ projectId: 1, relPath: 'a' })).resolves.toEqual({
      kind: 'ok',
      name: 'a',
      size: 1,
      isDirectory: false,
    });
    expect(ok.invoke).toHaveBeenCalledWith('drops:stat-app-file', { projectId: 1, relPath: 'a' });
    const bad = bridge(async () => {
      throw new Error('x');
    });
    await expect(createUploadClient(bad.b).statAppFile({ projectId: 1, relPath: 'a' })).resolves.toEqual({
      kind: 'failed',
      reason: 'x',
    });
  });

  it('onProgress subscribes to p2p:upload-progress and returns its disposer', () => {
    const { b, on, off } = bridge(async () => undefined);
    const listener = vi.fn();
    const dispose = createUploadClient(b).onProgress(listener);
    expect(on).toHaveBeenCalledWith('p2p:upload-progress', listener);
    dispose();
    expect(off).toHaveBeenCalled();
  });
});
