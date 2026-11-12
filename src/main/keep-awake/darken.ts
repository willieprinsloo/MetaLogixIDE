/**
 * Display-darken adapters. The real one runs `pmset displaysleepnow` and, if
 * that fails, opens ScreenSaverEngine, each via `execFile` with an absolute
 * path, a fixed argv, a 5 s timeout and no shell. It reports failure as a
 * value and never throws. The recorder replaces it under `METAIDE_TEST_MODE`.
 */
import { appendFile } from 'node:fs/promises';

/** Outcome of a darken attempt; `cause` keeps the last error. */
export type DarkenResult = { ok: true } | { ok: false; cause: unknown };

/** Async darken action. */
export type Darken = () => Promise<DarkenResult>;

/** The slice of `child_process.execFile` used here. */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
  callback: (error: Error | null) => void,
) => unknown;

const TIMEOUT_MS = 5000;
const PMSET = '/usr/bin/pmset';
const OPEN = '/usr/bin/open';
const SCREEN_SAVER = '/System/Library/CoreServices/ScreenSaverEngine.app';

function run(execFile: ExecFileFn, file: string, args: readonly string[]): Promise<DarkenResult> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: TIMEOUT_MS }, (error) =>
        resolve(error ? { ok: false, cause: error } : { ok: true }),
      );
    } catch (cause) {
      resolve({ ok: false, cause });
    }
  });
}

/** Builds the real darken: pmset first, ScreenSaverEngine as fallback. */
export function createDarken(execFile: ExecFileFn): Darken {
  return async () => {
    const first = await run(execFile, PMSET, ['displaysleepnow']);
    if (first.ok) return first;
    return run(execFile, OPEN, [SCREEN_SAVER]);
  };
}

/** Options for the test-mode recorder. */
export interface DarkenRecorderOptions {
  logPath: string | undefined;
  fail: boolean;
}

/** Builds the test-mode darken: appends one line per call to `logPath` and reports failure when `fail` is set. */
export function createDarkenRecorder(options: DarkenRecorderOptions): Darken {
  return async () => {
    if (options.logPath) {
      try {
        await appendFile(options.logPath, `darken ${Date.now()}\n`);
      } catch (cause) {
        return { ok: false, cause };
      }
    }
    return options.fail ? { ok: false, cause: new Error('darken failure injected') } : { ok: true };
  };
}
