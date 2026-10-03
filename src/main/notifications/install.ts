/**
 * Composition wiring for Claude notifications: builds the navigation and
 * window-view ports from the app's window state, feeds the notifier the
 * hooks the Claude state tracker applied (so notifications follow the dot
 * state), and releases a shell's hook session and notification when its PTY
 * exits — unless the shell was already respawned, in which case the exit
 * belongs to the replaced process and must not touch its successor.
 * `index.ts` calls `installClaudeNotifications` once.
 */
import type { ShellKey } from '@main/claude-hooks/session-registry';
import type { AppliedHook } from '@main/claude-status/state-tracker';
import { ClaudeNotifier, type ClaudeNotifyToggle } from './claude-notifier';
import { OsNotifications, type NotificationConstructor } from './os-notifications';
import type { ViewedShells, WindowView } from './viewed-shells';

/** The slice of a `BrowserWindow` navigation needs. */
export interface NavWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/** Accessors over the app's window state (may return destroyed windows). */
export interface AppWindows {
  main(): NavWindow | null;
  popout(shell: ShellKey): NavWindow | null;
  focused(): NavWindow | null;
}

/** Collaborators of the notification-click navigation. */
export interface NavigationDeps {
  windows: AppWindows;
  isAlive(shell: ShellKey): boolean;
  broadcast(channel: 'shell:focus-request', payload: ShellKey): void;
}

/** Everything `installClaudeNotifications` wires together. */
export interface InstallDeps {
  hooks: { onHookApplied(listener: (applied: AppliedHook) => void): unknown };
  sessions: { release(shell: ShellKey): void };
  ptyManager: { on(event: 'exit', listener: (ev: ShellKey) => void): unknown; isAlive(projectId: number, shellIndex: number): boolean };
  viewedShells: ViewedShells;
  settings: { get(key: ClaudeNotifyToggle): boolean };
  projects: { get(id: number): { name: string } | null };
  notificationClass: NotificationConstructor;
  windows: AppWindows;
  broadcast(channel: 'shell:focus-request', payload: ShellKey): void;
}

const live = (w: NavWindow | null): NavWindow | null => (w && !w.isDestroyed() ? w : null);

/** Window view for `ViewedShells` with destroyed windows reported as null. */
export function liveWindowView(windows: AppWindows): WindowView {
  return {
    main: () => live(windows.main()),
    popout: (shell) => live(windows.popout(shell)),
    focused: () => live(windows.focused()),
  };
}

/**
 * Notification-click navigation: a popped-out shell's popout is shown and
 * focused (AC12); otherwise main is restored, shown and focused, and the
 * renderer is asked to focus the shell only while it is still alive, so a
 * click for an exited shell never relaunches anything (AC11, AC13).
 */
export function createNavigation(deps: NavigationDeps): (shell: ShellKey) => void {
  return (shell) => {
    const popout = live(deps.windows.popout(shell));
    if (popout) { popout.show(); popout.focus(); return; }
    const main = live(deps.windows.main());
    if (main) {
      if (main.isMinimized()) main.restore();
      main.show();
      main.focus();
    }
    if (deps.isAlive(shell)) deps.broadcast('shell:focus-request', { ...shell });
  };
}

/** Wires tracker-applied hooks → notifier → OS notifications, plus PTY-exit cleanup; returns the notifier. */
export function installClaudeNotifications(deps: InstallDeps): ClaudeNotifier {
  const view = liveWindowView(deps.windows);
  const isAlive = (shell: ShellKey): boolean => deps.ptyManager.isAlive(shell.projectId, shell.shellIndex);
  const notifier = new ClaudeNotifier({
    notifications: new OsNotifications(deps.notificationClass),
    isViewing: (shell) => deps.viewedShells.isViewing(shell, view),
    navigate: createNavigation({ windows: deps.windows, isAlive, broadcast: deps.broadcast }),
    settings: deps.settings,
    projectName: (id) => deps.projects.get(id)?.name ?? null,
  });
  deps.hooks.onHookApplied((applied) => notifier.handle(applied));
  deps.ptyManager.on('exit', ({ projectId, shellIndex }) => {
    if (deps.ptyManager.isAlive(projectId, shellIndex)) return;
    deps.sessions.release({ projectId, shellIndex });
    notifier.shellExited({ projectId, shellIndex });
  });
  return notifier;
}
