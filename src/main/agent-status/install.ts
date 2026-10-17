/** Main-process wiring for PTY lifecycle, OMP transport and screen-derived Claude dots. */
import type { AgentShellStateEntry } from '@shared/agent-state';
import type { ShellKey } from '@main/claude-hooks/session-registry';
import { PosixForegroundObserver } from './foreground-posix';
import { AgentStatusTracker, type SpawnIdentity, type StatusPtyPort } from './state-tracker';

interface SpawnEvent extends SpawnIdentity {
  readonly ompSpawn?: string;
}
interface PtyEvents extends StatusPtyPort {
  on(event: 'spawn', listener: (event: SpawnEvent) => void): unknown;
  on(event: 'status-exit', listener: (event: SpawnIdentity) => void): unknown;
  off(event: 'spawn', listener: (event: SpawnEvent) => void): unknown;
  off(event: 'status-exit', listener: (event: SpawnIdentity) => void): unknown;
}

/** Dependencies resolved at composition, independently of notification settings. */
export interface AgentStatusDeps {
  readonly ptyManager: PtyEvents;
  readonly receiver: {
    bind(shell: ShellKey, spawn: string, generation: string): void;
    release(shell: ShellKey, generation: string): void;
    setListener(
      listener: (shell: ShellKey, generation: string, state: 'idle' | 'busy' | 'blocked') => void,
    ): void;
  };
  readonly broadcast: (channel: 'agent-state:changed', payload: AgentShellStateEntry) => void;
  readonly platform?: NodeJS.Platform;
  readonly observeForeground?: (pid: number) => Promise<boolean>;
}

/** Installs lifecycle listeners and a 250 ms bounded sampling tick; stop removes both. */
export function installAgentStatus(deps: AgentStatusDeps): {
  tracker: AgentStatusTracker;
  stop(): void;
} {
  const platform = deps.platform ?? process.platform;
  const observer = platform === 'win32' ? null : new PosixForegroundObserver();
  const sample =
    deps.observeForeground ?? ((pid: number) => observer?.hasClaude(pid) ?? Promise.resolve(false));
  const tracker = new AgentStatusTracker(deps.ptyManager, sample, platform);
  deps.receiver.setListener((shell, generation, state) =>
    tracker.ompReport(shell, generation, state),
  );
  const unsubscribe = tracker.onChange((entry) => deps.broadcast('agent-state:changed', entry));
  const spawned = (event: SpawnEvent): void => {
    if (event.agent === 'omp' && event.ompSpawn)
      deps.receiver.bind(
        { projectId: event.projectId, shellIndex: event.shellIndex },
        event.ompSpawn,
        event.generation,
      );
    tracker.spawn(event);
  };
  const exited = (event: SpawnIdentity): void => {
    deps.receiver.release(
      { projectId: event.projectId, shellIndex: event.shellIndex },
      event.generation,
    );
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
