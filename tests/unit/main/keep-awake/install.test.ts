import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEEP_AWAKE_DARKEN_DELAY_MS, KEEP_AWAKE_ENV } from '@shared/keep-awake-contract';
import { installKeepAwake, type InstallKeepAwakeDeps } from '@main/keep-awake/install';

function deps(over: Partial<InstallKeepAwakeDeps> = {}) {
  const shown = vi.fn();
  const NotificationClass = Object.assign(
    vi.fn(function (this: unknown, opts: unknown) {
      shown(opts);
      return { on: vi.fn(), show: vi.fn(), close: vi.fn() };
    }),
    { isSupported: () => true },
  );
  const d = {
    platform: 'darwin' as NodeJS.Platform,
    env: {} as NodeJS.ProcessEnv,
    powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn() },
    execFile: vi.fn((_f: string, _a: readonly string[], _o: unknown, cb: (e: Error | null) => void) => cb(null)),
    notificationClass: NotificationClass as unknown as InstallKeepAwakeDeps['notificationClass'],
    broadcast: vi.fn(),
    ...over,
  };
  return { d: d as InstallKeepAwakeDeps, shown, execFile: d.execFile, blocker: d.powerSaveBlocker, broadcast: d.broadcast as ReturnType<typeof vi.fn> };
}

describe('installKeepAwake', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(['linux', 'win32'] as const)('returns null on %s and touches nothing', (platform) => {
    const t = deps({ platform });
    expect(installKeepAwake(t.d)).toBeNull();
    expect(t.blocker.start).not.toHaveBeenCalled();
  });

  it('broadcasts changes and notifies on natural expiry', () => {
    const t = deps();
    const svc = installKeepAwake(t.d)!;
    const endsAt = Date.now() + 5000;
    svc.start(endsAt);
    expect(t.broadcast).toHaveBeenCalledWith('keep-awake:changed', { active: true, endsAt });
    vi.advanceTimersByTime(6000);
    expect(t.broadcast).toHaveBeenLastCalledWith('keep-awake:changed', { active: false });
    expect(t.shown).toHaveBeenCalledWith(expect.objectContaining({ title: 'Keep awake ended' }));
    expect(t.blocker.stop).toHaveBeenCalledWith(1);
  });

  it('without test mode uses the real execFile and ignores the seam vars', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ka-'));
    const logPath = join(dir, 'log');
    const t = deps({ env: { [KEEP_AWAKE_ENV.darkenLog]: logPath, [KEEP_AWAKE_ENV.darkenFail]: '1' } });
    const svc = installKeepAwake(t.d)!;
    svc.start(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_DARKEN_DELAY_MS);
    expect(t.execFile).toHaveBeenCalledWith('/usr/bin/pmset', ['displaysleepnow'], { timeout: 5000 }, expect.any(Function));
    expect(() => readFileSync(logPath)).toThrow();
    expect(t.broadcast).not.toHaveBeenCalledWith('keep-awake:darken-failed', {});
  });

  it('in test mode records darken lines and never calls execFile', async () => {
    vi.useRealTimers();
    const logPath = join(mkdtempSync(join(tmpdir(), 'ka-')), 'log');
    const t = deps({ env: { METAIDE_TEST_MODE: '1', [KEEP_AWAKE_ENV.darkenLog]: logPath } });
    const svc = installKeepAwake(t.d)!;
    svc.start(Date.now() + 60_000);
    svc.darkenNow();
    await vi.waitFor(() => expect(readFileSync(logPath, 'utf8').trim().split('\n')).toHaveLength(1));
    svc.dispose();
    expect(t.execFile).not.toHaveBeenCalled();
  });

  it('in test mode with fail flag broadcasts darken-failed', async () => {
    vi.useRealTimers();
    const t = deps({ env: { METAIDE_TEST_MODE: '1', [KEEP_AWAKE_ENV.darkenFail]: '1' } });
    const svc = installKeepAwake(t.d)!;
    svc.start(Date.now() + 60_000);
    svc.darkenNow();
    await vi.waitFor(() => expect(t.broadcast).toHaveBeenCalledWith('keep-awake:darken-failed', {}));
    svc.dispose();
  });

  it('test seam requires exactly METAIDE_TEST_MODE=1', async () => {
    const t = deps({ env: { METAIDE_TEST_MODE: 'true', [KEEP_AWAKE_ENV.darkenFail]: '1' } });
    const svc = installKeepAwake(t.d)!;
    svc.start(Date.now() + 60_000);
    svc.darkenNow();
    await vi.advanceTimersByTimeAsync(10);
    expect(t.execFile).toHaveBeenCalled();
  });
});
