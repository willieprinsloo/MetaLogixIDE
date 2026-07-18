import { describe, it, expect } from 'vitest';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { RootsRepo } from '@main/repos/roots-repo';
import { ProjectsRepo } from '@main/repos/projects-repo';
import { ShellsRepo } from '@main/repos/shells-repo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const migrationsDir = resolve(__dirname, '../../../../migrations');

function seed() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 's-')), 'db'));
  runMigrations(db, migrationsDir);
  const root = new RootsRepo(db).add('/r');
  const proj = new ProjectsRepo(db).upsert(root.id, '/r/one', 'one');
  return { db, projectId: proj.id, shells: new ShellsRepo(db) };
}

describe('ShellsRepo', () => {
  it('upserts and lists', () => {
    const { shells, projectId } = seed();
    shells.upsert({ projectId, shellIndex: 0, model: null, launchArgv: ['claude'], startedAt: '2026-07-18 10:00:00', lastActiveAt: '2026-07-18 10:00:00', pinned: false });
    expect(shells.list()).toHaveLength(1);
  });

  it('touches last_active_at', () => {
    const { shells, projectId } = seed();
    shells.upsert({ projectId, shellIndex: 0, model: null, launchArgv: ['claude'], startedAt: '2026-07-18 10:00:00', lastActiveAt: '2026-07-18 10:00:00', pinned: false });
    shells.touch(projectId, 0, new Date('2026-07-18T10:05:00Z'));
    expect(shells.list()[0]!.lastActiveAt).toBe('2026-07-18 10:05:00');
  });

  it('remove deletes by composite key', () => {
    const { shells, projectId } = seed();
    shells.upsert({ projectId, shellIndex: 0, model: null, launchArgv: ['claude'], startedAt: '2026-07-18 10:00:00', lastActiveAt: '2026-07-18 10:00:00', pinned: false });
    shells.remove(projectId, 0);
    expect(shells.list()).toHaveLength(0);
  });
});
