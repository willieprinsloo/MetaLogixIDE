import { describe, it, expect, vi } from 'vitest';
import { planDrop, type DropDeps, type DropFile, type DropSnapshot } from '@renderer/terminal-drop';
import {
  DROP_COPY,
  MAX_STAGED_BYTES,
  type AppFileDragPayload,
  type ResolveAppFileResult,
  type StageFileRequest,
  type StageResult,
} from '@shared/terminal-drop-contract';

interface FakeFile extends DropFile {
  readonly path: string;
  readonly arrayBuffer: ReturnType<typeof vi.fn<() => Promise<ArrayBuffer>>>;
}

function file(name: string, opts: { path?: string; size?: number; type?: string } = {}): FakeFile {
  const size = opts.size ?? 0;
  return {
    name,
    type: opts.type ?? 'image/png',
    size,
    path: opts.path ?? '',
    arrayBuffer: vi.fn(async () => new Uint8Array(Math.min(size, 4)).fill(7).buffer),
  };
}

function snapshot(parts: Partial<DropSnapshot<FakeFile>>): DropSnapshot<FakeFile> {
  return { appFile: '', files: [], text: '', ...parts };
}

function deps(overrides: Partial<DropDeps<FakeFile>> = {}) {
  const notify = vi.fn<(title: string, detail: string) => void>();
  const stageFile = vi.fn<(r: StageFileRequest) => Promise<StageResult>>(async (r) => ({
    kind: 'staged',
    path: `/tmp/drops/${r.name}`,
  }));
  const resolveAppFile = vi.fn<(p: AppFileDragPayload) => Promise<ResolveAppFileResult>>(
    async (p) => ({ kind: 'resolved', path: `/proj/${p.relPath}` }),
  );
  const d: DropDeps<FakeFile> = {
    style: 'posix',
    pathForFile: (f) => f.path,
    resolveAppFile,
    stageFile,
    notify,
    ...overrides,
  };
  return { d, notify, stageFile, resolveAppFile };
}

const appFile = (relPath: string, projectId = 3) => JSON.stringify({ projectId, relPath });

describe('planDrop: OS files with paths (AC6)', () => {
  it('escapes resolved paths and joins them with single spaces', async () => {
    const { d, stageFile } = deps();
    const files = [file('a', { path: '/Users/me/My Screen (1).png' }), file('b', { path: '/x/y' })];
    await expect(planDrop(snapshot({ files }), d)).resolves.toBe(
      '/Users/me/My\\ Screen\\ \\(1\\).png /x/y',
    );
    expect(stageFile).not.toHaveBeenCalled();
  });

  it('uses the injected path style', async () => {
    const { d } = deps({ style: 'windows' });
    const files = [file('a', { path: 'C:\\My Docs\\a.png' })];
    await expect(planDrop(snapshot({ files }), d)).resolves.toBe('"C:\\My Docs\\a.png"');
  });

  it('prefers files over text/plain when both are present', async () => {
    const { d } = deps();
    const files = [file('a', { path: '/a' })];
    await expect(planDrop(snapshot({ files, text: 'ignored' }), d)).resolves.toBe('/a');
  });

  it('never emits CR or LF from a path containing a newline (AC3a)', async () => {
    const { d } = deps();
    const files = [file('a', { path: '/a/x\nrm -rf ~.png' })];
    const out = await planDrop(snapshot({ files }), d);
    expect(out).not.toMatch(/[\r\n]/);
  });
});

