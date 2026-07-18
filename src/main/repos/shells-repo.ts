import type { Database } from 'better-sqlite3';
import type { ShellRow } from '@shared/types';

interface Row {
  project_id: number; shell_index: number; model: string | null;
  launch_argv_json: string; started_at: string; last_active_at: string; pinned: number;
}
const to = (r: Row): ShellRow => ({
  projectId: r.project_id, shellIndex: r.shell_index, model: r.model,
  launchArgv: JSON.parse(r.launch_argv_json), startedAt: r.started_at,
  lastActiveAt: r.last_active_at, pinned: !!r.pinned,
});
function iso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export class ShellsRepo {
  constructor(private readonly db: Database) {}
  upsert(row: ShellRow): void {
    this.db.prepare(`
      INSERT INTO shells (project_id, shell_index, model, launch_argv_json, started_at, last_active_at, pinned)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, shell_index) DO UPDATE SET
        model = excluded.model, launch_argv_json = excluded.launch_argv_json,
        last_active_at = excluded.last_active_at, pinned = excluded.pinned
    `).run(row.projectId, row.shellIndex, row.model, JSON.stringify(row.launchArgv), row.startedAt, row.lastActiveAt, row.pinned ? 1 : 0);
  }
  remove(projectId: number, shellIndex: number): void {
    this.db.prepare('DELETE FROM shells WHERE project_id = ? AND shell_index = ?').run(projectId, shellIndex);
  }
  list(): ShellRow[] {
    return (this.db.prepare('SELECT * FROM shells ORDER BY last_active_at DESC').all() as Row[]).map(to);
  }
  touch(projectId: number, shellIndex: number, when: Date): void {
    this.db.prepare('UPDATE shells SET last_active_at = ? WHERE project_id = ? AND shell_index = ?').run(iso(when), projectId, shellIndex);
  }
  setPinned(projectId: number, shellIndex: number, pinned: boolean): void {
    this.db.prepare('UPDATE shells SET pinned = ? WHERE project_id = ? AND shell_index = ?').run(pinned ? 1 : 0, projectId, shellIndex);
  }
  getLastModel(projectId: number): string | null {
    const r = this.db.prepare('SELECT model FROM shells WHERE project_id = ? ORDER BY last_active_at DESC LIMIT 1').get(projectId) as { model: string | null } | undefined;
    return r?.model ?? null;
  }
}
