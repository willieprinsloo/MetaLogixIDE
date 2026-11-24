/**
 * Makes main-process deaths diagnosable after the fact. Without it, an
 * uncaught exception, a crashed GPU/utility process or a native crash leaves
 * no trace in `main.log`, and an app that vanished looks the same as one the
 * user quit.
 */

export interface CrashObservabilityDeps {
  log: {
    errorHandler: { startCatching(): void };
    eventLogger: { startLogging(): void };
    info(...data: unknown[]): void;
    transports: { file: { getFile(): { path: string } } };
  };
  app: {
    getVersion(): string;
    getPath(name: 'crashDumps'): string;
    on(event: 'will-quit', listener: () => void): unknown;
  };
  crashReporter: { start(options: { uploadToServer: boolean }): void };
  pid: number;
}

/**
 * Installs crash logging. Call once, before `app.whenReady()`, so the crash
 * reporter covers every child process Electron starts.
 */
export function installCrashObservability({ log, app, crashReporter, pid }: CrashObservabilityDeps): void {
  // First, so a throw in anything below is itself logged.
  log.errorHandler.startCatching();
  // child-process-gone covers the GPU, network and utility processes;
  // render-process-gone is also handled by the window, which reloads it.
  log.eventLogger.startLogging();
  // Minidumps stay on this machine; nothing is uploaded.
  crashReporter.start({ uploadToServer: false });
  log.info('[metaide] started', {
    pid,
    version: app.getVersion(),
    logFile: log.transports.file.getFile().path,
    crashDumps: app.getPath('crashDumps'),
  });
  // A 'started' pid with no 'clean exit' line for the same pid means that
  // run died rather than quit. Match by pid: a second instance logs
  // 'started', fails the single-instance lock, quits and logs 'clean exit',
  // all while the first instance is still running.
  app.on('will-quit', () => log.info('[metaide] clean exit', { pid }));
}