describe('planDrop: Files-tree drag (AC7, AC20a)', () => {
  it('resolves the payload through the injected resolver and escapes the absolute path', async () => {
    const { d, resolveAppFile } = deps();
    const out = await planDrop(snapshot({ appFile: appFile('src/my app.ts') }), d);
    expect(resolveAppFile).toHaveBeenCalledWith({ projectId: 3, relPath: 'src/my app.ts' });
    expect(out).toBe('/proj/src/my\\ app.ts');
  });

  it('wins over Files and text/plain: one path, no staging, no text', async () => {
    const { d, stageFile } = deps();
    const blob = file('blob.png', { size: 10 });
    const files = [blob, file('real', { path: '/elsewhere/real' })];
    const out = await planDrop(
      snapshot({ appFile: appFile('src/app.ts'), files, text: 'src/app.ts' }),
      d,
    );
    expect(out).toBe('/proj/src/app.ts');
    expect(stageFile).not.toHaveBeenCalled();
    expect(blob.arrayBuffer).not.toHaveBeenCalled();
  });

  it('toasts and inserts nothing when resolution fails', async () => {
    const resolveAppFile = vi.fn(async (): Promise<ResolveAppFileResult> => ({
      kind: 'failed',
      reason: 'outside project',
    }));
    const { d, notify } = deps({ resolveAppFile });
    const files = [file('real', { path: '/real' })];
    const out = await planDrop(snapshot({ appFile: appFile('../x'), files, text: 't' }), d);
    expect(out).toBeNull();
    expect(notify).toHaveBeenCalledWith(DROP_COPY.resolveFailedTitle, 'outside project');
  });

  it('toasts and inserts nothing when the resolver rejects', async () => {
    const resolveAppFile = vi.fn(async (): Promise<ResolveAppFileResult> => {
      throw new Error('ipc down');
    });
    const { d, notify } = deps({ resolveAppFile });
    await expect(planDrop(snapshot({ appFile: appFile('a') }), d)).resolves.toBeNull();
    expect(notify).toHaveBeenCalledWith(DROP_COPY.resolveFailedTitle, 'ipc down');
  });

  it.each([
    ['not json', '{nope'],
    ['a non-object', '"src/a.ts"'],
    ['null', 'null'],
    ['a missing relPath', JSON.stringify({ projectId: 3 })],
    ['a non-string relPath', JSON.stringify({ projectId: 3, relPath: 4 })],
    ['a non-integer projectId', JSON.stringify({ projectId: 1.5, relPath: 'a' })],
    ['a string projectId', JSON.stringify({ projectId: '3', relPath: 'a' })],
  ])('ignores the Files-tree branch when the payload is %s', async (_label, raw) => {
    const { d, resolveAppFile, notify } = deps();
    const out = await planDrop(snapshot({ appFile: raw, text: 'fallback text' }), d);
    expect(resolveAppFile).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(out).toBe('fallback text');
  });
});

describe('planDrop: text-only drops (AC8)', () => {
  it('inserts text verbatim, unescaped and unquoted', async () => {
    const { d } = deps();
    await expect(planDrop(snapshot({ text: 'echo "a b" (x)' }), d)).resolves.toBe('echo "a b" (x)');
  });

  it('sanitises control characters in dropped text (AC2)', async () => {
    const { d } = deps();
    await expect(planDrop(snapshot({ text: 'a\x1b[201~b\nc' }), d)).resolves.toBe('a [201~b\nc');
  });
});

