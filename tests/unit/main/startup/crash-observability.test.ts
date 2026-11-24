import { describe, expect, it, vi } from 'vitest';
import { installCrashObservability, type CrashObservabilityDeps } from '@main/startup/crash-observability';

function makeDeps() {
  const calls: string[] = [];
  const listeners = new Map<string, () => void>();
  const deps = {
    log: {
      errorHandler: { startCatching: vi.fn(() => { calls.push('errorHandler.startCatching'); }) },
      eventLogger: { startLogging: vi.fn(() => { calls.push('eventLogger.startLogging'); }) },
      info: vi.fn((...data: unknown[]) => { calls.push(`info:${String(data[0])}`); }),
      transports: { file: { getFile: () => ({ path: '/home/u/.config/metaide/logs/main.log' }) } },
    },
    app: {
      getVersion: () => '9.8.7',
      getPath: vi.fn(() => '/home/u/.config/metaide/Crashpad'),
      on: vi.fn((event: string, listener: () => void) => { listeners.set(event, listener); }),
    },
    crashReporter: { start: vi.fn((opts: { uploadToServer: boolean }) => { calls.push(`crashReporter.start:${opts.uploadToServer}`); }) },
    pid: 4242,
  } satisfies CrashObservabilityDeps;
  return { deps, calls, listeners };
}

describe('installCrashObservability', () => {
  it('catches uncaught exceptions and rejections through electron-log', () => {
    const { deps } = makeDeps();
    installCrashObservability(deps);
    expect(deps.log.errorHandler.startCatching).toHaveBeenCalledTimes(1);
  });

  it('logs child-process-gone and render-process-gone app events', () => {
    const { deps } = makeDeps();
    installCrashObservability(deps);
    expect(deps.log.eventLogger.startLogging).toHaveBeenCalledTimes(1);
  });

  it('starts the crash reporter without uploading anywhere', () => {
    const { deps } = makeDeps();
    installCrashObservability(deps);
    expect(deps.crashReporter.start).toHaveBeenCalledTimes(1);
    expect(deps.crashReporter.start).toHaveBeenCalledWith({ uploadToServer: false });
  });

  it('logs a boot marker naming pid, version, log file and crash dump directory', () => {
    const { deps } = makeDeps();
    installCrashObservability(deps);
    expect(deps.app.getPath).toHaveBeenCalledWith('crashDumps');
    expect(deps.log.info).toHaveBeenCalledWith('[metaide] started', {
      pid: 4242,
      version: '9.8.7',
      logFile: '/home/u/.config/metaide/logs/main.log',
      crashDumps: '/home/u/.config/metaide/Crashpad',
    });
  });

  it('logs a clean-exit marker on will-quit, and not before', () => {
    const { deps, listeners } = makeDeps();
    installCrashObservability(deps);
    expect(deps.log.info).not.toHaveBeenCalledWith('[metaide] clean exit', expect.anything());
    const onWillQuit = listeners.get('will-quit');
    expect(onWillQuit).toBeTypeOf('function');
    onWillQuit!();
    expect(deps.log.info).toHaveBeenLastCalledWith('[metaide] clean exit', { pid: 4242 });
  });

  it('installs error catching before anything else can throw', () => {
    const { deps, calls } = makeDeps();
    installCrashObservability(deps);
    expect(calls[0]).toBe('errorHandler.startCatching');
  });
});
