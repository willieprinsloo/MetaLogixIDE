import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, writeFileSync } from 'node:fs';
import { buildServices } from '@main/services';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const migrationsDir = resolve(__dirname, '../../../migrations');

function tempOpts() {
  return { dbPath: join(mkdtempSync(join(tmpdir(), 'svc-')), 'db'), migrationsDir };
}

describe('buildServices — METAIDE_CLAUDE_PERMISSION_MODE env hook (AC21)', () => {
  afterEach(() => {
    delete process.env.METAIDE_CLAUDE_PERMISSION_MODE;
    delete process.env.METAIDE_DEFAULT_LAUNCH_FIRST;
  });

  it('auto on a fresh DB sets the mode and rewrites the managed argv', () => {
    process.env.METAIDE_CLAUDE_PERMISSION_MODE = 'auto';
    const services = buildServices(tempOpts());
    expect(services.settings.get('claude_permission_mode')).toBe('auto');
    expect(services.settings.get('default_launch_cmd.first').argv).toEqual(['claude', '--permission-mode', 'auto']);
    expect(services.settings.get('default_launch_cmd.subsequent').argv).toEqual(['claude', '--permission-mode', 'auto', '--continue']);
  });

  it('does not override a DB that already has a chosen mode', () => {
    const opts = tempOpts();
    // First boot with no env override chooses nothing; simulate a user
    // having already chosen bypass by building services once, then setting
    // the mode directly before the second boot that carries the env var.
    const first = buildServices(opts);
    first.settings.set('claude_permission_mode', 'bypass');
    process.env.METAIDE_CLAUDE_PERMISSION_MODE = 'auto';
    const second = buildServices(opts);
    expect(second.settings.get('claude_permission_mode')).toBe('bypass');
  });

  it('an invalid value throws at startup naming the var and the allowed values', () => {
    process.env.METAIDE_CLAUDE_PERMISSION_MODE = 'plan';
    expect(() => buildServices(tempOpts())).toThrow(/METAIDE_CLAUDE_PERMISSION_MODE/);
    process.env.METAIDE_CLAUDE_PERMISSION_MODE = 'plan';
    expect(() => buildServices(tempOpts())).toThrow(/auto/);
    process.env.METAIDE_CLAUDE_PERMISSION_MODE = 'plan';
    expect(() => buildServices(tempOpts())).toThrow(/bypass/);
  });

  it('METAIDE_DEFAULT_LAUNCH_FIRST still wins as the seeded first command, and a non-Claude override is left unchanged', () => {
    process.env.METAIDE_DEFAULT_LAUNCH_FIRST = JSON.stringify({ argv: ['my-tool', '--flag'], env: {} });
    process.env.METAIDE_CLAUDE_PERMISSION_MODE = 'auto';
    const services = buildServices(tempOpts());
    // Not a Claude argv, so the permission-flag rewrite leaves it untouched
    // even though a mode was chosen via the env hook.
    expect(services.settings.get('default_launch_cmd.first').argv).toEqual(['my-tool', '--flag']);
    expect(services.settings.get('claude_permission_mode')).toBe('auto');
  });
});

describe('buildServices — Claude hook and OMP receiver startup', () => {
  it('constructs the hook services without opening a socket or writing the settings file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'svc-home-'));
    const services = buildServices({ ...tempOpts(), homeDir: home });
    await new Promise((r) => setTimeout(r, 100));
    expect(services.hookReceiver.url()).toBeNull();
    expect(services.hookReceiver.boundAddress()).toBeNull();
    expect(services.hookRuntime.settingsPath()).toBeNull();
    expect(services.viewedShells).toBeDefined();
    expect(services.ompReceiver.boundPort()).toBeNull();
    expect(services.homeDir).toBe(home);
  });

  it.skipIf(process.platform === 'win32')('once the runtime is started, a Claude spawn gets --settings and a hook session (AC6)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'svc-home-'));
    const bin = mkdtempSync(join(tmpdir(), 'svc-bin-'));
    const shim = join(bin, 'claude');
    writeFileSync(shim, '#!/bin/sh\necho "ARGV=$* ID=$METAIDE_HOOK_SHELL"\nsleep 1\n');
    chmodSync(shim, 0o755);
    const services = buildServices({ ...tempOpts(), homeDir: home });
    await services.hookRuntime.start();
    try {
      let out = '';
      const seen = new Promise<void>((resolveP) => {
        services.ptyManager.on('data', ({ data }: { data: string }) => { out += data; if (out.includes('ID=')) resolveP(); });
      });
      const launch = { argv: [shim, '--continue'], env: {}, cwd: home, variant: 'subsequent' as const };
      await services.ptyManager.spawn(1, 0, launch);
      await seen;
      await new Promise((r) => setTimeout(r, 100));
      await services.ptyManager.kill(1, 0);
      expect(out).toContain(`ARGV=--settings ${services.hookRuntime.settingsPath()} --continue`);
      expect(services.hookRuntime.settingsPath()!.startsWith(join(home, '.metaide', 'claude-hooks', 'settings-'))).toBe(true);
      expect(out).toMatch(/ID=[0-9a-f-]{36}/);
      expect(launch.argv).toEqual([shim, '--continue']);
    } finally {
      await services.hookRuntime.stop();
    }
  });
});
describe('buildServices — shell runtime restart', () => {
  it('discards previous-runtime shells without losing projects or the configured cap', () => {
    const opts = tempOpts();
    const first = buildServices(opts);
    const root = first.roots.add('/restart-root');
    const project = first.projects.upsert(root.id, '/restart-root/project', 'project');
    first.settings.set('keep_alive_cap', 2);
    for (let shellIndex = 0; shellIndex < 2; shellIndex++) {
      first.shells.upsert({
        projectId: project.id, shellIndex, model: null, launchArgv: ['/bin/zsh', '-l'],
        startedAt: '2026-10-05 10:00:00', lastActiveAt: '2026-10-05 10:00:00',
        pinned: shellIndex === 1,
      });
    }
    first.db.close();

    const restarted = buildServices(opts);
    try {
      expect(restarted.shells.list()).toEqual([]);
      expect(restarted.projects.get(project.id)).toEqual(project);
      expect(restarted.settings.get('keep_alive_cap')).toBe(2);
    } finally {
      restarted.db.close();
    }
  });
});
