import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDropStaging } from '@main/drops/staging';

const faults = vi.hoisted(() => ({
  write: null as Error | null,
  close: null as Error | null,
  pruneUnlink: null as Error | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      if (faults.write) {
        const err = faults.write;
        handle.writeFile = async () => {
          throw err;
        };
      }
      if (faults.close) {
        const err = faults.close;
        const realClose = handle.close.bind(handle);
        handle.close = async () => {
          await realClose();
          throw err;
        };
      }
      return handle;
    },
    unlink: async (path: Parameters<typeof real.unlink>[0]) => {
      if (faults.pruneUnlink) throw faults.pruneUnlink;
      await real.unlink(path);
    },
  };
});

const posix = process.platform !== 'win32';
let root: string;
let dir: string;

function staging() {
  return createDropStaging({
    dir,
    now: () => new Date(Date.UTC(2026, 9, 17)),
    uid: posix ? process.getuid!() : null,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'drops-fault-'));
  dir = join(root, 'drops');
  faults.write = null;
  faults.close = null;
  faults.pruneUnlink = null;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('stage — write failure after the exclusive create (AC15)', () => {
  it('returns failed with the reason and leaves no partial file', async () => {
    faults.write = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    const result = await staging().stage('a.txt', 'text/plain', new Uint8Array([1, 2, 3]));
    expect(result).toEqual({ kind: 'failed', reason: 'ENOSPC: no space left on device' });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('stage — close failure during write-error cleanup (AC15)', () => {
  it('still removes the partial file and reports the original write error', async () => {
    faults.write = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    faults.close = Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO' });
    const result = await staging().stage('a.txt', 'text/plain', new Uint8Array([1, 2, 3]));
    expect(result).toEqual({ kind: 'failed', reason: 'ENOSPC: no space left on device' });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('pruneOlderThan — per-file failures are counted, not thrown', () => {
  it('reports a failed unlink in the summary', async () => {
    await staging().stage('a.txt', 'text/plain', new Uint8Array([1]));
    faults.pruneUnlink = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    const later = createDropStaging({
      dir,
      now: () => new Date(Date.now() + 48 * 3600_000),
      uid: posix ? process.getuid!() : null,
    });
    await expect(later.pruneOlderThan(24 * 3600_000)).resolves.toEqual({ removed: 0, failed: 1 });
    expect(existsSync(join(dir, 'a.txt'))).toBe(true);
  });
});
