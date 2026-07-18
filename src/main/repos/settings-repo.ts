import type { Database } from 'better-sqlite3';
import type { SettingsMap } from '@shared/types';

export const DEFAULT_SETTINGS: SettingsMap = {
  'default_launch_cmd.first':      { argv: ['claude', '--dangerously-skip-permissions'], env: {} },
  'default_launch_cmd.subsequent': { argv: ['claude', '--dangerously-skip-permissions', '--continue'], env: {} },
  'keep_alive_cap':                5,
  'scan_depth':                    1,
  'scrollback_lines':              10000,
  'max_watched_paths':             500,
  'theme':                         'dark',
};

export class SettingsRepo {
  constructor(private readonly db: Database) {}

  seedDefaults(): void {
    const ins = this.db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      ins.run(k, JSON.stringify(v));
    }
  }

  get<K extends keyof SettingsMap>(key: K): SettingsMap[K] {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return DEFAULT_SETTINGS[key];
    return JSON.parse(row.value) as SettingsMap[K];
  }

  set<K extends keyof SettingsMap>(key: K, value: SettingsMap[K]): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  getAll(): SettingsMap {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const result = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      (result as Record<string, unknown>)[row.key] = JSON.parse(row.value);
    }
    return result;
  }
}