describe('planDrop: pathless files with bytes (AC9, AC10)', () => {
  it('stages the bytes with name and MIME and inserts the escaped staged path', async () => {
    const { d, stageFile } = deps();
    const f = file('shot one.png', { size: 3, type: 'image/png' });
    const out = await planDrop(snapshot({ files: [f] }), d);
    expect(stageFile).toHaveBeenCalledTimes(1);
    const req = stageFile.mock.calls[0]?.[0];
    if (!req) throw new Error('stageFile was not called');
    expect(req.name).toBe('shot one.png');
    expect(req.mime).toBe('image/png');
    expect(req.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(req.bytes)).toEqual([7, 7, 7]);
    expect(out).toBe('/tmp/drops/shot\\ one.png');
  });

  it('keeps drop order for a mixed drop when the first staging call is slow', async () => {
    const stageFile = vi.fn(async (r: StageFileRequest): Promise<StageResult> => {
      const delay = r.name === 'first.png' ? 20 : 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return { kind: 'staged', path: `/s/${r.name}` };
    });
    const { d } = deps({ stageFile });
    const files = [
      file('first.png', { size: 2 }),
      file('real', { path: '/real/one' }),
      file('second.png', { size: 2 }),
    ];
    const out = await planDrop(snapshot({ files }), d);
    expect(out).toBe('/s/first.png /real/one /s/second.png');
  });

  it('reads and stages one pathless file at a time, so peak memory is one file', async () => {
    let inFlight = 0;
    let peak = 0;
    const events: string[] = [];
    const tracked = (name: string): FakeFile => {
      const f = file(name, { size: 4 });
      f.arrayBuffer.mockImplementation(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        events.push(`read ${name}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Uint8Array(4).buffer;
      });
      return f;
    };
    const stageFile = vi.fn(async (r: StageFileRequest): Promise<StageResult> => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`staged ${r.name}`);
      inFlight -= 1;
      return { kind: 'staged', path: `/s/${r.name}` };
    });
    const { d } = deps({ stageFile });
    const out = await planDrop(snapshot({ files: [tracked('a'), tracked('b'), tracked('c')] }), d);
    expect(peak).toBe(1);
    expect(events).toEqual(['read a', 'staged a', 'read b', 'staged b', 'read c', 'staged c']);
    expect(out).toBe('/s/a /s/b /s/c');
  });

  it('stages a file exactly at the size limit', async () => {
    const { d, stageFile } = deps();
    await planDrop(snapshot({ files: [file('big.png', { size: MAX_STAGED_BYTES })] }), d);
    expect(stageFile).toHaveBeenCalledTimes(1);
  });
});

describe('planDrop: nothing usable (AC11)', () => {
  it('returns null for an empty snapshot', async () => {
    const { d, notify } = deps();
    await expect(planDrop(snapshot({}), d)).resolves.toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it('skips a zero-byte pathless file without reading, staging or toasting', async () => {
    const { d, notify, stageFile } = deps();
    const f = file('empty', { size: 0 });
    await expect(planDrop(snapshot({ files: [f] }), d)).resolves.toBeNull();
    expect(f.arrayBuffer).not.toHaveBeenCalled();
    expect(stageFile).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('returns null rather than an empty string so the caller never pastes nothing', async () => {
    const { d } = deps();
    const out = await planDrop(snapshot({ files: [file('empty')], text: '' }), d);
    expect(out).toBeNull();
  });
});

describe('planDrop: limits and failures (AC14, AC15)', () => {
  it('toasts the limit for an over-size pathless file and never reads its bytes', async () => {
    const { d, notify, stageFile } = deps();
    const f = file('huge.mov', { size: MAX_STAGED_BYTES + 1 });
    await expect(planDrop(snapshot({ files: [f] }), d)).resolves.toBeNull();
    expect(f.arrayBuffer).not.toHaveBeenCalled();
    expect(stageFile).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      DROP_COPY.tooLargeTitle,
      DROP_COPY.tooLargeDetail('huge.mov'),
    );
  });

  it('still inserts the other items when one is over the limit', async () => {
    const { d } = deps();
    const files = [file('huge', { size: MAX_STAGED_BYTES + 1 }), file('ok', { path: '/ok' })];
    await expect(planDrop(snapshot({ files }), d)).resolves.toBe('/ok');
  });

  it('toasts the reason and keeps the other items when staging fails', async () => {
    const stageFile = vi.fn(async (r: StageFileRequest): Promise<StageResult> =>
      r.name === 'bad.png'
        ? { kind: 'failed', reason: 'disk full' }
        : { kind: 'staged', path: `/s/${r.name}` },
    );
    const { d, notify } = deps({ stageFile });
    const files = [
      file('bad.png', { size: 2 }),
      file('good.png', { size: 2 }),
      file('p', { path: '/p' }),
    ];
    await expect(planDrop(snapshot({ files }), d)).resolves.toBe('/s/good.png /p');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(DROP_COPY.stageFailedTitle, 'disk full');
  });

  it('toasts the limit when the main process reports too-large', async () => {
    const stageFile = vi.fn(async (): Promise<StageResult> => ({
      kind: 'too-large',
      limitBytes: MAX_STAGED_BYTES,
    }));
    const { d, notify } = deps({ stageFile });
    await expect(
      planDrop(snapshot({ files: [file('x.png', { size: 5 })] }), d),
    ).resolves.toBeNull();
    expect(notify).toHaveBeenCalledWith(DROP_COPY.tooLargeTitle, DROP_COPY.tooLargeDetail('x.png'));
  });

  it('toasts and skips the item when staging rejects', async () => {
    const stageFile = vi.fn(async (): Promise<StageResult> => {
      throw new Error('no handler');
    });
    const { d, notify } = deps({ stageFile });
    const files = [file('x.png', { size: 5 }), file('p', { path: '/p' })];
    await expect(planDrop(snapshot({ files }), d)).resolves.toBe('/p');
    expect(notify).toHaveBeenCalledWith(DROP_COPY.stageFailedTitle, 'no handler');
  });

  it('toasts and skips the item when reading its bytes rejects', async () => {
    const { d, notify, stageFile } = deps();
    const f = file('gone.png', { size: 5 });
    f.arrayBuffer.mockRejectedValueOnce(new Error('NotReadableError'));
    await expect(planDrop(snapshot({ files: [f] }), d)).resolves.toBeNull();
    expect(stageFile).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(DROP_COPY.stageFailedTitle, 'NotReadableError');
  });

  it('reports a non-Error rejection as its string form', async () => {
    const stageFile = vi.fn((): Promise<StageResult> => Promise.reject('channel closed'));
    const { d, notify } = deps({ stageFile });
    await expect(
      planDrop(snapshot({ files: [file('x.png', { size: 5 })] }), d),
    ).resolves.toBeNull();
    expect(notify).toHaveBeenCalledWith(DROP_COPY.stageFailedTitle, 'channel closed');
  });
});
