/**
 * The fsevents-noise filter drops the one TypeError fsevents 2.3.3 throws
 * under Electron and leaves every other unhandled rejection alone. The
 * test registers the filter, then emits rejections through `process.emit`
 * and checks which ones Electron would still see (= which ones a plain
 * `process.on('unhandledRejection', ...)` after ours would observe).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const logMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('electron-log/main', () => ({ default: logMock }));

import { installFseventsNoiseFilter } from '@main/startup/suppress-fsevents-noise';

let uninstall: () => void;
let laterListener: (reason: unknown) => void;
let seen: unknown[];

beforeEach(() => {
  logMock.info.mockReset();
  uninstall = installFseventsNoiseFilter();
  seen = [];
  laterListener = (reason) => seen.push(reason);
  // A listener added AFTER ours still fires for anything we don't drop.
  process.on('unhandledRejection', laterListener);
});

afterEach(() => {
  process.off('unhandledRejection', laterListener);
  uninstall();
});

describe('installFseventsNoiseFilter', () => {
  it('drops the exact fsevents SinceNow TypeError — later listeners still observe it, but at the process level it is logged once', () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'SinceNow')");
    process.emit('unhandledRejection', err, Promise.reject(err).catch(() => {}));
    expect(logMock.info).toHaveBeenCalledTimes(1);
    expect(logMock.info.mock.calls[0][0]).toMatch(/fsevents/);
  });

  it('logs the explanation once even across many SinceNow rejections', () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'SinceNow')");
    for (let i = 0; i < 12; i++) {
      process.emit('unhandledRejection', err, Promise.reject(err).catch(() => {}));
    }
    expect(logMock.info).toHaveBeenCalledTimes(1);
  });

  it('does not touch other unhandled rejections — a later listener still sees them', () => {
    const other = new Error('some other failure');
    process.emit('unhandledRejection', other, Promise.reject(other).catch(() => {}));
    expect(seen).toContain(other);
    expect(logMock.info).not.toHaveBeenCalled();
  });

  it('handles non-Error reasons without throwing (string, null)', () => {
    expect(() => {
      process.emit('unhandledRejection', 'plain string', Promise.reject('plain string').catch(() => {}));
      process.emit('unhandledRejection', null, Promise.reject(null).catch(() => {}));
    }).not.toThrow();
    expect(logMock.info).not.toHaveBeenCalled();
  });

  it('uninstall removes the listener — later SinceNow rejections are no longer logged', () => {
    uninstall();
    const err = new TypeError("Cannot read properties of undefined (reading 'SinceNow')");
    process.emit('unhandledRejection', err, Promise.reject(err).catch(() => {}));
    expect(logMock.info).not.toHaveBeenCalled();
  });
});
