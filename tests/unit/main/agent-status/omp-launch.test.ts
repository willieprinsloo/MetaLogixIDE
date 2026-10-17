import { describe, expect, it, vi } from 'vitest';
import { createOmpLaunchDecorator, isOmpArgv } from '@main/agent-status/omp-launch';
import type { ResolvedLaunch } from '@main/domain/launch';

const launch = (argv: string[]): ResolvedLaunch => ({ argv, cwd: '/project', env: { USER_FLAG: 'yes' }, variant: 'first' });

describe('OMP explicit extension injection', () => {
  it('recognizes direct OMP but not arbitrary node/shell wrappers', () => {
    expect(isOmpArgv(['/usr/local/bin/omp', '--profile', 'work'])).toBe(true);
    expect(isOmpArgv(['C:\\bin\\omp.cmd'])).toBe(true);
    expect(isOmpArgv(['node', 'omp.js'])).toBe(false);
  });

  it('preserves user argv and skips conflicting trust flags or absent extension without changing CLI', () => {
    const issue = vi.fn(() => ({ spawn: 'spawn', token: 'secret' }));
    const decorate = createOmpLaunchDecorator({ receiver: { issue, release: vi.fn() }, extensionPath: '/app/omp-status-extension.js', fileExists: () => true, port: () => 2000 });
    const original = launch(['omp', '-e', '/user/herdr.js', '--profile', 'work']);
    expect(decorate(1, 0, original)).toEqual({ ...original, argv: ['omp', '-e', '/app/omp-status-extension.js', '-e', '/user/herdr.js', '--profile', 'work'], env: { ...original.env, OMPCODE: '', METAIDE_OMP_STATUS_PORT: '2000', METAIDE_OMP_STATUS_SPAWN: 'spawn', METAIDE_OMP_STATUS_TOKEN: 'secret' } });
    expect(decorate(1, 0, launch(['omp', '--trusted-extension', '/only.js']))).toEqual(launch(['omp', '--trusted-extension', '/only.js']));
    expect(issue).toHaveBeenCalledTimes(1);
    const missing = createOmpLaunchDecorator({ receiver: { issue, release: vi.fn() }, extensionPath: '/missing/file.js', fileExists: () => false, port: () => 2000 });
    expect(missing(1, 0, original)).toBe(original);
  });
  it('treats an app-launched OMP as root even when the app inherited OMPCODE=1', () => {
    const previous = process.env.OMPCODE;
    process.env.OMPCODE = '1';
    try {
      const decorate = createOmpLaunchDecorator({
        receiver: { issue: () => ({ spawn: 'root-spawn', token: 'secret' }), release: () => {} },
        extensionPath: '/app/omp-status-extension.js',
        fileExists: () => true,
        port: () => 2000,
      });
      const child = decorate(1, 0, launch(['omp']));
      expect(child.env.OMPCODE).toBe('');
      expect(child.argv).toContain('/app/omp-status-extension.js');
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'OMPCODE');
      else process.env.OMPCODE = previous;
    }
  });
  it('encodes Windows cmd-shim extension paths without whitespace to preserve runnable argv', () => {
    const decorate = createOmpLaunchDecorator({
      receiver: { issue: () => ({ spawn: 'spawn', token: 'token' }), release: () => {} },
      extensionPath: '/Program Files/Meta IDE/omp-status-extension.js',
      fileExists: () => true, port: () => 2000, platform: 'win32', goesThroughCmd: () => true,
    });
    const argv = decorate(1, 0, launch(['omp.cmd'])).argv;
    expect(argv[2]).toContain('%20');
    expect(argv[2]).not.toMatch(/\s/);
  });
});
