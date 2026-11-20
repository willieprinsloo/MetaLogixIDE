import type { Database } from 'better-sqlite3';
import log from 'electron-log/main';
import type { Group } from '@main/group-chat/groups';

/** One group-chat member as stored: a Claude conversation in a tab, or a headless agent the group owns. */
export type MemberRecord =
  | { id: string; kind: 'claude-tab'; projectId: number; claudeSessionId: string; title: string }
  | {
      id: string;
      kind: 'headless';
      engine: 'codex' | 'gemini' | 'ollama';
      name: string;
      model: string | null;
      /** Codex thread id / Gemini session id, so later turns resume the same conversation. */
      engineSession: string | null;
      /** Ollama only: the member's own conversation, sent with every turn. */
      history: Array<{ role: 'user' | 'assistant'; content: string }>;
    };

export interface StoredGroup { group: Group; members: Record<string, MemberRecord> }

interface RawRow { id: string; state_json: string }

/**
 * Group chats, one row per group. The state is JSON because the round state machine owns its
 * shape; rows that fail to parse are skipped (and logged) so one bad row never blocks startup.
 */
export class GroupsRepo {
  constructor(private readonly db: Database) {}

  /** Every saved group, newest first. */
  loadAll(): StoredGroup[] {
    const rows = this.db.prepare('SELECT id, state_json FROM group_chats ORDER BY updated_at DESC, rowid DESC').all() as RawRow[];
    const out: StoredGroup[] = [];
    for (const r of rows) {
      try {
        const s = JSON.parse(r.state_json) as StoredGroup;
        if (s?.group?.id === r.id && s.members && typeof s.members === 'object') out.push(s);
        else log.warn('[group-chat] skipped a malformed saved group', { id: r.id });
      } catch {
        log.warn('[group-chat] skipped an unreadable saved group', { id: r.id });
      }
    }
    return out;
  }

  save(s: StoredGroup): void {
    this.db.prepare(
      'INSERT INTO group_chats (id, project_id, state_json, updated_at) VALUES (?, ?, ?, datetime(\'now\'))'
      + ' ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, state_json=excluded.state_json, updated_at=excluded.updated_at',
    ).run(s.group.id, s.group.projectId, JSON.stringify(s));
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM group_chats WHERE id = ?').run(id);
  }
}
