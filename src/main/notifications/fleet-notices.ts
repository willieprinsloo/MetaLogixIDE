/**
 * Receiving side of fleet notices: a paired machine decided this is the IDE instance in use and sent
 * its agent notice here. It is shown as an OS notification under this machine's own toggles, held
 * back while the focused main window shows that remote shell, and a click opens the shell.
 */
import { toggleFor, type ClaudeNotifyToggle } from './claude-notifier';
import type { Notice } from '@shared/p2p-contract';
import { OsNotifications, type NotificationConstructor, type NotificationHandle, type NotificationsPort } from './os-notifications';
import { raiseMain, type AppWindows } from './install';

/** A shell on a paired machine. */
export interface RemoteShellRef { deviceId: string; projectId: number; shellIndex: number }

/** A notice as it arrives from the P2P layer, with the sending machine. */
export type FleetNoticeEvent = Notice & { deviceId: string; deviceName: string };

export interface FleetNoticeDeps {
  notifications: NotificationsPort;
  isViewing: (shell: RemoteShellRef) => boolean;
  navigate: (event: FleetNoticeEvent) => void;
  settings: { get(key: ClaudeNotifyToggle): boolean };
}

const refKey = (s: RemoteShellRef): string => `${s.deviceId}:${s.projectId}:${s.shellIndex}`;

/** Shows fleet notices subject to this machine's toggles and view, one outstanding per remote shell. */
export class FleetNoticeNotifier {
  private readonly outstanding = new Map<string, NotificationHandle>();

  constructor(private readonly deps: FleetNoticeDeps) {}

  handle(event: FleetNoticeEvent): void {
    const target: RemoteShellRef = { deviceId: event.deviceId, projectId: event.projectId, shellIndex: event.shellIndex };
    if (!this.deps.settings.get(toggleFor(event.kind)) || !this.deps.notifications.isSupported() || this.deps.isViewing(target)) return;
    const key = refKey(target);
    this.outstanding.get(key)?.close();
    this.outstanding.set(key, this.deps.notifications.show({
      title: `${event.projectName || 'Remote project'} on ${event.deviceName} — shell ${event.shellIndex}`,
      body: event.body,
      onClick: () => this.deps.navigate(event),
    }));
  }
}

const DEVICE_ID = /^[a-f0-9]{64}$/;
const VIEWING_ERROR = 'invalid p2p:viewing: expected { shell: null } or { shell: { deviceId: 64 hex, projectId >= 1, shellIndex >= 0 } }';
const bounded = (v: unknown, min: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= 1_000_000;

/** Validates a `p2p:viewing` request. Throws otherwise. A forged view can at worst hold back the user's own notices. */
export function parseRemoteViewing(req: unknown): RemoteShellRef | null {
  if (typeof req !== 'object' || req === null || Array.isArray(req)) throw new Error(VIEWING_ERROR);
  const { shell } = req as { shell?: unknown };
  if (shell === null) return null;
  if (typeof shell !== 'object' || shell === undefined || Array.isArray(shell)) throw new Error(VIEWING_ERROR);
  const { deviceId, projectId, shellIndex } = shell as Record<string, unknown>;
  if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId) || !bounded(projectId, 1) || !bounded(shellIndex, 0)) throw new Error(VIEWING_ERROR);
  return { deviceId, projectId, shellIndex };
}

/** The remote shell the main window reports it is showing, if any. */
export class RemoteViewing {
  private shell: RemoteShellRef | null = null;
  set(shell: RemoteShellRef | null): void { this.shell = shell ? { ...shell } : null; }
  get(): RemoteShellRef | null { return this.shell; }
}

/** What a click on a fleet notice asks the renderer to open. */
export interface FocusRemoteShell extends RemoteShellRef { deviceName: string; projectName: string }

export interface FleetNoticeInstallDeps {
  viewing: RemoteViewing;
  settings: { get(key: ClaudeNotifyToggle): boolean };
  notificationClass: NotificationConstructor;
  windows: Pick<AppWindows, 'main' | 'focused'>;
  broadcast(channel: 'p2p:focus-remote-shell', payload: FocusRemoteShell): void;
}

/** Builds the notifier. Viewing counts only while the main window is focused, as for local notices. */
export function installFleetNotices(deps: FleetNoticeInstallDeps): FleetNoticeNotifier {
  return new FleetNoticeNotifier({
    notifications: new OsNotifications(deps.notificationClass),
    isViewing: (shell) => {
      const viewing = deps.viewing.get();
      const main = deps.windows.main();
      return viewing !== null && main !== null && !main.isDestroyed() && deps.windows.focused() === main && refKey(viewing) === refKey(shell);
    },
    navigate: (e) => {
      raiseMain(deps.windows);
      deps.broadcast('p2p:focus-remote-shell', { deviceId: e.deviceId, deviceName: e.deviceName, projectId: e.projectId, projectName: e.projectName ?? '', shellIndex: e.shellIndex });
    },
    settings: deps.settings,
  });
}
