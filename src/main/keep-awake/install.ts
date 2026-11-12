/**
 * Composition for the macOS keep-awake timer: builds the adapters and the
 * service, and wires state changes and darken failures to a broadcast.
 * Returns null off darwin. The E2E env seams are honoured only when
 * `METAIDE_TEST_MODE=1`, and then the real `execFile` is never used.
 */
import { KEEP_AWAKE_ENV } from '@shared/keep-awake-contract';
import { OsNotifications, type NotificationConstructor } from '@main/notifications/os-notifications';
import { createDarken, createDarkenRecorder, type Darken, type ExecFileFn } from './darken';
import type { KeepAwakeController } from './port';
import { createPowerAssertion, type PowerSaveBlockerLike } from './power-assertion';
import { createKeepAwakeService } from './service';

/** Everything `installKeepAwake` needs from the Electron/Node boundary. */
export interface InstallKeepAwakeDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  powerSaveBlocker: PowerSaveBlockerLike;
  execFile: ExecFileFn;
  notificationClass: NotificationConstructor;
  broadcast: (channel: string, payload: unknown) => void;
}

function pickDarken(deps: InstallKeepAwakeDeps): Darken {
  if (deps.env.METAIDE_TEST_MODE !== '1') return createDarken(deps.execFile);
  return createDarkenRecorder({
    logPath: deps.env[KEEP_AWAKE_ENV.darkenLog] || undefined,
    fail: deps.env[KEEP_AWAKE_ENV.darkenFail] === '1',
  });
}

/** Installs keep-awake on darwin and returns its controller; returns null on any other platform. */
export function installKeepAwake(deps: InstallKeepAwakeDeps): KeepAwakeController | null {
  if (deps.platform !== 'darwin') return null;
  const notifications = new OsNotifications(deps.notificationClass);
  return createKeepAwakeService({
    assertion: createPowerAssertion(deps.powerSaveBlocker),
    darken: pickDarken(deps),
    notify: (title, body) => {
      if (notifications.isSupported()) notifications.show({ title, body, onClick: () => {} });
    },
    now: () => Date.now(),
    timers: {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    },
    onChange: (state) => deps.broadcast('keep-awake:changed', state),
    onDarkenFailed: () => deps.broadcast('keep-awake:darken-failed', {}),
  });
}
