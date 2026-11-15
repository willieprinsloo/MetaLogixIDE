/**
 * Contract tests for clipboard paste into a remote terminal (AC-I1..I4, AC-U12, OQ2): the real
 * `resolveClipboardPaste` over `createRemoteClipboardDeps`, with a fake upload client behind a real
 * tracker, so the test sees exactly what is uploaded, confirmed, toasted and typed.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveClipboardPaste } from '@renderer/clipboard-paste';
import { createRemoteClipboardDeps } from '@renderer/remote-upload/remote-clipboard-deps';
import { createUploadTracker } from '@renderer/remote-upload/useUploadProgress';
import type { UploadClient } from '@renderer/remote-upload/upload-client';
import { REMOTE_UPLOAD_COPY, type UploadResult } from '@shared/remote-upload-contract';
import { DROP_COPY, MAX_STAGED_BYTES } from '@shared/terminal-drop-contract';

const HOST = 'tower';
const MB = 1024 * 1024;

function setup(results: UploadResult[], confirmAnswer = true) {
  const queue = [...results];
  const offProgress = vi.fn();
  const client: UploadClient = {
    upload: vi.fn(async (): Promise<UploadResult> => queue.shift() ?? { kind: 'failed', reason: 'unexpected call' }),
    cancel: vi.fn(async () => undefined),
    statAppFile: vi.fn(),
    onProgress: vi.fn(() => offProgress),
  };
  const notify = vi.fn();
  const confirm = vi.fn(() => confirmAnswer);
  const uploads = createUploadTracker({ client, newId: () => 'id' });
  const deps = createRemoteClipboardDeps({ deviceId: 'dev-1', hostName: HOST, uploads }, { confirm, notify });
  return { client, notify, confirm, deps, uploads, offProgress };
}

describe('remote clipboard paste', () => {
  it('AC-I1: an image only is uploaded from the viewer clipboard and the host path is typed, host-escaped', async () => {
    const { client, deps, notify } = setup([{ kind: 'staged', path: '/tmp/d/pasted 1.png', style: 'posix' }]);
    expect(await resolveClipboardPaste('', deps)).toBe('/tmp/d/pasted\\ 1.png');
    expect(client.upload).toHaveBeenCalledWith({
      uploadId: 'id',
      deviceId: 'dev-1',
      source: { kind: 'clipboard-image' },
      confirmed: false,
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('AC-U2: a Windows host path is escaped in the Windows style', async () => {
    const { deps } = setup([{ kind: 'staged', path: 'C:\\drops\\a b.png', style: 'windows' }]);
    expect(await resolveClipboardPaste('', deps)).toBe('"C:\\drops\\a b.png"');
  });

  it('AC-I2: text on the clipboard wins and nothing is uploaded', async () => {
    const { client, deps } = setup([]);
    expect(await resolveClipboardPaste('ls -la', deps)).toBe('ls -la');
    expect(client.upload).not.toHaveBeenCalled();
  });

  it('AC-I3: no image and no text types nothing and toasts nothing', async () => {
    const { deps, notify } = setup([{ kind: 'no-image' }]);
    expect(await resolveClipboardPaste('', deps)).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it('OQ2: needs-confirm asks once naming the size and host, then retries confirmed', async () => {
    const { client, deps, confirm } = setup([
      { kind: 'needs-confirm', size: 12 * MB },
      { kind: 'staged', path: '/tmp/d/big.png', style: 'posix' },
    ]);
    expect(await resolveClipboardPaste('', deps)).toBe('/tmp/d/big.png');
    expect(confirm).toHaveBeenCalledWith(
      REMOTE_UPLOAD_COPY.confirmMessage([{ name: 'Clipboard image', size: '12.0 MB' }], HOST),
    );
    expect(vi.mocked(client.upload).mock.calls.map((c) => c[0].confirmed)).toEqual([false, true]);
  });

  it('OQ2: declining the confirm sends nothing more, types nothing, and toasts nothing', async () => {
    const { client, deps, notify } = setup([{ kind: 'needs-confirm', size: 12 * MB }], false);
    expect(await resolveClipboardPaste('', deps)).toBeNull();
    expect(client.upload).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('AC-I4: too large shows the existing too-large toast', async () => {
    const { deps, notify } = setup([{ kind: 'too-large', limitBytes: MAX_STAGED_BYTES }]);
    expect(await resolveClipboardPaste('', deps)).toBeNull();
    expect(notify).toHaveBeenCalledWith(DROP_COPY.tooLargeTitle, DROP_COPY.tooLargeDetail('Clipboard image'));
  });

  it.each([
    [{ kind: 'refused', reason: 'drop-folder-full' } as const, REMOTE_UPLOAD_COPY.dropFolderFullDetail(HOST)],
    [{ kind: 'refused', reason: 'too-many-uploads' } as const, REMOTE_UPLOAD_COPY.tooManyUploadsDetail(HOST)],
    [{ kind: 'link-lost' } as const, REMOTE_UPLOAD_COPY.linkLostDetail],
    [{ kind: 'failed', reason: 'boom' } as const, 'boom'],
  ])('AC-I4: %o shows "Could not paste image" with its detail', async (result, detail) => {
    const { deps, notify } = setup([result]);
    expect(await resolveClipboardPaste('', deps)).toBeNull();
    expect(notify).toHaveBeenCalledWith(DROP_COPY.clipboardImageFailedTitle, detail);
  });

  it('AC-I4/AC-U12: an old host shows the old-host copy', async () => {
    const { deps, notify } = setup([{ kind: 'unsupported-host' }]);
    expect(await resolveClipboardPaste('', deps)).toBeNull();
    expect(notify.mock.calls).toEqual([
      [REMOTE_UPLOAD_COPY.sendFailedTitle(HOST), REMOTE_UPLOAD_COPY.oldHostDetail(HOST)],
    ]);
  });

  it('AC-D6: a cancelled paste types nothing and toasts nothing', async () => {
    const { deps, notify } = setup([{ kind: 'cancelled' }]);
    expect(await resolveClipboardPaste('', deps)).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'staged', path: '/p', style: 'posix' } as const],
    [{ kind: 'failed', reason: 'x' } as const],
  ])('closes its batch after %o, so progress stops being followed', async (result) => {
    const { deps, uploads, offProgress } = setup([result]);
    await resolveClipboardPaste('', deps);
    expect(offProgress).toHaveBeenCalledTimes(1);
    expect(uploads.view()).toBeNull();
  });
});
