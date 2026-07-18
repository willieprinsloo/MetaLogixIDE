import type { Database } from 'better-sqlite3';
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

function fmt(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export async function backupDb(db: Database, backupsDir: string, today: Date, keep = 7): Promise<{ created: string; pruned: string[] }> {
  mkdirSync(backupsDir, { recursive: true });
  const created = join(backupsDir, `metaide-${fmt(today)}.db`);
  await db.backup(created);
  const files = readdirSync(backupsDir).filter(f => /^metaide-\d{8}\.db$/.test(f)).sort();
  const pruned: string[] = [];
  while (files.length > keep) {
    const oldest = files.shift()!;
    unlinkSync(join(backupsDir, oldest));
    pruned.push(oldest);
  }
  return { created, pruned };
}
