import type { Database } from 'better-sqlite3';
import type { SettingsMap } from '@shared/types';
import { withPermissionMode } from '@main/domain/claude-permission-mode';

export const DEFAULT_SETTINGS: SettingsMap = {
  // Flagless: the permission-mode choice (AC8) inserts the flag once the
  // user picks a mode. A fresh install that has never chosen a mode must
  // never spawn Claude in bypass by default.
  'default_launch_cmd.first':      { argv: ['claude'], env: {} },
  'default_launch_cmd.subsequent': { argv: ['claude', '--continue'], env: {} },
  'keep_alive_cap':                5,
  'scan_depth':                    1,
  'scrollback_lines':              10000,
  'max_watched_paths':             500,
  'theme':                         'dark',
  'metaproject_base_url':          'https://projects.metalogix.solutions',
  'metaproject_last_username':     '',
  'window_opacity':                100,
  'claude_permission_mode':        null,
  'notify_claude_needs_input':     true,
  'notify_claude_finished':        true,
  // Seeded named CLIs the "+ new shell" menu shows out of the box. The bare
  // "Terminal" (login $SHELL) is offered by the menu itself as a separate
  // row — don't duplicate it here. Each entry is spawned via the user's
  // PATH, so we ship the *invocation*, not the install path — if the CLI
  // isn't installed the shell will still open and print "command not
  // found", which is a clearer signal than us silently hiding the entry.
  'default_cli_profiles': [
    { name: 'Claude',       argv: ['claude'],                                   icon: '🤖' },
    { name: 'OpenAI Codex', argv: ['codex'],                                    icon: '🧠' },
    { name: 'ChatGPT',      argv: ['sgpt', '--repl', 'temp'],                   icon: '💬' },
    { name: 'Gemini',       argv: ['gemini'],                                   icon: '✨' },
    { name: 'Ollama',       argv: ['ollama', 'run', 'llama3'],                  icon: '🦙' },
    { name: 'Amp',          argv: ['amp'],                                      icon: '⚡' },
    { name: 'Cody',         argv: ['cody', 'chat'],                             icon: '🐦' },
    { name: 'Qwen',         argv: ['qwen-code'],                                icon: '🐉' },
    { name: 'Aider',        argv: ['aider'],                                    icon: '🛠' },
    { name: 'Cursor Agent', argv: ['cursor-agent'],                             icon: '➤' },
  ],
};

export class SettingsRepo {
  constructor(private readonly db: Database) {}

  seedDefaults(): void {
    const ins = this.db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    const override = process.env.METAIDE_DEFAULT_LAUNCH_FIRST;
    const overrideSub = process.env.METAIDE_DEFAULT_LAUNCH_SUBSEQUENT;
    const effective: SettingsMap = { ...DEFAULT_SETTINGS };
    if (override)    effective['default_launch_cmd.first']      = JSON.parse(override) as SettingsMap['default_launch_cmd.first'];
    if (overrideSub) effective['default_launch_cmd.subsequent'] = JSON.parse(overrideSub) as SettingsMap['default_launch_cmd.subsequent'];
    for (const [k, v] of Object.entries(effective)) {
      ins.run(k, JSON.stringify(v));
    }
    // One-shot: upgrade an empty metaproject_base_url (from a prior default)
    // to the new default. Users who have already set their own URL are left
    // untouched.
    this.db.prepare(
      `UPDATE settings SET value = ? WHERE key = 'metaproject_base_url' AND value = ?`,
    ).run(JSON.stringify(DEFAULT_SETTINGS['metaproject_base_url']), JSON.stringify(''));
    // Union new seed CLI profiles into existing installs. Users already past
    // first-run have their own row for `default_cli_profiles`, so the INSERT
    // OR IGNORE above skipped it — without this merge they'd never see newly
    // shipped defaults like ChatGPT/Ollama. User edits and additions are
    // preserved (match is by `name`); we only add missing seeds to the end.
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'default_cli_profiles'`).get() as { value: string } | undefined;
    if (row) {
      const current = JSON.parse(row.value) as SettingsMap['default_cli_profiles'];
      const have = new Set(current.map(p => p.name));
      const missing = DEFAULT_SETTINGS['default_cli_profiles'].filter(p => !have.has(p.name));
      if (missing.length > 0) {
        // A missing built-in `Claude` profile is re-added here on every
        // boot; when a mode is already chosen (AC12a) the re-added profile
        // must carry that mode's flag, never a different one or none.
        const mode = this.get('claude_permission_mode');
        const seeded = mode === null
          ? missing
          : missing.map(p => (p.name === 'Claude' ? { ...p, argv: withPermissionMode(p.argv, mode) } : p));
        this.db.prepare(`UPDATE settings SET value = ? WHERE key = 'default_cli_profiles'`)
          .run(JSON.stringify([...current, ...seeded]));
      }
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

  /**
   * Upserts every entry in one transaction: either all rows are written, or
   * (on any failure, e.g. a value that cannot be JSON-serialized) none are —
   * required by AC14 for the atomic permission-mode rewrite.
   */
  setMany(entries: Partial<SettingsMap>): void {
    const stmt = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const tx = this.db.transaction((items: Partial<SettingsMap>) => {
      for (const [key, value] of Object.entries(items)) {
        stmt.run(key, JSON.stringify(value));
      }
    });
    tx(entries);
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
