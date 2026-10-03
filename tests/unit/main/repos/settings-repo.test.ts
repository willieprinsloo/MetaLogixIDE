import { describe, it, expect } from 'vitest';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { SettingsRepo, DEFAULT_SETTINGS } from '@main/repos/settings-repo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const migrationsDir = resolve(__dirname, '../../../../migrations');

function seed() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'st-')), 'db'));
  runMigrations(db, migrationsDir);
  const repo = new SettingsRepo(db);
  repo.seedDefaults();
  return repo;
}

describe('SettingsRepo', () => {
  it('seeds all defaults', () => {
    const repo = seed();
    expect(repo.get('keep_alive_cap')).toBe(DEFAULT_SETTINGS.keep_alive_cap);
    expect(repo.get('default_launch_cmd.first')).toEqual(DEFAULT_SETTINGS['default_launch_cmd.first']);
  });
  it('set updates and get reflects', () => {
    const repo = seed();
    repo.set('keep_alive_cap', 10);
    expect(repo.get('keep_alive_cap')).toBe(10);
  });
  it('seedDefaults is idempotent', () => {
    const repo = seed();
    repo.set('keep_alive_cap', 3);
    repo.seedDefaults();
    expect(repo.get('keep_alive_cap')).toBe(3);
  });

  it('AC1 — fresh seed leaves claude_permission_mode null', () => {
    const repo = seed();
    expect(repo.get('claude_permission_mode')).toBeNull();
  });

  it('AC15 — fresh seeded launch defaults carry no permission flag (pinned to literals, not DEFAULT_SETTINGS)', () => {
    // Asserted against literal argv, not the DEFAULT_SETTINGS constant these
    // values are read from — the whole point is to catch the constant
    // itself regressing back to a bypass-by-default seed (gate Medium 2).
    const repo = seed();
    expect(repo.get('default_launch_cmd.first').argv).toEqual(['claude']);
    expect(repo.get('default_launch_cmd.subsequent').argv).toEqual(['claude', '--continue']);
    expect(repo.get('default_cli_profiles').find(p => p.name === 'Claude')!.argv).toEqual(['claude']);
  });

  it('AC2 — an upgraded DB with pre-existing launch rows and no mode row seeds mode null and leaves stored launch argv untouched', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'st-')), 'db'));
    runMigrations(db, migrationsDir);
    // Simulate a pre-upgrade install: only the launch-command rows exist, no
    // claude_permission_mode row (as if seeded before this feature shipped).
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'default_launch_cmd.first',
      JSON.stringify({ argv: ['claude', '--dangerously-skip-permissions'], env: {} }),
    );
    const repo = new SettingsRepo(db);
    repo.seedDefaults();
    expect(repo.get('claude_permission_mode')).toBeNull();
    expect(repo.get('default_launch_cmd.first').argv).toEqual(['claude', '--dangerously-skip-permissions']);
  });

  it('AC3 — idempotent seedDefaults keeps a chosen mode', () => {
    const repo = seed();
    repo.set('claude_permission_mode', 'bypass');
    repo.seedDefaults();
    expect(repo.get('claude_permission_mode')).toBe('bypass');
  });

  describe('AC12a — seed merge re-adds a deleted Claude profile carrying the chosen mode', () => {
    function repoWithoutClaudeProfile(): SettingsRepo {
      const db = openDb(join(mkdtempSync(join(tmpdir(), 'st-')), 'db'));
      runMigrations(db, migrationsDir);
      const repo = new SettingsRepo(db);
      repo.seedDefaults();
      const withoutClaude = DEFAULT_SETTINGS['default_cli_profiles'].filter(p => p.name !== 'Claude');
      db.prepare(`UPDATE settings SET value = ? WHERE key = 'default_cli_profiles'`).run(JSON.stringify(withoutClaude));
      return repo;
    }

    it('chosen auto — re-added Claude profile carries --permission-mode auto', () => {
      const repo = repoWithoutClaudeProfile();
      repo.set('claude_permission_mode', 'auto');
      repo.seedDefaults();
      expect(repo.get('default_cli_profiles').find(p => p.name === 'Claude')!.argv).toEqual(['claude', '--permission-mode', 'auto']);
    });

    it('chosen bypass — re-added Claude profile carries --dangerously-skip-permissions', () => {
      const repo = repoWithoutClaudeProfile();
      repo.set('claude_permission_mode', 'bypass');
      repo.seedDefaults();
      expect(repo.get('default_cli_profiles').find(p => p.name === 'Claude')!.argv).toEqual(['claude', '--dangerously-skip-permissions']);
    });

    it('unchosen — re-added Claude profile stays flagless', () => {
      const repo = repoWithoutClaudeProfile();
      repo.seedDefaults();
      expect(repo.get('default_cli_profiles').find(p => p.name === 'Claude')!.argv).toEqual(['claude']);
    });

    it('an existing user-edited Claude profile is never rewritten by seeding', () => {
      const db = openDb(join(mkdtempSync(join(tmpdir(), 'st-')), 'db'));
      runMigrations(db, migrationsDir);
      const repo = new SettingsRepo(db);
      repo.seedDefaults();
      repo.set('claude_permission_mode', 'auto');
      const current = repo.get('default_cli_profiles');
      const edited = current.map(p => (p.name === 'Claude' ? { ...p, argv: ['claude', '--my-custom-flag'] } : p));
      db.prepare(`UPDATE settings SET value = ? WHERE key = 'default_cli_profiles'`).run(JSON.stringify(edited));
      repo.seedDefaults();
      expect(repo.get('default_cli_profiles').find(p => p.name === 'Claude')!.argv).toEqual(['claude', '--my-custom-flag']);
    });
  });

  describe('setMany', () => {
    it('writes every entry', () => {
      const repo = seed();
      repo.setMany({ keep_alive_cap: 7, scan_depth: 2 });
      expect(repo.get('keep_alive_cap')).toBe(7);
      expect(repo.get('scan_depth')).toBe(2);
    });

    it('AC14 — rolls back every entry when one fails mid-transaction', () => {
      const repo = seed();
      repo.set('keep_alive_cap', 3);
      const circular: Record<string, unknown> = {};
      circular.self = circular; // JSON.stringify throws on this
      expect(() => repo.setMany({ keep_alive_cap: 99, scan_depth: circular as never })).toThrow();
      // Neither entry landed — including the one that would have succeeded
      // on its own — proving the transaction is all-or-nothing.
      expect(repo.get('keep_alive_cap')).toBe(3);
      expect(repo.get('scan_depth')).toBe(DEFAULT_SETTINGS.scan_depth);
    });
  });

  it('AC20 — Claude notification toggles default to on for a fresh install (pinned to literals)', () => {
    const repo = seed();
    expect(repo.get('notify_claude_needs_input')).toBe(true);
    expect(repo.get('notify_claude_finished')).toBe(true);
  });

  it('AC20 — an upgraded DB without the toggle rows gets them seeded on', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'st-')), 'db'));
    runMigrations(db, migrationsDir);
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('keep_alive_cap', JSON.stringify(7));
    const repo = new SettingsRepo(db);
    repo.seedDefaults();
    expect(repo.get('notify_claude_needs_input')).toBe(true);
    expect(repo.get('notify_claude_finished')).toBe(true);
    expect(repo.get('keep_alive_cap')).toBe(7);
  });

  it('AC20 — a toggle the user turned off stays off across re-seeding (restart)', () => {
    const repo = seed();
    repo.set('notify_claude_finished', false);
    repo.seedDefaults();
    expect(repo.get('notify_claude_finished')).toBe(false);
    expect(repo.get('notify_claude_needs_input')).toBe(true);
  });
});
