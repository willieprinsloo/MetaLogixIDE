import { describe, it, expect, vi } from 'vitest';
import {
  isClaudeArgv,
  withPermissionMode,
  rewriteManagedCommands,
  applyClaudePermissionMode,
  type ManagedCommands,
} from '@main/domain/claude-permission-mode';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { SettingsRepo } from '@main/repos/settings-repo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const migrationsDir = resolve(__dirname, '../../../../migrations');

function tempRepo(): SettingsRepo {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'cpm-')), 'db'));
  runMigrations(db, migrationsDir);
  return new SettingsRepo(db);
}

describe('isClaudeArgv', () => {
  it.each([
    ['claude'], ['/usr/local/bin/claude'], ['C:\\bin\\claude.exe'], ['CLAUDE.CMD'], ['Claude.Exe'],
  ])('true for %s', (bin) => {
    expect(isClaudeArgv([bin])).toBe(true);
  });

  it.each([
    ['claude.sh'], ['claudex'], ['my-claude'],
  ])('false for %s', (bin) => {
    expect(isClaudeArgv([bin])).toBe(false);
  });

  it('false for an empty argv', () => {
    expect(isClaudeArgv([])).toBe(false);
  });
});

describe('withPermissionMode', () => {
  it('AC6/AC7 — no flag before, inserts exactly one flag, preserves other tokens and order (auto)', () => {
    expect(withPermissionMode(['claude', '--foo', 'bar'], 'auto')).toEqual(['claude', '--permission-mode', 'auto', '--foo', 'bar']);
  });

  it('AC6/AC7 — bypass', () => {
    expect(withPermissionMode(['claude', '--foo'], 'bypass')).toEqual(['claude', '--dangerously-skip-permissions', '--foo']);
  });

  it('AC8 — no flag, with --continue, inserted at index 1', () => {
    expect(withPermissionMode(['claude', '--continue'], 'auto')).toEqual(['claude', '--permission-mode', 'auto', '--continue']);
  });

  it('AC9 — several flags, interleaved, collapse to one at the first index', () => {
    const argv = ['claude', '--dangerously-skip-permissions', '--foo', '--permission-mode', 'auto', '--bar'];
    expect(withPermissionMode(argv, 'bypass')).toEqual(['claude', '--dangerously-skip-permissions', '--foo', '--bar']);
  });

  it('AC10 — recognises --permission-mode=<value> form', () => {
    expect(withPermissionMode(['claude', '--permission-mode=plan'], 'auto')).toEqual(['claude', '--permission-mode', 'auto']);
  });

  it('AC10 — recognises --permission-mode <value> space form', () => {
    expect(withPermissionMode(['claude', '--permission-mode', 'plan'], 'auto')).toEqual(['claude', '--permission-mode', 'auto']);
  });

  it('AC11 — non-Claude argv (node script) left byte-for-byte unchanged', () => {
    const argv = ['node', 'mock-claude.js', '--dangerously-skip-permissions'];
    expect(withPermissionMode(argv, 'auto')).toEqual(argv);
  });

  it('AC11 — wrapper script left unchanged', () => {
    const argv = ['my-claude-wrapper', '--dangerously-skip-permissions'];
    expect(withPermissionMode(argv, 'auto')).toBe(argv);
  });

  it('AC11 — claudex is not a Claude argv', () => {
    const argv = ['claudex', '--dangerously-skip-permissions'];
    expect(withPermissionMode(argv, 'auto')).toEqual(argv);
  });

  it('D3 — bare trailing --permission-mode is replaced', () => {
    expect(withPermissionMode(['claude', '--permission-mode'], 'bypass')).toEqual(['claude', '--dangerously-skip-permissions']);
  });

  it('D3 — --permission-mode followed by another flag keeps that flag, single chosen flag at index 1', () => {
    expect(withPermissionMode(['claude', '--permission-mode', '--continue'], 'auto')).toEqual(['claude', '--permission-mode', 'auto', '--continue']);
  });

  it('idempotent — bypass applied twice gives the same argv', () => {
    const once = withPermissionMode(['claude', '--dangerously-skip-permissions'], 'bypass');
    expect(withPermissionMode(once, 'bypass')).toEqual(once);
  });

  it('env is not a concern of the pure argv function (argv only)', () => {
    expect(withPermissionMode(['claude'], 'auto')).toEqual(['claude', '--permission-mode', 'auto']);
  });
});

