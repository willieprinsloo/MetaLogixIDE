import type { Database } from 'better-sqlite3';
import type { SettingsMap } from '@shared/types';
import { DEFAULT_TERMINAL_ENGINE, TERMINAL_ENGINE_KEY, isTerminalEngine } from '@shared/terminal-engine';
import { isTerminalPaddingKey, isTerminalPaddingValue, TERMINAL_PADDING_KEYS } from '@shared/terminal-padding';
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
  [TERMINAL_ENGINE_KEY]:           DEFAULT_TERMINAL_ENGINE,
  [TERMINAL_PADDING_KEYS.horizontal]: null,
  [TERMINAL_PADDING_KEYS.vertical]:   null,
  'ui_font_family':                null,
  'terminal_font_family':          null,
  'terminal_font_size':            null,
  'terminal_font_weight':          null,
  'terminal_bold_weight':          null,
  'metaproject_base_url':          'https://projects.metalogix.solutions',
  'metaproject_last_username':     '',
  'window_opacity':                100,
  'claude_permission_mode':        null,
  'notify_claude_needs_input':     true,
  'notify_claude_finished':        true,
  'show_status_bar':               true,
  'show_status_bar_ports':         true,
  'activity_log_enabled':          true,
  'frost_chrome':                  true,
  'chrome_frost_level':            'subtle',
  'terminal_frost_level':          'off',
  'terminal_frost_opacity':        70,
  'vibrancy_material':             'sidebar',
  'app_env':                       {},
  // Seeded named CLIs the "+ new shell" menu shows out of the box. The bare
  // "Terminal" (login $SHELL) is offered by the menu itself as a separate
  // row — don't duplicate it here. Each entry is spawned via the user's
  // PATH, so we ship the *invocation*, not the install path — if the CLI
  // isn't installed the shell will still open and print "command not
  // found", which is a clearer signal than us silently hiding the entry.
  'default_cli_profiles': [
    { name: 'Claude',       argv: ['claude'],   icon: '🤖' },
    { name: 'OpenAI Codex', argv: ['codex'],    icon: '🧠' },
    { name: 'opencode',     argv: ['opencode'], icon: '⌬' },
  ],
  'shell_nicknames':               {},
  'chat_auto_onboard':             true,
};

type MetaprojectPrivateKey = 'metaproject_restore_grant_v1' | 'metaproject_legacy_assignments_v1';
type MetaprojectPrivateChanges = Partial<Record<MetaprojectPrivateKey, unknown>> & {
  readonly metaproject_base_url?: string;
};

/** These keys are managed by the main-process Metaproject lifecycle, not generic settings IPC. */
export function isManagedMetaprojectSetting(key: unknown): boolean {
  return typeof key === 'string' && key.startsWith('metaproject_');
}

/**
 * Built-in profiles of harnesses the IDE no longer supports, exactly as earlier builds seeded
 * them. Startup removes an entry only while it still matches, so a user-edited one survives.
 */
const RETIRED_CLI_PROFILES: readonly { name: string; argv: readonly string[] }[] = [
  { name: 'Pi', argv: ['pi'] },
  { name: 'oh-my-pi', argv: ['omp'] },
  { name: 'ChatGPT', argv: ['sgpt', '--repl', 'temp'] },
  { name: 'Gemini', argv: ['gemini'] },
  { name: 'Ollama', argv: ['ollama', 'run', 'llama3'] },
  { name: 'Amp', argv: ['amp'] },
  { name: 'Cody', argv: ['cody', 'chat'] },
  { name: 'Qwen', argv: ['qwen-code'] },
  { name: 'Aider', argv: ['aider'] },
  { name: 'Cursor Agent', argv: ['cursor-agent'] },
];

function isRetiredProfile(p: { name: string; argv: readonly string[] }): boolean {
  return RETIRED_CLI_PROFILES.some((r) => r.name === p.name && r.argv.length === p.argv.length && r.argv.every((a, i) => a === p.argv[i]));
}

