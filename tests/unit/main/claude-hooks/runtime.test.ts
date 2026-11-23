import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateHookEndpoint, ClaudeHookRuntime as Runtime, type HookRuntimeDeps } from '@main/claude-hooks/runtime';

function fakeReceiver(opts: { startFails?: boolean } = {}) {
  return {
    start: vi.fn(async () => {
      if (opts.startFails) throw new Error('EADDRINUSE');
    }),
    stop: vi.fn(async () => {}),
  };
}

function runtime(options: Omit<HookRuntimeDeps, 'forwarderPath'>, id = 'current') {
  return new Runtime({
    ...options,
    platform: 'linux',
    forwarderPath: '/app/forward.cjs',
    instanceId: () => id,
    allocateEndpoint: () => ({ path: `/test/${id}/hook.sock`, remove() {} }),
  });
}

const hooksDir = (home: string) => join(home, '.metaide', 'claude-hooks');

describe('ClaudeHookRuntime', () => {
  it('has no settings path before start', () => {
    const rt = runtime({ receiver: fakeReceiver(), homeDir: '/h', writeSettings: vi.fn() });
    expect(rt.settingsPath()).toBeNull();
  });

  it('starts the private receiver and publishes shell settings and endpoint together', async () => {
    const writeSettings = vi.fn();
    const receiver = fakeReceiver();
    const rt = runtime({ receiver, homeDir: '/h', writeSettings });
    await rt.start();
    const expected = join('/h', '.metaide', 'claude-hooks', 'settings-current.json');
    expect(receiver.start).toHaveBeenCalledWith('/test/current/hook.sock');
    expect(writeSettings).toHaveBeenCalledWith(expected, 'linux');
    expect(rt.forwarderEnv()).toMatchObject({ METAIDE_HOOK_ENDPOINT: '/test/current/hook.sock', METAIDE_HOOK_FORWARDER: '/app/forward.cjs' });
    expect(rt.settingsPath()).toBe(expected);
  });

  it('a receiver that cannot start rejects and leaves no settings path (AC22)', async () => {
    const writeSettings = vi.fn();
    const rt = runtime({ receiver: fakeReceiver({ startFails: true }), homeDir: '/h', writeSettings });
    await expect(rt.start()).rejects.toThrow('EADDRINUSE');
    expect(writeSettings).not.toHaveBeenCalled();
    expect(rt.settingsPath()).toBeNull();
  });

  it('a settings write failure stops the receiver, rejects and leaves no settings path (AC22)', async () => {
    const receiver = fakeReceiver();
    const rt = runtime({ receiver, homeDir: '/h', writeSettings: () => { throw new Error('EACCES'); }, removeSettings: vi.fn() });
    await expect(rt.start()).rejects.toThrow('EACCES');
    expect(receiver.stop).toHaveBeenCalled();
    expect(rt.settingsPath()).toBeNull();
  });

  it('stop clears the path, removes its settings file and stops the receiver', async () => {
    const receiver = fakeReceiver();
    const removeSettings = vi.fn();
    const rt = runtime({ receiver, homeDir: '/h', writeSettings: vi.fn(), removeSettings });
    await rt.start();
    const path = rt.settingsPath();
    await rt.stop();
    expect(rt.settingsPath()).toBeNull();
    expect(rt.forwarderEnv()).toEqual({});
    expect(removeSettings).toHaveBeenCalledWith(path);
    expect(receiver.stop).toHaveBeenCalledTimes(1);
  });

  it('stop still stops the receiver when removing the file fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const receiver = fakeReceiver();
    const rt = runtime({ receiver, homeDir: '/h', writeSettings: vi.fn(), removeSettings: () => { throw new Error('EPERM'); } });
    await rt.start();
    await expect(rt.stop()).resolves.toBeUndefined();
    expect(receiver.stop).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('stop before start touches nothing on disk', async () => {
    const removeSettings = vi.fn();
    const rt = runtime({ receiver: fakeReceiver(), homeDir: '/h', writeSettings: vi.fn(), removeSettings });
    await rt.stop();
    expect(removeSettings).not.toHaveBeenCalled();
  });

  it('assigns a different named pipe to each Windows instance', () => {
    expect(allocateHookEndpoint('win32', 'first').path).toBe('\\\\.\\pipe\\metaide-claude-hook-first');
    expect(allocateHookEndpoint('win32', 'second').path).not.toBe(allocateHookEndpoint('win32', 'first').path);
  });
});

describe('ClaudeHookRuntime — two instances sharing one HOME (real files)', () => {
  it('get distinct settings files, each pointing at its own receiver', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rt-home-'));
    const a = runtime({ receiver: fakeReceiver(), homeDir: home }, 'first');
    const b = runtime({ receiver: fakeReceiver(), homeDir: home }, 'second');
    await a.start();
    await b.start();
    expect(a.settingsPath()).not.toBe(b.settingsPath());
    expect(a.forwarderEnv()).not.toEqual(b.forwarderEnv());
    expect(readFileSync(a.settingsPath()!, 'utf8')).toContain('"type": "command"');
    expect(readFileSync(b.settingsPath()!, 'utf8')).not.toContain('http://');
    expect(a.settingsPath()!.startsWith(hooksDir(home))).toBe(true);
    expect(b.settingsPath()!.startsWith(hooksDir(home))).toBe(true);
    await a.stop();
    await b.stop();
    rmSync(home, { recursive: true, force: true });
  });

  it('stopping one removes only its own file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rt-home-'));
    const a = runtime({ receiver: fakeReceiver(), homeDir: home }, 'first');
    const b = runtime({ receiver: fakeReceiver(), homeDir: home }, 'second');
    await a.start();
    await b.start();
    const aPath = a.settingsPath()!;
    const bPath = b.settingsPath()!;
    await a.stop();
    expect(existsSync(aPath)).toBe(false);
    expect(existsSync(bPath)).toBe(true);
    expect(readFileSync(bPath, 'utf8')).toContain('"type": "command"');
    await b.stop();
    rmSync(home, { recursive: true, force: true });
  });
});
