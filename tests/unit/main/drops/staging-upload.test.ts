import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createDropStaging, type DropStaging, type UploadSink } from '@main/drops/staging';

const faults = vi.hoisted(() => ({ linkCode: null as string | null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    link: async (...args: Parameters<typeof real.link>) => {
      if (faults.linkCode) throw Object.assign(new Error(faults.linkCode), { code: faults.linkCode });
      await real.link(...args);
    },
  };
});

const NOW = new Date(Date.UTC(2026, 9, 17, 9, 5, 7, 42));
const posix = process.platform !== 'win32';
const realUid = posix ? process.getuid!() : null;
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

let root: string;
let dir: string;

function staging(overrides: { uid?: number | null; dir?: string } = {}): DropStaging {
  return createDropStaging({
    dir: overrides.dir ?? dir,
    now: () => NOW,
    uid: overrides.uid === undefined ? realUid : overrides.uid,
  });
}

async function openSink(s: DropStaging = staging()): Promise<UploadSink> {
  const opened = await s.openUpload();
  if (opened.kind !== 'open') throw new Error(`expected open, got ${JSON.stringify(opened)}`);
  return opened.sink;
}

function stagedPath(result: { kind: string; path?: string }): string {
  if (result.kind !== 'staged' || result.path === undefined)
    throw new Error(`expected staged, got ${JSON.stringify(result)}`);
  return result.path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'drops-upload-'));
  dir = join(root, 'metaide-drops-test');
});

afterEach(() => {
  faults.linkCode = null;
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
});

describe('openUpload (B-S3)', () => {
  it('creates one hidden owner-only .part file inside a fresh 0700 directory', async () => {
    await openSink();
    const names = readdirSync(dir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^\.[0-9a-f]{16,}\.part$/);
    if (posix) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, names[0]!)).mode & 0o777).toBe(0o600);
    }
  });

  it('gives each sink its own temp file', async () => {
    await openSink();
    await openSink();
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it.runIf(posix)('refuses a symlinked staging directory without creating anything', async () => {
    const real = join(root, 'real');
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, dir);
    const opened = await staging().openUpload();
    expect(opened).toEqual({ kind: 'failed', reason: expect.stringContaining('symlink') });
    expect(readdirSync(real)).toEqual([]);
  });

  it.runIf(posix)('refuses a 0755 staging directory', async () => {
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    const opened = await staging().openUpload();
    expect(opened).toEqual({ kind: 'failed', reason: expect.stringContaining('mode 755') });
    expect(readdirSync(dir)).toEqual([]);
  });

  it.runIf(posix)('refuses a directory owned by another uid', async () => {
    const opened = await staging({ uid: realUid! + 1 }).openUpload();
    expect(opened).toEqual({ kind: 'failed', reason: expect.stringContaining('owned by uid') });
  });

  it('reports an unusable staging location as failed instead of throwing', async () => {
    writeFileSync(dir, 'not a dir');
    const opened = await staging().openUpload();
    expect(opened.kind).toBe('failed');
  });
});

