/**
 * Contract tests for `planRemoteDrop` (AC-D1..D4, AC-D6, AC-D9, AC-D10, AC-U2, AC-U5, AC-U12,
 * decisions Q2/Q4/OQ5) with fake upload, stat, confirm and notify effects. No IPC is involved.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  dropOverlayLabel,
  formatUploadSize,
  planRemoteDrop,
  type RemoteDropDeps,
} from '@renderer/remote-upload/remote-drop';
import type { DropFile, DropSnapshot } from '@renderer/terminal-drop';
import {
  REMOTE_UPLOAD_COPY,
  type StatAppFileResult,
  type UploadResult,
  type UploadSource,
} from '@shared/remote-upload-contract';
import { DROP_COPY, MAX_STAGED_BYTES, type PathStyle } from '@shared/terminal-drop-contract';

const MB = 1024 * 1024;
const HOST = 'tower';

interface FakeFile extends DropFile {
  readonly read: ReturnType<typeof vi.fn>;
  readonly path?: string;
}

function file(name: string, size = 3, type = 'text/plain'): FakeFile {
  const read = vi.fn(async () => new Uint8Array(size).buffer);
  return { name, size, type, read, arrayBuffer: read };
}

function snapshot(
  files: FakeFile[],
  extra: Partial<DropSnapshot<FakeFile>> = {},
): DropSnapshot<FakeFile> {
  return { appFile: '', files, text: '', ...extra };
}

const staged = (path: string, style: PathStyle = 'posix'): UploadResult => ({ kind: 'staged', path, style });

function makeDeps(results: Record<string, UploadResult> = {}, confirmAnswer = true) {
  const uploads: { source: UploadSource; index: number; count: number; name: string; confirmed: boolean }[] = [];
  const notify = vi.fn();
  const confirm = vi.fn(() => confirmAnswer);
  const statAppFile = vi.fn(
    async (): Promise<StatAppFileResult> => ({ kind: 'ok', name: 'main.ts', size: 10, isDirectory: false }),
  );
  const deps: RemoteDropDeps = {
    hostName: HOST,
    upload: vi.fn(async (source, item, confirmed) => {
      uploads.push({ source, ...item, confirmed });
      return results[item.name] ?? staged(`/tmp/drops/${item.name}`);
    }),
    statAppFile,
    confirm,
    notify,
  };
  return { deps, uploads, notify, confirm, statAppFile };
}

describe('planRemoteDrop', () => {
  it('AC-D1: uploads an OS file that has a viewer path and types only the host path', async () => {
    const { deps, uploads } = makeDeps();
    const f = { ...file('a.txt'), path: '/Users/me/a.txt' };
    const payload = await planRemoteDrop(snapshot([f]), deps);
    expect(payload).toBe('/tmp/drops/a.txt');
    expect(payload).not.toContain('/Users/me');
    expect(uploads[0]?.source).toEqual({
      kind: 'bytes',
      name: 'a.txt',
      mime: 'text/plain',
      bytes: new Uint8Array(3),
    });
  });

  it('AC-D2: a Files-tree payload is statted then uploaded by reference, typing the host path', async () => {
    const { deps, uploads, statAppFile } = makeDeps({ 'main.ts': staged('/tmp/drops/main.ts') });
    const appFile = JSON.stringify({ projectId: 7, relPath: 'src/main.ts' });
    const payload = await planRemoteDrop(snapshot([], { appFile }), deps);
    expect(statAppFile).toHaveBeenCalledWith({ projectId: 7, relPath: 'src/main.ts' });
    expect(uploads[0]?.source).toEqual({ kind: 'app-file', projectId: 7, relPath: 'src/main.ts' });
    expect(payload).toBe('/tmp/drops/main.ts');
  });

  it('AC-D2: a failed stat toasts the resolve failure and uploads nothing', async () => {
    const { deps, uploads, notify, statAppFile } = makeDeps();
    statAppFile.mockResolvedValueOnce({ kind: 'failed', reason: 'outside project' });
    const appFile = JSON.stringify({ projectId: 7, relPath: '../x' });
    expect(await planRemoteDrop(snapshot([], { appFile }), deps)).toBeNull();
    expect(notify).toHaveBeenCalledWith(DROP_COPY.resolveFailedTitle, 'outside project');
    expect(uploads).toHaveLength(0);
  });

  it('AC-D2/AC-D9: a Files-tree folder is refused with the folder toast', async () => {
    const { deps, uploads, notify, statAppFile } = makeDeps();
    statAppFile.mockResolvedValueOnce({ kind: 'ok', name: 'src', size: 0, isDirectory: true });
    const appFile = JSON.stringify({ projectId: 7, relPath: 'src' });
    expect(await planRemoteDrop(snapshot([], { appFile }), deps)).toBeNull();
    expect(notify).toHaveBeenCalledWith(REMOTE_UPLOAD_COPY.folderRefusedTitle(HOST), 'src');
    expect(uploads).toHaveLength(0);
  });

  it('AC-D3: uploads one file at a time and labels each "n of m"', async () => {
    const gates: Array<(r: UploadResult) => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const { deps } = makeDeps();
    deps.upload = vi.fn(
      (_source: UploadSource, item: { name: string; index: number; count: number }) =>
        new Promise<UploadResult>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          gates.push((r) => {
            inFlight -= 1;
            resolve(r);
          });
          expect(item.count).toBe(3);
        }),
    );
    const done = planRemoteDrop(snapshot([file('a'), file('b'), file('c')]), deps);
    for (const name of ['a', 'b', 'c']) {
      await vi.waitFor(() => expect(gates).toHaveLength(['a', 'b', 'c'].indexOf(name) + 1));
      gates.at(-1)?.(staged(`/h/${name}`));
    }
    expect(await done).toBe('/h/a /h/b /h/c');
    expect(maxInFlight).toBe(1);
    expect(vi.mocked(deps.upload).mock.calls.map((c) => c[1])).toEqual([
      { name: 'a', index: 1, count: 3 },
      { name: 'b', index: 2, count: 3 },
      { name: 'c', index: 3, count: 3 },
    ]);
  });

  it('AC-D3: types the successes in order and toasts each failure naming its file', async () => {
    const { deps, notify } = makeDeps({
      b: { kind: 'failed', reason: 'disk error' },
      d: { kind: 'link-lost' },
    });
    const payload = await planRemoteDrop(snapshot([file('a'), file('b'), file('c'), file('d')]), deps);
    expect(payload).toBe('/tmp/drops/a /tmp/drops/c');
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(REMOTE_UPLOAD_COPY.sendFileFailedTitle('b', HOST), 'disk error');
    expect(notify).toHaveBeenCalledWith(
      REMOTE_UPLOAD_COPY.sendFileFailedTitle('d', HOST),
      REMOTE_UPLOAD_COPY.linkLostDetail,
    );
  });

  it('AC-U8: host refusals toast the specific detail', async () => {
    const { deps, notify } = makeDeps({
      a: { kind: 'refused', reason: 'drop-folder-full' },
      b: { kind: 'refused', reason: 'too-many-uploads' },
      c: { kind: 'too-large', limitBytes: MAX_STAGED_BYTES },
    });
    expect(await planRemoteDrop(snapshot([file('a'), file('b'), file('c')]), deps)).toBeNull();
    expect(notify.mock.calls).toEqual([
      [REMOTE_UPLOAD_COPY.sendFileFailedTitle('a', HOST), REMOTE_UPLOAD_COPY.dropFolderFullDetail(HOST)],
      [REMOTE_UPLOAD_COPY.sendFileFailedTitle('b', HOST), REMOTE_UPLOAD_COPY.tooManyUploadsDetail(HOST)],
      [DROP_COPY.tooLargeTitle, DROP_COPY.tooLargeDetail('c')],
    ]);
  });

  it('a file whose bytes cannot be read toasts and the rest proceed', async () => {
    const { deps, notify } = makeDeps();
    const bad = file('bad');
    bad.read.mockRejectedValueOnce(new Error('gone'));
    expect(await planRemoteDrop(snapshot([bad, file('ok')]), deps)).toBe('/tmp/drops/ok');
    expect(notify).toHaveBeenCalledWith(REMOTE_UPLOAD_COPY.sendFileFailedTitle('bad', HOST), 'gone');
  });

  it('AC-D4: a text-only drop types sanitised text and uploads nothing', async () => {
    const { deps, uploads } = makeDeps();
    expect(await planRemoteDrop(snapshot([], { text: 'echo hi\x1b[31m' }), deps)).toBe('echo hi [31m');
    expect(await planRemoteDrop(snapshot([], { text: '' }), deps)).toBeNull();
    expect(uploads).toHaveLength(0);
  });

  it('AC-D6/Q4: a cancel mid-drop types nothing at all and shows no toast', async () => {
    const { deps, notify, uploads } = makeDeps({ b: { kind: 'cancelled' } });
    expect(await planRemoteDrop(snapshot([file('a'), file('b'), file('c')]), deps)).toBeNull();
    expect(notify).not.toHaveBeenCalled();
    expect(uploads.map((u) => u.name)).toEqual(['a', 'b']);
  });

  it('AC-D9: a dropped folder toasts with the host name and the other files proceed', async () => {
    const { deps, notify, uploads } = makeDeps();
    const folder = file('photos', 0);
    const payload = await planRemoteDrop(
      snapshot([file('a'), folder, file('b')], { isDirectory: [false, true, false] }),
      deps,
    );
    expect(payload).toBe('/tmp/drops/a /tmp/drops/b');
    expect(notify).toHaveBeenCalledWith(REMOTE_UPLOAD_COPY.folderRefusedTitle(HOST), 'photos');
    expect(folder.read).not.toHaveBeenCalled();
    expect(uploads.map((u) => [u.name, u.index, u.count])).toEqual([
      ['a', 1, 2],
      ['b', 2, 2],
    ]);
  });

  it('AC-D10: a zero-byte file that is not a folder uploads and types its path', async () => {
    const { deps } = makeDeps();
    expect(await planRemoteDrop(snapshot([file('empty', 0)]), deps)).toBe('/tmp/drops/empty');
  });

  it('AC-U5: a file over 50 MB toasts and is never read or sent', async () => {
    const { deps, notify, uploads } = makeDeps();
    const huge = file('huge.mov', MAX_STAGED_BYTES + 1);
    expect(await planRemoteDrop(snapshot([huge, file('a')]), deps)).toBe('/tmp/drops/a');
    expect(huge.read).not.toHaveBeenCalled();
    expect(uploads.map((u) => u.name)).toEqual(['a']);
    expect(notify).toHaveBeenCalledWith(DROP_COPY.tooLargeTitle, DROP_COPY.tooLargeDetail('huge.mov'));
  });

  it('a file of exactly 50 MB is allowed', async () => {
    const { deps } = makeDeps();
    expect(await planRemoteDrop(snapshot([file('edge', MAX_STAGED_BYTES)]), deps)).toBe('/tmp/drops/edge');
  });

  it('AC-U12: an old host gets the exact copy once and the remaining files are not attempted', async () => {
    const { deps, notify, uploads } = makeDeps({ a: { kind: 'unsupported-host' } });
    expect(await planRemoteDrop(snapshot([file('a'), file('b')]), deps)).toBeNull();
    expect(notify.mock.calls).toEqual([
      [REMOTE_UPLOAD_COPY.sendFailedTitle(HOST), REMOTE_UPLOAD_COPY.oldHostDetail(HOST)],
    ]);
    expect(uploads.map((u) => u.name)).toEqual(['a']);
  });

  it('Q2/OQ5: one confirm lists every file over 10 MB with its size and the host', async () => {
    const { deps, confirm, uploads } = makeDeps();
    const big1 = file('big1.mov', 12 * MB);
    const big2 = file('big2.mov', 20.5 * MB);
    await planRemoteDrop(snapshot([big1, file('small'), big2]), deps);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      REMOTE_UPLOAD_COPY.confirmMessage(
        [
          { name: 'big1.mov', size: '12.0 MB' },
          { name: 'big2.mov', size: '20.5 MB' },
        ],
        HOST,
      ),
    );
    expect(uploads.map((u) => u.confirmed)).toEqual([true, true, true]);
  });

  it('Q2: declining the confirm sends nothing, small files included, and types nothing', async () => {
    const { deps, uploads, notify } = makeDeps({}, false);
    const big = file('big.mov', 11 * MB);
    const small = file('small');
    expect(await planRemoteDrop(snapshot([small, big]), deps)).toBeNull();
    expect(uploads).toHaveLength(0);
    expect(small.read).not.toHaveBeenCalled();
    expect(big.read).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('Q2: files of 10 MB or less upload with no confirm', async () => {
    const { deps, confirm } = makeDeps();
    await planRemoteDrop(snapshot([file('a', 10 * MB), file('b')]), deps);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('Q2: an over-50 MB file is refused before the confirm and is not listed in it', async () => {
    const { deps, confirm } = makeDeps();
    await planRemoteDrop(snapshot([file('huge', MAX_STAGED_BYTES + 1), file('big', 11 * MB)]), deps);
    expect(confirm).toHaveBeenCalledWith(
      REMOTE_UPLOAD_COPY.confirmMessage([{ name: 'big', size: '11.0 MB' }], HOST),
    );
  });

  it('AC-U2: a Windows host gets double-quoted paths', async () => {
    const { deps } = makeDeps({
      a: staged('C:\\Users\\me\\drops\\my file.txt', 'windows'),
      b: staged('C:\\Users\\me\\drops\\b.txt', 'windows'),
    });
    expect(await planRemoteDrop(snapshot([file('a'), file('b')]), deps)).toBe(
      '"C:\\Users\\me\\drops\\my file.txt" C:\\Users\\me\\drops\\b.txt',
    );
  });

  it('AC-U2: a POSIX host gets backslash-escaped paths', async () => {
    const { deps } = makeDeps({ a: staged('/tmp/drops/my file (1).png', 'posix') });
    expect(await planRemoteDrop(snapshot([file('a')]), deps)).toBe('/tmp/drops/my\\ file\\ \\(1\\).png');
  });

  it('the Files-tree payload wins over files and text, as locally', async () => {
    const { deps, uploads } = makeDeps();
    const appFile = JSON.stringify({ projectId: 1, relPath: 'x' });
    await planRemoteDrop(snapshot([file('os')], { appFile, text: 'hello' }), deps);
    expect(uploads.map((u) => u.source.kind)).toEqual(['app-file']);
  });

  it('an unparseable Files-tree payload falls back to the files', async () => {
    const { deps, uploads } = makeDeps();
    await planRemoteDrop(snapshot([file('os')], { appFile: '{nope' }), deps);
    expect(uploads.map((u) => u.name)).toEqual(['os']);
  });
});

describe('formatUploadSize', () => {
  it('formats bytes as MB with one decimal', () => {
    expect(formatUploadSize(10 * MB + 1)).toBe('10.0 MB');
    expect(formatUploadSize(52_428_800)).toBe('50.0 MB');
  });
});

describe('dropOverlayLabel (AC-D11)', () => {
  it('reads "Drop to send to <host>" for path drags on a remote terminal', () => {
    expect(dropOverlayLabel('path', HOST)).toBe(REMOTE_UPLOAD_COPY.overlaySend(HOST));
  });
  it('keeps "Drop to paste text" for text drags on a remote terminal', () => {
    expect(dropOverlayLabel('text', HOST)).toBe(DROP_COPY.overlayText);
  });
  it('keeps the local copy when there is no host', () => {
    expect(dropOverlayLabel('path', null)).toBe(DROP_COPY.overlayPath);
    expect(dropOverlayLabel('text', null)).toBe(DROP_COPY.overlayText);
  });
});
