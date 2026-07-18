import { describe, it, expect } from 'vitest';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { RootsRepo } from '@main/repos/roots-repo';
import { ProjectsRepo } from '@main/repos/projects-repo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const migrationsDir = resolve(__dirname, '../../../../migrations');

function fresh() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'p-')), 'db'));
  runMigrations(db, migrationsDir);
  const roots = new RootsRepo(db);
  const projects = new ProjectsRepo(db);
  const root = roots.add('/tmp/root');
  return { db, projects, root };
}

describe('ProjectsRepo', () => {
  it('upserts and lists projects', () => {
    const { projects, root } = fresh();
    const p = projects.upsert(root.id, '/tmp/root/alpha', 'alpha');
    expect(p.name).toBe('alpha');
    expect(projects.list()).toHaveLength(1);
  });

  it('upsert is idempotent by path', () => {
    const { projects, root } = fresh();
    const p1 = projects.upsert(root.id, '/tmp/root/alpha', 'alpha');
    const p2 = projects.upsert(root.id, '/tmp/root/alpha', 'alpha-renamed');
    expect(p2.id).toBe(p1.id);
    expect(p2.name).toBe('alpha-renamed');
  });

  it('setFirstLaunched persists a timestamp', () => {
    const { projects, root } = fresh();
    const p = projects.upsert(root.id, '/tmp/root/x', 'x');
    projects.setFirstLaunched(p.id, new Date('2026-07-18T10:00:00Z'));
    expect(projects.get(p.id)!.firstLaunchedAt).toBe('2026-07-18 10:00:00');
  });

  it('updateConfig merges JSON', () => {
    const { projects, root } = fresh();
    const p = projects.upsert(root.id, '/tmp/root/y', 'y');
    const updated = projects.updateConfig(p.id, { model: 'opus' });
    expect(updated.config.model).toBe('opus');
  });

  it('listRecents returns latest N by last_opened_at', () => {
    const { projects, root } = fresh();
    const a = projects.upsert(root.id, '/tmp/root/a', 'a');
    const b = projects.upsert(root.id, '/tmp/root/b', 'b');
    projects.markLastOpened(a.id, new Date('2026-07-17'));
    projects.markLastOpened(b.id, new Date('2026-07-18'));
    const recents = projects.listRecents(10);
    expect(recents[0]!.id).toBe(b.id);
    expect(recents[1]!.id).toBe(a.id);
  });
});
