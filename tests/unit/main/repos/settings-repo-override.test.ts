import { describe, it, expect, afterEach } from 'vitest';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { SettingsRepo } from '@main/repos/settings-repo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('SettingsRepo env override', () => {
  afterEach(() => { delete process.env.METAIDE_DEFAULT_LAUNCH_FIRST; });
  it('reads default_launch_cmd.first from env', () => {
    process.env.METAIDE_DEFAULT_LAUNCH_FIRST = JSON.stringify({ argv: ['echo', 'x'], env: {} });
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'o-')), 'db'));
    runMigrations(db, resolve(__dirname, '../../../../migrations'));
    const s = new SettingsRepo(db); s.seedDefaults();
    expect(s.get('default_launch_cmd.first').argv).toEqual(['echo', 'x']);
  });
});
