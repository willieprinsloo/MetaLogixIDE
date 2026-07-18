import { describe, it, expect } from 'vitest';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('runMigrations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metaide-mig-'));
  const migrationsDir = resolve(__dirname, '../../../../migrations');

  it('applies pending migrations and records version', () => {
    const db = openDb(join(dir, 'a.db'));
    const result = runMigrations(db, migrationsDir);
    expect(result.applied).toEqual([1]);
    const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all();
    expect(versions).toEqual([{ version: 1 }]);
    db.close();
  });

  it('is idempotent — running again applies nothing', () => {
    const dbPath = join(dir, 'b.db');
    const db1 = openDb(dbPath); runMigrations(db1, migrationsDir); db1.close();
    const db2 = openDb(dbPath);
    const result = runMigrations(db2, migrationsDir);
    expect(result.applied).toEqual([]);
    db2.close();
  });

  it('creates all expected tables', () => {
    const db = openDb(join(dir, 'c.db'));
    runMigrations(db, migrationsDir);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain('schema_version');
    expect(names).toContain('roots');
    expect(names).toContain('projects');
    expect(names).toContain('recent_projects');
    expect(names).toContain('shells');
    expect(names).toContain('settings');
    db.close();
  });
});