function parseStoredSetting(key: string, raw: string): unknown {
  if (key !== TERMINAL_ENGINE_KEY && !isTerminalPaddingKey(key)) return JSON.parse(raw);
  try {
    const value: unknown = JSON.parse(raw);
    if (isTerminalPaddingKey(key)) return isTerminalPaddingValue(value) ? value : null;
    return isTerminalEngine(value) ? value : DEFAULT_TERMINAL_ENGINE;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return DEFAULT_SETTINGS[key];
  }
}

export class SettingsRepo {
  constructor(private readonly db: Database) {}

  /**
   * One-time migration (spec D4, AC2): on a build that has not yet seen `terminal_frost_level`,
   * derives it from the legacy `frost_terminal` boolean (`true` → `'subtle'`, anything else —
   * `false`, a missing row, or a non-boolean stored value — → `'off'`). The row's own presence
   * is the run-once marker, so it must run before the defaults INSERT OR IGNORE below, and a
   * value the user later sets is never overwritten. `frost_terminal` itself is only read here,
   * never written (AC34, D19).
   */
  private migrateTerminalFrostLevel(): void {
    const existing = this.db.prepare(`SELECT 1 FROM settings WHERE key = 'terminal_frost_level'`).get();
    if (existing) return;
    const legacyRow = this.db.prepare(`SELECT value FROM settings WHERE key = 'frost_terminal'`).get() as { value: string } | undefined;
    let legacyEnabled = false;
    if (legacyRow) {
      try { legacyEnabled = JSON.parse(legacyRow.value) === true; } catch { legacyEnabled = false; }
    }
    const migrated: SettingsMap['terminal_frost_level'] = legacyEnabled ? 'subtle' : 'off';
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('terminal_frost_level', JSON.stringify(migrated));
  }

  seedDefaults(): void {
    this.migrateTerminalFrostLevel();
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
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'default_cli_profiles'`).get() as { value: string } | undefined;
    if (row) {
      const current = JSON.parse(row.value) as SettingsMap['default_cli_profiles'];
      const profiles = current.filter(p => !isRetiredProfile(p));
      const retired = profiles.length !== current.length;
      const have = new Set(current.map(p => p.name));
      const missing = DEFAULT_SETTINGS['default_cli_profiles'].filter(p => !have.has(p.name));
      if (retired || missing.length > 0) {
        const mode = this.get('claude_permission_mode');
        const seeded = mode === null
          ? missing
          : missing.map(p => (p.name === 'Claude' ? { ...p, argv: withPermissionMode(p.argv, mode) } : p));
        this.db.prepare(`UPDATE settings SET value = ? WHERE key = 'default_cli_profiles'`)
          .run(JSON.stringify([...profiles, ...seeded]));
      }
    }
  }

  get<K extends keyof SettingsMap>(key: K): SettingsMap[K] {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return DEFAULT_SETTINGS[key];
    return parseStoredSetting(key, row.value) as SettingsMap[K];
  }

  set<K extends keyof SettingsMap>(key: K, value: SettingsMap[K]): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  readMetaprojectPrivate(key: MetaprojectPrivateKey): unknown {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (typeof row !== 'object' || row === null || !('value' in row) || typeof row.value !== 'string') return undefined;
    // Preserve distinction between an absent migration marker and malformed metadata.
    try { return JSON.parse(row.value) as unknown; } catch { return null; }
  }

  /** Synchronously commit origin and restore authorization together, with a WAL sync at commit. */
  writeMetaprojectPrivate(changes: MetaprojectPrivateChanges): void {
    const update = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const commit = this.db.transaction(() => {
      for (const [key, value] of Object.entries(changes)) update.run(key, JSON.stringify(value ?? null));
    });
    const previous = this.db.pragma('synchronous', { simple: true });
    if (typeof previous !== 'number' || !Number.isInteger(previous) || previous < 0 || previous > 3) {
      throw new Error('Could not read SQLite durability setting');
    }
    if (previous < 2) this.db.pragma('synchronous = FULL');
    try { commit(); } finally { if (previous < 2) this.db.pragma(`synchronous = ${previous}`); }
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
      if (isManagedMetaprojectSetting(row.key) && !(row.key in DEFAULT_SETTINGS)) continue;
      (result as Record<string, unknown>)[row.key] = parseStoredSetting(row.key, row.value);
    }
    return result;
  }
}
