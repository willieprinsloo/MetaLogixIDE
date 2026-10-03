/**
 * Composition wiring for the Claude status dots: hook events from the
 * receiver (through the fan-out) and PTY input feed the tracker, a PTY exit
 * discards the shell's state unless the shell was already respawned, a
 * 1 s unref'd interval runs the stale-busy guard, and every transition is
 * broadcast to all windows as `claude-state:changed`. `index.ts` calls
 * `installClaudeStatus` once and calls `stop()` on quit.
 */
import type { HookSource } from '@main/claude-hooks/hook-fanout';
import type { ShellKey } from '@main/claude-hooks/session-registry';
import type { ClaudeShellStateEntry } from '@shared/claude-state';
import type { ClaudeStateTracker } from './state-tracker';

/** Interval of the stale-busy guard tick. */
export const TICK_MS = 1000;

/** Payload of the PTY manager's `'input'` event. */
export interface PtyInputEvent extends ShellKey {
  data: string;
}

/** Everything `installClaudeStatus` wires together. */
export interface ClaudeStatusDeps {
  receiver: HookSource;
  tracker: ClaudeStateTracker;
  ptyManager: {
    on(event: 'input', listener: (ev: PtyInputEvent) => void): unknown;
    on(event: 'exit', listener: (ev: ShellKey) => void): unknown;
    isAlive(projectId: number, shellIndex: number): boolean;
  };
  broadcast(channel: 'claude-state:changed', payload: ClaudeShellStateEntry): void;
}

/** Stops the tick and the broadcasts. */
export interface ClaudeStatusHandle {
  stop(): void;
}

/** Wires receiver, PTY input/exit and the tick into the tracker, and its changes out to every window. */
export function installClaudeStatus(deps: ClaudeStatusDeps): ClaudeStatusHandle {
  const { tracker, ptyManager } = deps;
  deps.receiver.onHook((hook) => tracker.handle(hook));
  ptyManager.on('input', ({ projectId, shellIndex, data }) => tracker.onInput({ projectId, shellIndex }, data));
  ptyManager.on('exit', ({ projectId, shellIndex }) => {
    if (ptyManager.isAlive(projectId, shellIndex)) return;
    tracker.shellExited({ projectId, shellIndex });
  });
  const unsubscribe = tracker.onChange((entry) => deps.broadcast('claude-state:changed', entry));
  const timer = setInterval(() => tracker.tick(), TICK_MS);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
      unsubscribe();
    },
  };
}
