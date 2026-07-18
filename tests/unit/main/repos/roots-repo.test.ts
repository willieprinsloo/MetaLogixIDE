import { describe, it, expect } from 'vitest';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { RootsRepo } from '@main/repos/roots-repo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const migrationsDir = resolve(__dirname, '../../../../migrations');

function freshRepo(): RootsRepo {
  const dir = mkdtempSync(join(tmpdir(), 'metaide-r-'));
  const db = openDb(join(dir, 'x.db'));
  runMigrations(db, migrationsDir);
  return new RootsRepo(db);
}

describe('RootsRepo', () => {
  it('adds and lists roots', () => {
    const repo = freshRepo();
    const r = repo.add('/tmp/a');
    expect(r.id).toBeGreaterThan(0);
    expect(repo.list()).toHaveLength(1);
  });

  it('rejects duplicate paths', () => {
    const repo = freshRepo();
    repo.add('/tmp/x');
    expect(() => repo.add('/tmp/x')).toThrow();
  });

  it('removes a root by id', () => {
    const repo = freshRepo();
    const r = repo.add('/tmp/y');
    repo.remove(r.id);
    expect(repo.list()).toHaveLength(0);
  });
});
