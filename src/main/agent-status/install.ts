/** Main-process wiring for PTY lifecycle and screen-derived Claude dots. */
import type { AgentKind, AgentShellStateEntry } from '@shared/agent-state';
import { PosixForegroundObserver } from './foreground-posix';
import { AgentStatusTracker, type SpawnIdentity, type StatusPtyPort } from './state-tracker';

type SpawnEvent = SpawnIdentity;
interface PtyEvents extends StatusPtyPort {
  on(event: 'spawn', listener: (event: SpawnEvent) => void): unknown;
  on(event: 'status-exit', listener: (event: SpawnIdentity) => void): unknown;
  off(event: 'spawn', listener: (event: SpawnEvent) => void): unknown;
  off(event: 'status-exit', listener: (event: SpawnIdentity) => void): unknown;
}

/** Dependencies resolved at composition, independently of notification settings. */
export interface AgentStatusDeps {
  readonly ptyManager: PtyEvents;
  readonly broadcast: (channel: 'agent-state:changed', payload: AgentShellStateEntry) => void;
  readonly platform?: NodeJS.Platform;
  readonly observeForeground?: (pid: number) => Promise<AgentKind | null>;
}

/** Installs lifecycle listeners and a 250 ms bounded sampling tick; stop removes both. */
export function installAgentStatus(deps: AgentStatusDeps): {
  tracker: AgentStatusTracker;
  stop(): void;
} {
  const platform = deps.platform ?? process.platform;
  const observer = platform === 'win32' ? null : new PosixForegroundObserver();
  const sample =
    deps.observeForeground ?? ((pid: number) => observer?.harness(pid) ?? Promise.resolve(null));
  const tracker = new AgentStatusTracker(deps.ptyManager, sample, platform);
  const unsubscribe = tracker.onChange((entry) => deps.broadcast('agent-state:changed', entry));
  const spawned = (event: SpawnEvent): void => {
    tracker.spawn(event);
  };
  const exited = (event: SpawnIdentity): void => {
    tracker.exit(event);
  };
  deps.ptyManager.on('spawn', spawned);
  deps.ptyManager.on('status-exit', exited);
  const timer = setInterval(() => {
    void tracker.refresh();
  }, 250);
  timer.unref();
  return {
    tracker,
    stop(): void {
      clearInterval(timer);
      deps.ptyManager.off('spawn', spawned);
      deps.ptyManager.off('status-exit', exited);
      unsubscribe();
    },
  };
}
