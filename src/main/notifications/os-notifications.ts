/**
 * Adapter over Electron's `Notification`. Every shown instance stays
 * referenced until it is clicked or closed, because an unreferenced
 * main-process notification can be garbage-collected and silently lose its
 * click handler (electron#21610).
 */

/** Closes one shown notification. */
export interface NotificationHandle {
  close(): void;
}

/** What to show and what a click does. */
export interface ShowOptions {
  title: string;
  body: string;
  onClick: () => void;
}

/** The notification capability the notifier depends on. */
export interface NotificationsPort {
  isSupported(): boolean;
  show(opts: ShowOptions): NotificationHandle;
}

/** The slice of an Electron `Notification` instance this adapter uses. */
export interface NotificationLike {
  on(event: 'click' | 'close', listener: () => void): unknown;
  show(): void;
  close(): void;
}

/** The slice of Electron's `Notification` class this adapter uses. */
export interface NotificationConstructor {
  new (opts: { title: string; body: string; silent: boolean }): NotificationLike;
  isSupported(): boolean;
}

/** Shows OS notifications and retains each one until clicked or closed. */
export class OsNotifications implements NotificationsPort {
  private readonly retained = new Set<NotificationLike>();

  constructor(private readonly ctor: NotificationConstructor) {}

  /** Whether the OS can show notifications here (false on Linux without a daemon). */
  isSupported(): boolean {
    return this.ctor.isSupported();
  }

  /** Shows a notification; a click runs `onClick` (errors are logged, not thrown). */
  show(opts: ShowOptions): NotificationHandle {
    const notification = new this.ctor({ title: opts.title, body: opts.body, silent: false });
    const release = (): void => { this.retained.delete(notification); };
    notification.on('click', () => {
      release();
      try {
        opts.onClick();
      } catch (err) {
        console.warn('[notifications] notification click failed', { cause: err });
      }
    });
    notification.on('close', release);
    this.retained.add(notification);
    notification.show();
    return { close: () => { release(); notification.close(); } };
  }

  /** Number of notifications currently held against garbage collection. */
  retainedCount(): number {
    return this.retained.size;
  }
}
