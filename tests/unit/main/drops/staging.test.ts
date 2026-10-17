import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
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
import { basename, join, resolve } from 'node:path';
import { createDropStaging, defaultDropDir, type DropStaging } from '@main/drops/staging';
import { MAX_STAGED_BYTES } from '@shared/terminal-drop-contract';

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

function stagedPath(result: Awaited<ReturnType<DropStaging['stage']>>): string {
  if (result.kind !== 'staged') throw new Error(`expected staged, got ${JSON.stringify(result)}`);
  return result.path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'drops-test-'));
  dir = join(root, 'metaide-drops-test');
});

afterEach(() => {
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
});

describe('defaultDropDir', () => {
  it('includes the uid on POSIX platforms', () => {
    expect(defaultDropDir('darwin', '/tmp', 501)).toBe(join('/tmp', 'metaide-drops-501'));
    expect(defaultDropDir('linux', '/var/tmp', 1000)).toBe(join('/var/tmp', 'metaide-drops-1000'));
  });

  it('omits the uid on Windows', () => {
    expect(defaultDropDir('win32', 'C:\\Temp', null)).toBe(join('C:\\Temp', 'metaide-drops'));
  });
});

describe('stage — directory creation and file writes (AC9, AC17)', () => {
  it('creates the directory, writes the bytes and returns the absolute path', async () => {
    const path = stagedPath(await staging().stage('shot.png', 'image/png', bytes('PNGDATA')));
    expect(path).toBe(resolve(dir, 'shot.png'));
    expect(readFileSync(path, 'utf8')).toBe('PNGDATA');
  });

  it('sanitises the renderer-supplied name before writing', async () => {
    const path = stagedPath(await staging().stage('../../etc/passwd', 'text/plain', bytes('x')));
    expect(path).toBe(resolve(dir, 'passwd'));
    expect(existsSync(join(root, 'etc'))).toBe(false);
  });

  it('falls back to a timestamped name derived from the MIME type', async () => {
    const path = stagedPath(await staging().stage('', 'image/png', bytes('x')));
    expect(path).toBe(resolve(dir, 'dropped-20261017-090507-042.png'));
  });

  it.skipIf(!posix)(
    'creates the directory with mode 0700 and the file with mode 0600',
    async () => {
      const path = stagedPath(await staging().stage('a.txt', 'text/plain', bytes('x')));
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );

  it('stages into an existing trusted directory', async () => {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    expect(stagedPath(await staging().stage('a.txt', 'text/plain', bytes('x')))).toBe(
      resolve(dir, 'a.txt'),
    );
  });

  it('stages an empty byte array as an empty file', async () => {
    const path = stagedPath(await staging().stage('empty.txt', 'text/plain', new Uint8Array(0)));
    expect(readFileSync(path).length).toBe(0);
  });
});

describe('stage — collisions never overwrite (AC9, AC17)', () => {
  it('suffixes -1, then -2, and leaves earlier files byte-identical', async () => {
    const s = staging();
    const first = stagedPath(await s.stage('shot.png', 'image/png', bytes('one')));
    const second = stagedPath(await s.stage('shot.png', 'image/png', bytes('two')));
    const third = stagedPath(await s.stage('shot.png', 'image/png', bytes('three')));
    expect([first, second, third]).toEqual([
      resolve(dir, 'shot.png'),
      resolve(dir, 'shot-1.png'),
      resolve(dir, 'shot-2.png'),
    ]);
    expect(readFileSync(first, 'utf8')).toBe('one');
    expect(readFileSync(second, 'utf8')).toBe('two');
    expect(readFileSync(third, 'utf8')).toBe('three');
  });

  it('suffixes a name without an extension at the end', async () => {
    const s = staging();
    await s.stage('notes', 'text/plain', bytes('a'));
    expect(stagedPath(await s.stage('notes', 'text/plain', bytes('b')))).toBe(
      resolve(dir, 'notes-1'),
    );
  });

  it('keeps a suffixed 100-character name within 100 characters and keeps the extension', async () => {
    const s = staging();
    const name = `${'a'.repeat(96)}.png`;
    const paths = [];
    for (let n = 0; n < 12; n += 1)
      paths.push(stagedPath(await s.stage(name, 'image/png', bytes(`${n}`))));
    expect(paths[0]).toBe(resolve(dir, name));
    expect(paths[1]).toBe(resolve(dir, `${'a'.repeat(94)}-1.png`));
    expect(paths[11]).toBe(resolve(dir, `${'a'.repeat(93)}-11.png`));
    for (const p of paths) expect(basename(p).length).toBeLessThanOrEqual(100);
    expect(new Set(paths).size).toBe(12);
  });

  it('keeps a suffixed name within 100 characters when the extension leaves no room for a stem', async () => {
    const s = staging();
    const name = `a.${'b'.repeat(98)}`;
    await s.stage(name, 'text/plain', bytes('1'));
    const second = basename(stagedPath(await s.stage(name, 'text/plain', bytes('2'))));
    expect(second).toBe(`a.${'b'.repeat(96)}-1`);
  });

  it.skipIf(!posix)('never follows a pre-planted symlink at the target name', async () => {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    const victim = join(root, 'victim.txt');
    writeFileSync(victim, 'original');
    symlinkSync(victim, join(dir, 'shot.png'));
    const path = stagedPath(await staging().stage('shot.png', 'image/png', bytes('attack')));
    expect(path).toBe(resolve(dir, 'shot-1.png'));
    expect(readFileSync(victim, 'utf8')).toBe('original');
    expect(lstatSync(join(dir, 'shot.png')).isSymbolicLink()).toBe(true);
  });

  it('gives up with a failed value after a bounded number of collisions', async () => {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    writeFileSync(join(dir, 'x.txt'), 'taken');
    for (let n = 1; n < 100; n += 1) writeFileSync(join(dir, `x-${n}.txt`), 'taken');
    const result = await staging().stage('x.txt', 'text/plain', bytes('new'));
    expect(result.kind).toBe('failed');
    expect(readdirSync(dir)).toHaveLength(100);
  });
});

describe.skipIf(!posix)(
  'stage — untrusted directory is refused and nothing is written (AC17)',
  () => {
    it('refuses a symlinked directory', async () => {
      const target = join(root, 'elsewhere');
      mkdirSync(target, { mode: 0o700 });
      chmodSync(target, 0o700);
      symlinkSync(target, dir);
      const result = await staging().stage('a.txt', 'text/plain', bytes('x'));
      expect(result).toEqual({ kind: 'failed', reason: expect.stringMatching(/symlink/i) });
      expect(readdirSync(target)).toEqual([]);
    });

    it('refuses a directory owned by another uid', async () => {
      const result = await staging({ uid: realUid! + 1 }).stage('a.txt', 'text/plain', bytes('x'));
      expect(result).toEqual({ kind: 'failed', reason: expect.stringMatching(/owned/i) });
      expect(readdirSync(dir)).toEqual([]);
    });

    it('refuses a directory with mode 0755', async () => {
      mkdirSync(dir);
      chmodSync(dir, 0o755);
      const result = await staging().stage('a.txt', 'text/plain', bytes('x'));
      expect(result).toEqual({ kind: 'failed', reason: expect.stringMatching(/mode/i) });
      expect(readdirSync(dir)).toEqual([]);
    });

    it('refuses a path that is a regular file', async () => {
      writeFileSync(dir, 'not a dir');
      const result = await staging().stage('a.txt', 'text/plain', bytes('x'));
      expect(result).toEqual({ kind: 'failed', reason: expect.stringMatching(/not a directory/i) });
    });

    it('re-checks the directory before every write', async () => {
      const s = staging();
      stagedPath(await s.stage('a.txt', 'text/plain', bytes('x')));
      chmodSync(dir, 0o755);
      const result = await s.stage('b.txt', 'text/plain', bytes('y'));
      expect(result.kind).toBe('failed');
      expect(readdirSync(dir)).toEqual(['a.txt']);
    });
  },
);

describe.skipIf(!posix)('stage — without a uid (the Windows path)', () => {
  it('skips the ownership and mode checks', async () => {
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const path = stagedPath(await staging({ uid: null }).stage('a.txt', 'text/plain', bytes('x')));
    expect(path).toBe(resolve(dir, 'a.txt'));
  });

  it('still refuses a symlinked directory', async () => {
    const target = join(root, 'elsewhere');
    mkdirSync(target);
    symlinkSync(target, dir);
    const result = await staging({ uid: null }).stage('a.txt', 'text/plain', bytes('x'));
    expect(result).toEqual({ kind: 'failed', reason: expect.stringMatching(/symlink/i) });
    expect(readdirSync(target)).toEqual([]);
  });
});

describe('stage — size cap and write failure (AC14, AC15)', () => {
  it('returns too-large for one byte over the cap and creates nothing', async () => {
    const result = await staging().stage(
      'big.bin',
      'application/octet-stream',
      new Uint8Array(MAX_STAGED_BYTES + 1),
    );
    expect(result).toEqual({ kind: 'too-large', limitBytes: MAX_STAGED_BYTES });
    expect(existsSync(dir)).toBe(false);
  });

  it('accepts exactly the cap', async () => {
    const path = stagedPath(
      await staging().stage(
        'cap.bin',
        'application/octet-stream',
        new Uint8Array(MAX_STAGED_BYTES),
      ),
    );
    expect(statSync(path).size).toBe(MAX_STAGED_BYTES);
  });

  it.skipIf(!posix)(
    'a read-only parent directory yields a failed value with the reason, not a throw',
    async () => {
      chmodSync(root, 0o500);
      const result = await staging().stage('a.txt', 'text/plain', bytes('x'));
      expect(result).toEqual({
        kind: 'failed',
        reason: expect.stringMatching(/EACCES|permission/i),
      });
    },
  );
});

describe('module hygiene', () => {
  it('uses only fs/promises — no synchronous fs API', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../../src/main/drops/staging.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/\w+Sync\s*\(/);
    expect(source).not.toMatch(/from 'node:fs'/);
  });
});
