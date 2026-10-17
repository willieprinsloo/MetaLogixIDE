import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDropStaging, type DropStaging } from '@main/drops/staging';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW_MS = Date.UTC(2026, 9, 17, 12, 0, 0);
const posix = process.platform !== 'win32';
const realUid = posix ? process.getuid!() : null;

let root: string;
let dir: string;

function staging(uid: number | null = realUid): DropStaging {
  return createDropStaging({ dir, now: () => new Date(NOW_MS), uid });
}

function fileAged(name: string, ageMs: number): string {
  const path = join(dir, name);
  writeFileSync(path, name);
  const t = (NOW_MS - ageMs) / 1000;
  utimesSync(path, t, t);
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'drops-prune-'));
  dir = join(root, 'metaide-drops-test');
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('pruneOlderThan (AC18)', () => {
  it('removes a 25-hour-old file and keeps a 23-hour-old file', async () => {
    const old = fileAged('old.png', 25 * HOUR);
    const fresh = fileAged('fresh.png', 23 * HOUR);
    const summary = await staging().pruneOlderThan(DAY);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(summary).toEqual({ removed: 1, failed: 0 });
  });

  it('measures age against the injected clock, not the wall clock', async () => {
    const path = fileAged('a.png', 25 * HOUR);
    const earlier = createDropStaging({
      dir,
      now: () => new Date(NOW_MS - 2 * HOUR),
      uid: realUid,
    });
    await earlier.pruneOlderThan(DAY);
    expect(existsSync(path)).toBe(true);
  });

  it.skipIf(!posix)('neither follows nor removes a subdirectory or a symlink inside', async () => {
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    const nested = join(sub, 'nested.png');
    writeFileSync(nested, 'n');
    const old = (NOW_MS - 30 * DAY) / 1000;
    utimesSync(nested, old, old);
    utimesSync(sub, old, old);
    const outside = join(root, 'outside.png');
    writeFileSync(outside, 'o');
    utimesSync(outside, old, old);
    const link = join(dir, 'link.png');
    symlinkSync(outside, link);
    lutimesSync(link, old, old);

    const summary = await staging().pruneOlderThan(DAY);

    expect(existsSync(nested)).toBe(true);
    expect(existsSync(sub)).toBe(true);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(link)).toBe(true);
    expect(summary).toEqual({ removed: 0, failed: 0 });
  });

  it('a missing directory is a no-op', async () => {
    rmSync(dir, { recursive: true });
    await expect(staging().pruneOlderThan(DAY)).resolves.toEqual({ removed: 0, failed: 0 });
    expect(existsSync(dir)).toBe(false);
  });

  it.skipIf(!posix)(
    'refuses to prune through a symlinked directory and deletes nothing',
    async () => {
      rmSync(dir, { recursive: true });
      const victimDir = join(root, 'victim');
      mkdirSync(victimDir, { mode: 0o700 });
      chmodSync(victimDir, 0o700);
      symlinkSync(victimDir, dir);
      const victim = join(victimDir, 'precious.txt');
      writeFileSync(victim, 'keep');
      const old = (NOW_MS - 30 * DAY) / 1000;
      utimesSync(victim, old, old);
      await expect(staging().pruneOlderThan(DAY)).rejects.toThrow(/symlink/);
      expect(existsSync(victim)).toBe(true);
    },
  );

  it.skipIf(!posix)('refuses to prune a directory owned by another uid', async () => {
    const path = fileAged('old.png', 30 * DAY);
    await expect(staging(realUid! + 1).pruneOlderThan(DAY)).rejects.toThrow(/owned/);
    expect(existsSync(path)).toBe(true);
  });
});
