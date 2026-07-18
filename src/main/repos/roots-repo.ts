import type { Database } from 'better-sqlite3';
import type { Root } from '@shared/types';

interface Row { id: number; path: string; added_at: string; sort_order: number }

const toRoot = (r: Row): Root => ({ id: r.id, path: r.path, addedAt: r.added_at, sortOrder: r.sort_order });

export class RootsRepo {
  constructor(private readonly db: Database) {}

  add(path: string): Root {
    const info = this.db.prepare('INSERT INTO roots (path) VALUES (?)').run(path);
    const row = this.db.prepare('SELECT * FROM roots WHERE id = ?').get(info.lastInsertRowid) as Row;
    return toRoot(row);
  }

  list(): Root[] {
    return (this.db.prepare('SELECT * FROM roots ORDER BY sort_order, added_at').all() as Row[]).map(toRoot);
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM roots WHERE id = ?').run(id);
  }
}