describe('UploadSink append and commit (B-S3, B-S4, B-P1)', () => {
  it('writes appended chunks to disk as they arrive, before commit', async () => {
    const sink = await openSink();
    await sink.append(bytes('hello '));
    const part = join(dir, readdirSync(dir)[0]!);
    expect(readFileSync(part, 'utf8')).toBe('hello ');
    await sink.append(bytes('world'));
    expect(readFileSync(part, 'utf8')).toBe('hello world');
  });

  it('commits under a sanitised basename, removes the temp file and keeps 0600', async () => {
    const sink = await openSink();
    await sink.append(bytes('payload'));
    const path = stagedPath(await sink.commit('../../etc/passwd', 'text/plain', 'file'));
    expect(path).toBe(join(dir, 'passwd'));
    expect(readFileSync(path, 'utf8')).toBe('payload');
    expect(readdirSync(dir)).toEqual(['passwd']);
    if (posix) expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('names a clipboard image pasted-<timestamp>.png whatever name was sent', async () => {
    const sink = await openSink();
    await sink.append(bytes('png'));
    const path = stagedPath(await sink.commit('evil.sh', 'image/png', 'clipboard-image'));
    expect(basename(path)).toBe('pasted-20261017-090507-042.png');
  });

  it('never clobbers an existing staged file', async () => {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    writeFileSync(join(dir, 'shot.png'), 'original');
    const sink = await openSink();
    await sink.append(bytes('new'));
    const path = stagedPath(await sink.commit('shot.png', 'image/png', 'file'));
    expect(basename(path)).toBe('shot-1.png');
    expect(readFileSync(join(dir, 'shot.png'), 'utf8')).toBe('original');
    expect(readFileSync(path, 'utf8')).toBe('new');
  });

  it('commits a zero-byte upload as an empty file (AC-D10)', async () => {
    const sink = await openSink();
    const path = stagedPath(await sink.commit('empty.txt', 'text/plain', 'file'));
    expect(readFileSync(path).byteLength).toBe(0);
  });

  it('falls back to a dropped-<timestamp> name when nothing of the name survives', async () => {
    const sink = await openSink();
    const path = stagedPath(await sink.commit('...', 'application/pdf', 'file'));
    expect(basename(path)).toBe('dropped-20261017-090507-042.pdf');
  });

  it.runIf(posix)('refuses to commit when the directory became untrusted, leaving no file behind', async () => {
    const sink = await openSink();
    await sink.append(bytes('x'));
    chmodSync(dir, 0o755);
    const result = await sink.commit('a.txt', 'text/plain', 'file');
    expect(result).toEqual({ kind: 'failed', reason: expect.stringContaining('mode 755') });
    chmodSync(dir, 0o700);
    expect(readdirSync(dir)).toEqual([]);
  });

  it.runIf(posix)('refuses to commit when the directory was swapped for a symlink', async () => {
    const sink = await openSink();
    const moved = join(root, 'moved');
    const { renameSync } = await import('node:fs');
    renameSync(dir, moved);
    const decoy = join(root, 'decoy');
    mkdirSync(decoy, { mode: 0o700 });
    symlinkSync(decoy, dir);
    const result = await sink.commit('a.txt', 'text/plain', 'file');
    expect(result).toEqual({ kind: 'failed', reason: expect.stringContaining('symlink') });
    expect(readdirSync(decoy)).toEqual([]);
  });

  it('refuses append and commit once the sink has finished', async () => {
    const sink = await openSink();
    stagedPath(await sink.commit('a.txt', 'text/plain', 'file'));
    await expect(sink.append(bytes('late'))).rejects.toThrow(/finished/);
    expect((await sink.commit('b.txt', 'text/plain', 'file')).kind).toBe('failed');
    expect(readdirSync(dir)).toEqual(['a.txt']);
  });
});

describe('UploadSink commit without hard links (risk R-B)', () => {
  it('copies exclusively when the filesystem refuses hard links, still without clobbering', async () => {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    writeFileSync(join(dir, 'a.txt'), 'original');
    faults.linkCode = 'EPERM';
    const sink = await openSink();
    await sink.append(bytes('copied'));
    const path = stagedPath(await sink.commit('a.txt', 'text/plain', 'file'));
    expect(basename(path)).toBe('a-1.txt');
    expect(readFileSync(path, 'utf8')).toBe('copied');
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('original');
    expect(readdirSync(dir).sort()).toEqual(['a-1.txt', 'a.txt']);
  });

  it('reports any other link failure as failed and removes the temp file', async () => {
    faults.linkCode = 'EIO';
    const sink = await openSink();
    const result = await sink.commit('a.txt', 'text/plain', 'file');
    expect(result).toEqual({ kind: 'failed', reason: 'EIO' });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('UploadSink abort (AC-U6)', () => {
  it('leaves the directory exactly as it was before the upload', async () => {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    writeFileSync(join(dir, 'keep.txt'), 'k');
    const before = readdirSync(dir);
    const sink = await openSink();
    await sink.append(bytes('partial'));
    await sink.abort();
    expect(readdirSync(dir)).toEqual(before);
  });

  it('is idempotent and safe after commit', async () => {
    const sink = await openSink();
    const path = stagedPath(await sink.commit('a.txt', 'text/plain', 'file'));
    await sink.abort();
    await sink.abort();
    expect(existsSync(path)).toBe(true);
  });
});

describe('usageBytes (R3)', () => {
  it('is zero when the directory does not exist yet', async () => {
    await expect(staging().usageBytes()).resolves.toBe(0);
  });

  it('sums staged files and in-progress .part files, ignoring subdirectories', async () => {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    writeFileSync(join(dir, 'a.bin'), Buffer.alloc(100));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'inner.bin'), Buffer.alloc(1000));
    const sink = await openSink();
    await sink.append(new Uint8Array(23));
    await expect(staging().usageBytes()).resolves.toBe(123);
  });

  it.runIf(posix)('rejects when the directory is untrusted', async () => {
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    await expect(staging().usageBytes()).rejects.toThrow(/mode 755/);
  });
});
