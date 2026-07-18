import { describe, it, expect } from 'vitest';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { SettingsRepo, DEFAULT_SETTINGS } from '@main/repos/settings-repo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const migrationsDir = resolve(__dirname, '../../../../migrations');

function seed() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'st-')), 'db'));
  runMigrations(db, migrationsDir);
  const repo = new SettingsRepo(db);
  repo.seedDefaults();
  return repo;
}

describe('SettingsRepo', () => {
  it('seeds all defaults', () => {
    const repo = seed();
    expect(repo.get('keep_alive_cap')).toBe(DEFAULT_SETTINGS.keep_alive_cap);
    expect(repo.get('default_launch_cmd.first')).toEqual(DEFAULT_SETTINGS['default_launch_cmd.first']);
  });
  it('set updates and get reflects', () => {
    const repo = seed();
    repo.set('keep_alive_cap', 10);
    expect(repo.get('keep_alive_cap')).toBe(10);
  });
  it('seedDefaults is idempotent', () => {
    const repo = seed();
    repo.set('keep_alive_cap', 3);
    repo.seedDefaults();
    expect(repo.get('keep_alive_cap')).toBe(3);
  });
});
