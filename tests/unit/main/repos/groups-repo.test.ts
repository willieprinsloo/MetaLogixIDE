import { describe, it, expect } from 'vitest';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { RootsRepo } from '@main/repos/roots-repo';
import { ProjectsRepo } from '@main/repos/projects-repo';
import { GroupsRepo, type StoredGroup } from '@main/repos/groups-repo';
import { createGroups } from '@main/group-chat/groups';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const migrationsDir = resolve(__dirname, '../../../../migrations');

function fresh() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'g-')), 'db'));
  runMigrations(db, migrationsDir);
  const root = new RootsRepo(db).add('/tmp/root');
  const project = new ProjectsRepo(db).upsert(root.id, '/tmp/root/alpha', 'alpha');
  return { db, repo: new GroupsRepo(db), projectId: project.id };
}

function stored(projectId: number): StoredGroup {
  const G = createGroups();
  const group = G.create({ projectId, projectName: 'alpha', members: ['m1', 'm2'] });
  G.say(group.id, 'hello');
  return {
    group,
    members: {
      m1: { id: 'm1', kind: 'claude-tab', projectId, claudeSessionId: 'sess-1', title: 'Main' },
      m2: { id: 'm2', kind: 'headless', engine: 'ollama', name: 'Notes', model: 'llama3.2', engineSession: null, history: [{ role: 'user', content: 'hi' }] },
    },
  };
}

describe('GroupsRepo', () => {
  it('round-trips a group with its members', () => {
    const { repo, projectId } = fresh();
    const s = stored(projectId);
    repo.save(s);
    expect(repo.loadAll()).toEqual([s]);
  });

  it('save twice updates the row instead of adding one', () => {
    const { repo, projectId } = fresh();
    const s = stored(projectId);
    repo.save(s);
    s.group.name = 'Renamed';
    repo.save(s);
    const all = repo.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.group.name).toBe('Renamed');
  });

  it('removes a group', () => {
    const { repo, projectId } = fresh();
    const s = stored(projectId);
    repo.save(s);
    repo.remove(s.group.id);
    expect(repo.loadAll()).toEqual([]);
  });

  it('drops a row whose state_json is not valid JSON instead of throwing', () => {
    const { db, repo, projectId } = fresh();
    db.prepare('INSERT INTO group_chats (id, project_id, state_json) VALUES (?, ?, ?)').run('bad', projectId, '{not json');
    expect(repo.loadAll()).toEqual([]);
  });

  it('deleting the project deletes its groups', () => {
    const { db, repo, projectId } = fresh();
    repo.save(stored(projectId));
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    expect(repo.loadAll()).toEqual([]);
  });
});
