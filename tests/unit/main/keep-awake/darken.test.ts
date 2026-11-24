import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDarken, createDarkenRecorder, type ExecFileFn } from '@main/keep-awake/darken';

const SAVER = '/System/Library/CoreServices/ScreenSaverEngine.app';

function fake(failures: Set<string>) {
  const calls: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }> = [];
  const fn: ExecFileFn = (file, args, options, cb) => {
    calls.push({ file, args, options });
    cb(failures.has(file) ? new Error(`${file} failed`) : null);
  };
  return { fn, calls };
}

describe('createDarken', () => {
  it('runs pmset only when it succeeds, with exact argv, timeout and no shell', async () => {
    const { fn, calls } = fake(new Set());
    await expect(createDarken(fn)()).resolves.toEqual({ ok: true });
    expect(calls).toEqual([{ file: '/usr/bin/pmset', args: ['displaysleepnow'], options: { timeout: 5000 } }]);
  });
  it('falls back to ScreenSaverEngine when pmset fails', async () => {
    const { fn, calls } = fake(new Set(['/usr/bin/pmset']));
    await expect(createDarken(fn)()).resolves.toEqual({ ok: true });
    expect(calls[1]).toEqual({ file: '/usr/bin/open', args: [SAVER], options: { timeout: 5000 } });
  });
  it('returns a failure value with the cause when both fail', async () => {
    const { fn } = fake(new Set(['/usr/bin/pmset', '/usr/bin/open']));
    const r = await createDarken(fn)();
    expect(r.ok).toBe(false);
    expect(r.ok === false && (r.cause as Error).message).toBe('/usr/bin/open failed');
  });
  it('never throws when execFile throws synchronously', async () => {
    const fn = vi.fn(() => {
      throw new Error('spawn boom');
    });
    const r = await createDarken(fn as unknown as ExecFileFn)();
    expect(r.ok).toBe(false);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('createDarkenRecorder', () => {
  it('appends one line per call and succeeds', async () => {
    const logPath = join(mkdtempSync(join(tmpdir(), 'ka-')), 'log');
    const d = createDarkenRecorder({ logPath, fail: false });
    await d();
    await d();
    expect(readFileSync(logPath, 'utf8').trim().split('\n')).toHaveLength(2);
  });
  it('reports failure when fail is set, still logging', async () => {
    const logPath = join(mkdtempSync(join(tmpdir(), 'ka-')), 'log');
    const r = await createDarkenRecorder({ logPath, fail: true })();
    expect(r.ok).toBe(false);
    expect(readFileSync(logPath, 'utf8')).not.toBe('');
  });
  it('returns failure rather than throwing when the log path is unwritable', async () => {
    const r = await createDarkenRecorder({ logPath: '/nonexistent-dir/x/log', fail: false })();
    expect(r.ok).toBe(false);
  });
  it('works without a log path', async () => {
    await expect(createDarkenRecorder({ logPath: undefined, fail: false })()).resolves.toEqual({ ok: true });
  });
});
