import { describe, it, expect } from 'vitest';
import { openDb } from '@main/db/connection';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('openDb', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metaide-'));
  const dbPath = join(dir, 'test.db');

  it('enables WAL, foreign keys, and NORMAL synchronous', () => {
    const db = openDb(dbPath);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
    db.close();
  });
});
