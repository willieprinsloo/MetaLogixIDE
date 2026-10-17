/**
 * Long-running command "done" notifier. Every 500 ms the PtyManager is asked which shells just
 * finished a long command; each gets a native OS notification unless the user is already looking
 * at it (main window focused and the shell not popped out). Clicking a notification raises the
 * popout that hosts the shell, or else the main window plus a `shell:focus-request` broadcast.
 */
import type { BrowserWindow, Notification } from 'electron';

/** Poll cadence of the done notifier, in milliseconds. */
export const DONE_POLL_INTERVAL_MS = 500;

/** A shell that just finished a long-running command, as reported by the PtyManager. */
export interface DoneCommand {
  projectId: number;
  shellIndex: number;
  durationMs: number;
}

/** A notification the notifier has decided to show for one finished shell. */
export interface DoneNotice {
  projectId: number;
  shellIndex: number;
  popped: boolean;
  title: string;
  body: string;
}

/** Inputs to `planDoneNotice`: focus state, popout membership by `projectId:shellIndex` key, and project-name lookup. */
export interface DonePlanContext {
  mainFocused: boolean;
  isPopped: (key: string) => boolean;
  projectName: (projectId: number) => string | undefined;
}

/** Collaborators of the running notifier; `pollDone` must already exclude hook-confirmed shells. */
export interface DoneNotifierDeps {
  pollDone: () => DoneCommand[];
  focusedWindow: () => BrowserWindow | null;
  mainWindow: () => BrowserWindow | null;
  popout: (key: string) => BrowserWindow | undefined;
  isPopped: (key: string) => boolean;
  projectName: (projectId: number) => string | undefined;
  notificationClass: typeof Notification;
  broadcast: (channel: string, payload: unknown) => void;
}

/** Formats a command duration as whole seconds (`42s`) under a minute, else `Xm Ys`. */
export function formatDoneDuration(durationMs: number): string {
  const secs = Math.round(durationMs / 1000);
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

/** True when `focused` is the live main window. */
export function isMainFocused(focused: BrowserWindow | null, main: BrowserWindow | null): boolean {
  return !!focused && !focused.isDestroyed() && focused === main;
}

/**
 * Decides whether one finished shell gets a notification and what it says: `null` when the main
 * window is focused and the shell is not popped out, otherwise the notice. Unknown projects are
 * named `#<id>`. Lookup errors propagate to the caller.
 */
export function planDoneNotice(d: DoneCommand, ctx: DonePlanContext): DoneNotice | null {
  const projectName = ctx.projectName(d.projectId) ?? `#${d.projectId}`;
  const popped = ctx.isPopped(`${d.projectId}:${d.shellIndex}`);
  if (ctx.mainFocused && !popped) return null;
  return {
    projectId: d.projectId,
    shellIndex: d.shellIndex,
    popped,
    title: `${projectName} — shell ${d.shellIndex}`,
    body: `Command finished in ${formatDoneDuration(d.durationMs)}`,
  };
}

/** Starts the poll loop and returns its interval handle so the caller can clear it on quit. */
export function startDoneNotifier(deps: DoneNotifierDeps): NodeJS.Timeout {
  return setInterval(() => notifyDone(deps), DONE_POLL_INTERVAL_MS);
}

function notifyDone(deps: DoneNotifierDeps): void {
  const done = deps.pollDone();
  if (done.length === 0) return;
  const mainFocused = isMainFocused(deps.focusedWindow(), deps.mainWindow());
  const ctx: DonePlanContext = { mainFocused, isPopped: deps.isPopped, projectName: deps.projectName };
  for (const d of done) {
    const notice = planDoneNotice(d, ctx);
    if (notice) showDoneNotice(notice, deps);
  }
}

function showDoneNotice(notice: DoneNotice, deps: DoneNotifierDeps): void {
  try {
    const notif = new deps.notificationClass({ title: notice.title, body: notice.body, silent: false });
    notif.on('click', () => {
      try {
        focusNoticeShell(notice, deps);
      } catch (err) { console.warn('[metaide] notification click failed', err); }
    });
    notif.show();
  } catch (e) {
    console.warn('[metaide] notification failed', e);
  }
}

function focusNoticeShell(notice: DoneNotice, deps: DoneNotifierDeps): void {
  if (notice.popped) {
    const w = deps.popout(`${notice.projectId}:${notice.shellIndex}`);
    if (w && !w.isDestroyed()) { w.show(); w.focus(); return; }
  }
  const main = deps.mainWindow();
  if (main && !main.isDestroyed()) {
    if (main.isMinimized()) main.restore();
    main.show(); main.focus();
  }
  deps.broadcast('shell:focus-request', { projectId: notice.projectId, shellIndex: notice.shellIndex });
}
