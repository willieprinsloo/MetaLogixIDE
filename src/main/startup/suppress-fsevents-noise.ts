/**
 * Silence the one unhandled rejection that fsevents 2.3.3 throws under
 * Electron: `TypeError: Cannot read properties of undefined (reading
 * 'SinceNow')` out of `fsevents/fsevents.js:22`. Its native binary is
 * built against Node's ABI; Electron's runtime loads the .node but
 * `Native.flags` comes back undefined, so every chokidar.watch attempt
 * trips the loader before chokidar can swallow it.
 *
 * Chokidar falls back to libuv's `fs.watch` (which is itself FSEvents on
 * macOS), so file watching keeps working — the noise is purely diagnostic.
 * We drop exactly this one error pattern and leave every other unhandled
 * rejection to Electron's default handler.
 */
import log from 'electron-log/main';

const PATTERN = /Cannot read properties of undefined \(reading 'SinceNow'\)/;

export function installFseventsNoiseFilter(): () => void {
  let loggedOnce = false;
  const listener = (reason: unknown): void => {
    const message = reason instanceof Error ? reason.message : String(reason);
    if (!PATTERN.test(message)) return;
    if (!loggedOnce) {
      log.info('[fsevents] native module incompatible under Electron — chokidar falls back to fs.watch; suppressing further errors');
      loggedOnce = true;
    }
  };
  process.on('unhandledRejection', listener);
  return () => process.off('unhandledRejection', listener);
}
