// @vitest-environment jsdom
/**
 * Contract tests for the upload tracker behind the remote-terminal progress indicator (AC-D5,
 * AC-D6, AC-D8): the 500 ms reveal, progress mapping, cancel semantics and the hook's unmount
 * cancel. The upload client is a fake; no IPC runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  createUploadTracker,
  useUploadProgress,
} from '@renderer/remote-upload/useUploadProgress';
import type { UploadClient } from '@renderer/remote-upload/upload-client';
import type { UploadProgressEvent, UploadResult, UploadSource } from '@shared/remote-upload-contract';

const SOURCE: UploadSource = { kind: 'clipboard-image' };
const ITEM = { name: 'a.mov', index: 2, count: 3 };

function fakeClient() {
  const pending = new Map<string, (r: UploadResult) => void>();
  const listeners = new Set<(e: UploadProgressEvent) => void>();
  const client: UploadClient = {
    upload: vi.fn(
      (req) =>
        new Promise<UploadResult>((resolve) => {
          pending.set(req.uploadId, resolve);
        }),
    ),
    cancel: vi.fn(async (id: string) => {
      pending.get(id)?.({ kind: 'cancelled' });
    }),
    statAppFile: vi.fn(),
    onProgress: vi.fn((l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    }),
  };
  const emit = (e: UploadProgressEvent) => {
    for (const l of listeners) l(e);
  };
  return { client, pending, listeners, emit };
}

let ids = 0;
const newId = () => `u${++ids}`;

beforeEach(() => {
  vi.useFakeTimers();
  ids = 0;
});
afterEach(() => vi.useRealTimers());

describe('createUploadTracker', () => {
  it('sends the request with a fresh upload id, the device and the confirmed flag', async () => {
    const { client, pending } = fakeClient();
    const tracker = createUploadTracker({ client, newId });
    const done = tracker.batch('tower').upload(SOURCE, ITEM, true);
    expect(client.upload).toHaveBeenCalledWith({ uploadId: 'u1', deviceId: 'tower', source: SOURCE, confirmed: true });
    pending.get('u1')?.({ kind: 'staged', path: '/h/a', style: 'posix' });
    await expect(done).resolves.toEqual({ kind: 'staged', path: '/h/a', style: 'posix' });
  });

  it('AC-D5: hidden before 500 ms, then shows name, n of m and percent', async () => {
    const { client, emit } = fakeClient();
    const tracker = createUploadTracker({ client, newId });
    void tracker.batch('tower').upload(SOURCE, ITEM, false);
    vi.advanceTimersByTime(499);
    expect(tracker.view()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(tracker.view()).toEqual({ name: 'a.mov', index: 2, count: 3, percent: 0 });
    emit({ uploadId: 'u1', sentBytes: 256, totalBytes: 1024 });
    expect(tracker.view()).toEqual({ name: 'a.mov', index: 2, count: 3, percent: 25 });
  });

  it('ignores progress for another upload id', () => {
    const { client, emit } = fakeClient();
    const tracker = createUploadTracker({ client, newId });
    void tracker.batch('tower').upload(SOURCE, ITEM, false);
    vi.advanceTimersByTime(500);
    emit({ uploadId: 'other', sentBytes: 9, totalBytes: 10 });
    expect(tracker.view()?.percent).toBe(0);
  });

  it('AC-D5: a drop that finishes within 500 ms never shows', async () => {
    const { client, pending } = fakeClient();
    const tracker = createUploadTracker({ client, newId });
    const batch = tracker.batch('tower');
    const done = batch.upload(SOURCE, ITEM, false);
    pending.get('u1')?.({ kind: 'staged', path: '/h/a', style: 'posix' });
    await done;
    batch.end();
    vi.advanceTimersByTime(1000);
    expect(tracker.view()).toBeNull();
  });

  it('AC-D5: stays up between files of one drop and hides when the drop ends', async () => {
    const { client, pending } = fakeClient();
    const tracker = createUploadTracker({ client, newId });
    const batch = tracker.batch('tower');
    const first = batch.upload(SOURCE, { name: 'a', index: 1, count: 2 }, false);
    vi.advanceTimersByTime(600);
    pending.get('u1')?.({ kind: 'staged', path: '/h/a', style: 'posix' });
    await first;
    void batch.upload(SOURCE, { name: 'b', index: 2, count: 2 }, false);
    expect(tracker.view()).toEqual({ name: 'b', index: 2, count: 2, percent: 0 });
    batch.end();
    expect(tracker.view()).toBeNull();
  });

  it('notifies subscribers on reveal, progress and end', () => {
    const { client, emit } = fakeClient();
    const tracker = createUploadTracker({ client, newId });
    const listener = vi.fn();
    const off = tracker.subscribe(listener);
    const batch = tracker.batch('tower');
    void batch.upload(SOURCE, ITEM, false);
    vi.advanceTimersByTime(500);
    const afterReveal = listener.mock.calls.length;
    expect(afterReveal).toBeGreaterThan(0);
    emit({ uploadId: 'u1', sentBytes: 1, totalBytes: 2 });
    expect(listener.mock.calls.length).toBeGreaterThan(afterReveal);
    off();
    const before = listener.mock.calls.length;
    batch.end();
    expect(listener.mock.calls.length).toBe(before);
  });

  it('returns a stable view object between changes', () => {
    const { client } = fakeClient();
    const tracker = createUploadTracker({ client, newId });
    void tracker.batch('tower').upload(SOURCE, ITEM, false);
    vi.advanceTimersByTime(500);
    expect(tracker.view()).toBe(tracker.view());
  });

  it('AC-D6: cancel stops the in-flight upload, hides the view, and later uploads of the drop never start', async () => {
    const { client } = fakeClient();
    const tracker = createUploadTracker({ client, newId });
    const batch = tracker.batch('tower');
    const first = batch.upload(SOURCE, ITEM, false);
    vi.advanceTimersByTime(500);
    tracker.cancel();
    expect(client.cancel).toHaveBeenCalledWith('u1');
    expect(tracker.view()).toBeNull();
    await expect(first).resolves.toEqual({ kind: 'cancelled' });
    await expect(batch.upload(SOURCE, ITEM, false)).resolves.toEqual({ kind: 'cancelled' });
    expect(client.upload).toHaveBeenCalledTimes(1);
  });

  it('cancel with nothing in flight calls no IPC; a new drop after a cancel uploads normally', async () => {
    const { client } = fakeClient();
    const tracker = createUploadTracker({ client, newId });
    tracker.cancel();
    expect(client.cancel).not.toHaveBeenCalled();
    void tracker.batch('tower').upload(SOURCE, ITEM, false);
    expect(client.upload).toHaveBeenCalledTimes(1);
  });

  it('listens for progress only while a drop is active', async () => {
    const { client, listeners, pending } = fakeClient();
    const tracker = createUploadTracker({ client, newId });
    expect(listeners.size).toBe(0);
    const batch = tracker.batch('tower');
    const done = batch.upload(SOURCE, ITEM, false);
    expect(listeners.size).toBe(1);
    pending.get('u1')?.({ kind: 'no-image' });
    await done;
    batch.end();
    expect(listeners.size).toBe(0);
  });

  it('a percent never exceeds 100 and an empty file reads 0', () => {
    const { client, emit } = fakeClient();
    const tracker = createUploadTracker({ client, newId });
    void tracker.batch('tower').upload(SOURCE, ITEM, false);
    vi.advanceTimersByTime(500);
    emit({ uploadId: 'u1', sentBytes: 0, totalBytes: 0 });
    expect(tracker.view()?.percent).toBe(0);
    emit({ uploadId: 'u1', sentBytes: 2, totalBytes: 1 });
    expect(tracker.view()?.percent).toBe(100);
  });
});

const sentId = (client: UploadClient): string => vi.mocked(client.upload).mock.calls[0]?.[0].uploadId ?? '';

describe('useUploadProgress', () => {
  it('exposes the live view and a cancel', () => {
    const { client } = fakeClient();
    const { result } = renderHook(() => useUploadProgress(client));
    expect(result.current.view).toBeNull();
    act(() => {
      void result.current.tracker.batch('tower').upload(SOURCE, ITEM, false);
      vi.advanceTimersByTime(500);
    });
    expect(result.current.view).toEqual({ name: 'a.mov', index: 2, count: 3, percent: 0 });
    act(() => result.current.cancel());
    expect(client.cancel).toHaveBeenCalledWith(sentId(client));
    expect(result.current.view).toBeNull();
  });

  it('AC-D8: unmount cancels the upload in flight', () => {
    const { client } = fakeClient();
    const { result, unmount } = renderHook(() => useUploadProgress(client));
    void result.current.tracker.batch('tower').upload(SOURCE, ITEM, false);
    unmount();
    expect(client.cancel).toHaveBeenCalledWith(sentId(client));
  });
});
