import type { Database } from 'better-sqlite3';
import type { Project, ProjectConfig } from '@shared/types';

interface Row {
  id: number; root_id: number; path: string; name: string;
  metaproject_project_id: string | null; linked_chat_channel_id: string | null;
  last_opened_at: string | null; pinned: number; hidden: number;
  first_launched_at: string | null; config_json: string;
}

function toProject(r: Row): Project {
  return {
    id: r.id, rootId: r.root_id, path: r.path, name: r.name,
    metaprojectProjectId: r.metaproject_project_id,
    linkedChatChannelId: r.linked_chat_channel_id,
    lastOpenedAt: r.last_opened_at,
    pinned: !!r.pinned, hidden: !!r.hidden,
    firstLaunchedAt: r.first_launched_at,
    config: JSON.parse(r.config_json) as ProjectConfig,
  };
}

function iso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export class ProjectsRepo {
  constructor(private readonly db: Database) {}

  upsert(rootId: number, path: string, name: string): Project {
    const existing = this.db.prepare('SELECT id FROM projects WHERE path = ?').get(path) as { id: number } | undefined;
    if (existing) {
      this.db.prepare('UPDATE projects SET name = ?, root_id = ? WHERE id = ?').run(name, rootId, existing.id);
      return this.get(existing.id)!;
    }
    const info = this.db.prepare('INSERT INTO projects (root_id, path, name) VALUES (?, ?, ?)').run(rootId, path, name);
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return row ? toProject(row) : null;
  }

  list(): Project[] {
    return (this.db.prepare('SELECT * FROM projects WHERE hidden = 0 ORDER BY pinned DESC, last_opened_at DESC, name').all() as Row[]).map(toProject);
  }

  setPinned(id: number, pinned: boolean): void {
    this.db.prepare('UPDATE projects SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
  }

  setHidden(id: number, hidden: boolean): void {
    this.db.prepare('UPDATE projects SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id);
  }

  updateConfig(id: number, patch: Partial<ProjectConfig>): Project {
    const cur = this.get(id);
    if (!cur) throw new Error(`no project ${id}`);
    const merged = { ...cur.config, ...patch };
    this.db.prepare('UPDATE projects SET config_json = ? WHERE id = ?').run(JSON.stringify(merged), id);
    return this.get(id)!;
  }

  markLastOpened(id: number, when: Date): void {
    const ts = iso(when);
    this.db.prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?').run(ts, id);
    this.db.prepare('INSERT OR REPLACE INTO recent_projects (project_id, opened_at) VALUES (?, ?)').run(id, ts);
  }

  setFirstLaunched(id: number, when: Date): void {
    this.db.prepare('UPDATE projects SET first_launched_at = ? WHERE id = ?').run(iso(when), id);
  }

  listRecents(limit: number): Project[] {
    return (this.db.prepare(`
      SELECT p.* FROM recent_projects r
      JOIN projects p ON p.id = r.project_id
      WHERE p.hidden = 0
      ORDER BY r.opened_at DESC
      LIMIT ?`).all(limit) as Row[]).map(toProject);
  }
}
