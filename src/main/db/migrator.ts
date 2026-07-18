import type { Database } from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MigrationResult { applied: number[] }

export function runMigrations(db: Database, migrationsDir: string): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT (datetime('now')))`);
  const files = readdirSync(migrationsDir).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  const appliedRows = db.prepare('SELECT version FROM schema_version').all() as { version: number }[];
  const alreadyApplied = new Set(appliedRows.map(r => r.version));
  const applied: number[] = [];

  for (const file of files) {
    const version = parseInt(file.split('_')[0]!, 10);
    if (alreadyApplied.has(version)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
    });
    tx();
    applied.push(version);
  }
  return { applied };
}
