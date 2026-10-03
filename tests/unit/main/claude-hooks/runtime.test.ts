import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeHookRuntime } from '@main/claude-hooks/runtime';

function fakeReceiver(port = 5000, opts: { startFails?: boolean } = {}) {
  let listening = false;
  return {
    start: vi.fn(async () => {
      if (opts.startFails) throw new Error('EADDRINUSE');
      listening = true;
      return port;
    }),
    stop: vi.fn(async () => { listening = false; }),
    url: vi.fn(() => (listening ? `http://127.0.0.1:${port}/claude-hook` : null)),
  };
}

const hooksDir = (home: string) => join(home, '.metaide', 'claude-hooks');

describe('ClaudeHookRuntime', () => {
  it('has no settings path before start', () => {
    const rt = new ClaudeHookRuntime({ receiver: fakeReceiver(), homeDir: '/h', writeSettings: vi.fn() });
    expect(rt.settingsPath()).toBeNull();
  });

  it('start listens, writes a port-keyed settings file for the receiver URL and exposes its path', async () => {
    const writeSettings = vi.fn();
    const rt = new ClaudeHookRuntime({ receiver: fakeReceiver(5000), homeDir: '/h', writeSettings });
    await rt.start();
    const expected = join('/h', '.metaide', 'claude-hooks', 'settings-5000.json');
    expect(writeSettings).toHaveBeenCalledWith(expected, 'http://127.0.0.1:5000/claude-hook');
    expect(rt.settingsPath()).toBe(expected);
  });

  it('a receiver that cannot start rejects and leaves no settings path (AC22)', async () => {
    const writeSettings = vi.fn();
    const rt = new ClaudeHookRuntime({ receiver: fakeReceiver(5000, { startFails: true }), homeDir: '/h', writeSettings });
    await expect(rt.start()).rejects.toThrow('EADDRINUSE');
    expect(writeSettings).not.toHaveBeenCalled();
    expect(rt.settingsPath()).toBeNull();
  });

  it('a settings write failure stops the receiver, rejects and leaves no settings path (AC22)', async () => {
    const receiver = fakeReceiver();
    const rt = new ClaudeHookRuntime({ receiver, homeDir: '/h', writeSettings: () => { throw new Error('EACCES'); }, removeSettings: vi.fn() });
    await expect(rt.start()).rejects.toThrow('EACCES');
    expect(receiver.stop).toHaveBeenCalled();
    expect(rt.settingsPath()).toBeNull();
  });

  it('stop clears the path, removes its settings file and stops the receiver', async () => {
    const receiver = fakeReceiver(5000);
    const removeSettings = vi.fn();
    const rt = new ClaudeHookRuntime({ receiver, homeDir: '/h', writeSettings: vi.fn(), removeSettings });
    await rt.start();
    const path = rt.settingsPath();
    await rt.stop();
    expect(rt.settingsPath()).toBeNull();
    expect(removeSettings).toHaveBeenCalledWith(path);
    expect(receiver.stop).toHaveBeenCalledTimes(1);
  });

  it('stop still stops the receiver when removing the file fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const receiver = fakeReceiver();
    const rt = new ClaudeHookRuntime({ receiver, homeDir: '/h', writeSettings: vi.fn(), removeSettings: () => { throw new Error('EPERM'); } });
    await rt.start();
    await expect(rt.stop()).resolves.toBeUndefined();
    expect(receiver.stop).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('stop before start touches nothing on disk', async () => {
    const removeSettings = vi.fn();
    const rt = new ClaudeHookRuntime({ receiver: fakeReceiver(), homeDir: '/h', writeSettings: vi.fn(), removeSettings });
    await rt.stop();
    expect(removeSettings).not.toHaveBeenCalled();
  });
});

describe('ClaudeHookRuntime — two instances sharing one HOME (real files)', () => {
  it('get distinct settings files, each pointing at its own receiver', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rt-home-'));
    const a = new ClaudeHookRuntime({ receiver: fakeReceiver(5000), homeDir: home });
    const b = new ClaudeHookRuntime({ receiver: fakeReceiver(5001), homeDir: home });
    await a.start();
    await b.start();
    expect(a.settingsPath()).not.toBe(b.settingsPath());
    expect(readFileSync(a.settingsPath()!, 'utf8')).toContain('127.0.0.1:5000');
    expect(readFileSync(b.settingsPath()!, 'utf8')).toContain('127.0.0.1:5001');
    expect(a.settingsPath()!.startsWith(hooksDir(home))).toBe(true);
    expect(b.settingsPath()!.startsWith(hooksDir(home))).toBe(true);
  });

  it('stopping one removes only its own file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rt-home-'));
    const a = new ClaudeHookRuntime({ receiver: fakeReceiver(5000), homeDir: home });
    const b = new ClaudeHookRuntime({ receiver: fakeReceiver(5001), homeDir: home });
    await a.start();
    await b.start();
    const aPath = a.settingsPath()!;
    const bPath = b.settingsPath()!;
    await a.stop();
    expect(existsSync(aPath)).toBe(false);
    expect(existsSync(bPath)).toBe(true);
    expect(readFileSync(bPath, 'utf8')).toContain('127.0.0.1:5001');
  });
});
