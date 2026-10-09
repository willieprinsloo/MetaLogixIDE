import { describe, it, expect } from 'vitest';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { RootsRepo } from '@main/repos/roots-repo';
import { ProjectsRepo } from '@main/repos/projects-repo';
import { pruneMissingProjects } from '@main/domain/prune-missing';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const migrationsDir = resolve(__dirname, '../../../../migrations');

function fresh() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'prune-db-')), 'db'));
  runMigrations(db, migrationsDir);
  const rootPath = mkdtempSync(join(tmpdir(), 'prune-root-'));
  const roots = new RootsRepo(db);
  const projects = new ProjectsRepo(db);
  const root = roots.add(rootPath);
  const add = (name: string) => {
    mkdirSync(join(rootPath, name));
    return projects.upsert(root.id, join(rootPath, name), name);
  };
  return { roots, projects, root, rootPath, add };
}

const noLiveShells = () => false;

describe('pruneMissingProjects', () => {
  it('removes a project whose folder was deleted and keeps the rest', () => {
    const { projects, root, rootPath, add } = fresh();
    add('keep');
    add('gone');
    rmSync(join(rootPath, 'gone'), { recursive: true });

    const removed = pruneMissingProjects({ projects, hasLiveShell: noLiveShells }, root);

    expect(removed).toBe(1);
    expect(projects.list().map(p => p.name)).toEqual(['keep']);
  });

  it('removes a missing project even when it was hidden', () => {
    const { projects, root, rootPath, add } = fresh();
    const p = add('gone');
    projects.setHidden(p.id, true);
    rmSync(join(rootPath, 'gone'), { recursive: true });

    expect(pruneMissingProjects({ projects, hasLiveShell: noLiveShells }, root)).toBe(1);
    expect(projects.get(p.id)).toBeNull();
  });

  it('keeps everything when the root folder itself is missing (e.g. unmounted drive)', () => {
    const { projects, root, rootPath, add } = fresh();
    add('a');
    add('b');
    rmSync(rootPath, { recursive: true });

    expect(pruneMissingProjects({ projects, hasLiveShell: noLiveShells }, root)).toBe(0);
    expect(projects.list()).toHaveLength(2);
  });

  it('keeps a missing project that still has a live shell', () => {
    const { projects, root, rootPath, add } = fresh();
    const p = add('busy');
    rmSync(join(rootPath, 'busy'), { recursive: true });

    const removed = pruneMissingProjects({ projects, hasLiveShell: (id) => id === p.id }, root);

    expect(removed).toBe(0);
    expect(projects.get(p.id)).not.toBeNull();
  });

  it('only touches projects belonging to the given root', () => {
    const { roots, projects, root, add } = fresh();
    add('mine');
    const otherRoot = roots.add(mkdtempSync(join(tmpdir(), 'prune-other-')));
    const other = projects.upsert(otherRoot.id, join(otherRoot.path, 'missing'), 'missing');

    expect(pruneMissingProjects({ projects, hasLiveShell: noLiveShells }, root)).toBe(0);
    expect(projects.get(other.id)).not.toBeNull();
  });
});