describe('rewriteManagedCommands', () => {
  function cmds(overrides: Partial<ManagedCommands> = {}): ManagedCommands {
    return {
      first: { argv: ['claude'], env: { FOO: 'bar' } },
      subsequent: { argv: ['claude', '--continue'], env: {} },
      profiles: [
        { name: 'Claude', argv: ['claude'], icon: '🤖' },
        { name: 'OpenAI Codex', argv: ['codex'] },
      ],
      ...overrides,
    };
  }

  it('rewrites first, subsequent, and the Claude profile; leaves env and other profiles untouched', () => {
    const r = rewriteManagedCommands(cmds(), 'auto');
    expect(r.first.argv).toEqual(['claude', '--permission-mode', 'auto']);
    expect(r.first.env).toEqual({ FOO: 'bar' });
    expect(r.subsequent.argv).toEqual(['claude', '--permission-mode', 'auto', '--continue']);
    expect(r.profiles.find((p) => p.name === 'Claude')!.argv).toEqual(['claude', '--permission-mode', 'auto']);
    expect(r.profiles.find((p) => p.name === 'OpenAI Codex')).toEqual({ name: 'OpenAI Codex', argv: ['codex'] });
  });

  it('AC12 — missing Claude profile: not recreated, does not throw', () => {
    const r = rewriteManagedCommands(cmds({ profiles: [{ name: 'OpenAI Codex', argv: ['codex'] }] }), 'auto');
    expect(r.profiles.find((p) => p.name === 'Claude')).toBeUndefined();
    expect(r.profiles).toHaveLength(1);
  });

  it('AC12 — renamed Claude profile is left untouched', () => {
    const r = rewriteManagedCommands(cmds({ profiles: [{ name: 'My Claude', argv: ['claude'] }] }), 'auto');
    expect(r.profiles.find((p) => p.name === 'My Claude')!.argv).toEqual(['claude']);
  });
});

describe('applyClaudePermissionMode', () => {
  it('AC15 — fresh repo + auto produces the exact seeded argv', () => {
    const repo = tempRepo();
    repo.seedDefaults();
    applyClaudePermissionMode(repo, 'auto');
    expect(repo.get('default_launch_cmd.first').argv).toEqual(['claude', '--permission-mode', 'auto']);
    expect(repo.get('default_launch_cmd.subsequent').argv).toEqual(['claude', '--permission-mode', 'auto', '--continue']);
    expect(repo.get('default_cli_profiles').find((p) => p.name === 'Claude')!.argv).toEqual(['claude', '--permission-mode', 'auto']);
  });

  it('upgraded bypass install + auto rewrites, keeps extra args and env', () => {
    const repo = tempRepo();
    repo.seedDefaults();
    repo.set('default_launch_cmd.first', { argv: ['claude', '--dangerously-skip-permissions', '--extra'], env: { A: '1' } });
    applyClaudePermissionMode(repo, 'auto');
    expect(repo.get('default_launch_cmd.first')).toEqual({ argv: ['claude', '--permission-mode', 'auto', '--extra'], env: { A: '1' } });
  });

  it('returns exactly the keys that changed', () => {
    const repo = tempRepo();
    repo.seedDefaults();
    const changed = applyClaudePermissionMode(repo, 'auto');
    expect(new Set(changed)).toEqual(new Set(['claude_permission_mode', 'default_launch_cmd.first', 'default_launch_cmd.subsequent', 'default_cli_profiles']));
  });

  it('calling again with the same mode does not report claude_permission_mode as changed', () => {
    const repo = tempRepo();
    repo.seedDefaults();
    applyClaudePermissionMode(repo, 'auto');
    const changed = applyClaudePermissionMode(repo, 'auto');
    expect(changed).not.toContain('claude_permission_mode');
    expect(changed).toEqual([]);
  });

  it('AC13 — does not touch unrelated settings keys', () => {
    const repo = tempRepo();
    repo.seedDefaults();
    repo.set('keep_alive_cap', 9);
    applyClaudePermissionMode(repo, 'bypass');
    expect(repo.get('keep_alive_cap')).toBe(9);
  });

  it('AC14 — writes through exactly one setMany call, never through set (gate Low 3: pins the single-transaction requirement at the service boundary)', () => {
    const setManySpy = vi.fn();
    const setSpy = vi.fn();
    const fakeSettings = {
      get: (key: string) => {
        const store: Record<string, unknown> = {
          claude_permission_mode: null,
          'default_launch_cmd.first': { argv: ['claude'], env: {} },
          'default_launch_cmd.subsequent': { argv: ['claude', '--continue'], env: {} },
          default_cli_profiles: [{ name: 'Claude', argv: ['claude'] }],
        };
        return store[key];
      },
      setMany: setManySpy,
      set: setSpy,
    } as unknown as SettingsRepo;

    applyClaudePermissionMode(fakeSettings, 'auto');

    expect(setManySpy).toHaveBeenCalledTimes(1);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('AC14 — a setMany failure propagates and nothing else is written (a per-key set loop would swallow this differently)', () => {
    const setSpy = vi.fn();
    const fakeSettings = {
      get: (key: string) => {
        const store: Record<string, unknown> = {
          claude_permission_mode: null,
          'default_launch_cmd.first': { argv: ['claude'], env: {} },
          'default_launch_cmd.subsequent': { argv: ['claude', '--continue'], env: {} },
          default_cli_profiles: [{ name: 'Claude', argv: ['claude'] }],
        };
        return store[key];
      },
      setMany: vi.fn(() => { throw new Error('setMany failed'); }),
      set: setSpy,
    } as unknown as SettingsRepo;

    expect(() => applyClaudePermissionMode(fakeSettings, 'auto')).toThrow('setMany failed');
    expect(setSpy).not.toHaveBeenCalled();
  });
});
