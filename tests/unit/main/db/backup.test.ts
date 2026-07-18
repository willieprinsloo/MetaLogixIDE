import { describe, it, expect } from 'vitest';
import { openDb } from '@main/db/connection';
import { backupDb } from '@main/db/backup';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('backupDb', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metaide-bk-'));

  it('creates a dated backup file', async () => {
    const db = openDb(join(dir, 'main.db'));
    const backupsDir = join(dir, 'backups');
    const result = await backupDb(db, backupsDir, new Date('2026-07-18'));
    expect(result.created).toMatch(/metaide-20260718\.db$/);
    expect(readdirSync(backupsDir)).toContain('metaide-20260718.db');
    db.close();
  });

  it('prunes backups older than 7 days', async () => {
    const db = openDb(join(dir, 'main2.db'));
    const backupsDir = join(dir, 'backups2');
    // Prime 10 daily backups spanning 10 days.
    for (let i = 0; i < 10; i++) {
      const d = new Date('2026-07-01'); d.setDate(d.getDate() + i);
      await backupDb(db, backupsDir, d);
    }
    const files = readdirSync(backupsDir).sort();
    expect(files.length).toBe(7);
    expect(files[0]).toBe('metaide-20260704.db');
    expect(files[6]).toBe('metaide-20260710.db');
    db.close();
  });
});
