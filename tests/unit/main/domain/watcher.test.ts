import { describe, it, expect } from 'vitest';
import { RootWatcher } from '@main/domain/watcher';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('RootWatcher', () => {
  it('respects cap and skips new roots beyond it', async () => {
    const w = new RootWatcher({ cap: 2 });
    const r1 = mkdtempSync(join(tmpdir(), 'w1-'));
    const r2 = mkdtempSync(join(tmpdir(), 'w2-'));
    const r3 = mkdtempSync(join(tmpdir(), 'w3-'));
    mkdirSync(join(r1, 'a')); mkdirSync(join(r2, 'a')); mkdirSync(join(r3, 'a'));
    expect(w.watch(r1)).toBe(true);
    expect(w.watch(r2)).toBe(true);
    expect(w.watch(r3)).toBe(false); // cap hit
    expect(w.getWatchedCount()).toBeGreaterThan(0);
    await w.closeAll();
  });
});
