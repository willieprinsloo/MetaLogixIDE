/** Keeps Claude hook eligibility and session confirmation without owning status dots. */
import { NEEDS_INPUT_TYPES } from '@main/claude-hooks/hook-event';
import type { ReceivedHook } from '@main/claude-hooks/receiver';
import type { ShellKey } from '@main/claude-hooks/session-registry';
import type { AgentState } from '@shared/agent-state';

/** Authenticated hook plus independent notification eligibility before and after it. */
export interface AppliedHook {
  readonly hook: ReceivedHook;
  readonly from: AgentState;
  readonly to: AgentState;
}

interface HistoryEntry {
  readonly shell: ShellKey;
  readonly sessionId: string;
  state: AgentState;
  since: number;
  answeredSinceHook: boolean;
  waitingOnBackground: boolean;
}

/** Ports used by history; never consults status tracker or notification toggles. */
export interface HookHistoryDeps {
  readonly sessions: {
    confirm(sessionId: string): boolean;
    currentId(shell: ShellKey): string | null;
  };
  readonly now: () => number;
  readonly lastOutputAt: (shell: ShellKey) => number | null;
}

const key = (shell: ShellKey): string => `${shell.projectId}:${shell.shellIndex}`;
const ANSWERING_KEY = /^(?:\x1b|\x03|[1-9])$/;

/** Maintains original finished/answered/background notification rules independently. */
export class ClaudeHookHistory {
  private readonly entries = new Map<string, HistoryEntry>();
  private readonly listeners = new Set<(applied: AppliedHook) => void>();

  constructor(private readonly deps: HookHistoryDeps) {}

  /** Confirms current authenticated hook then notifies main-only subscribers of its eligibility. */
  handle(hook: ReceivedHook): void {
    if (
      !this.deps.sessions.confirm(hook.sessionId) ||
      this.deps.sessions.currentId(hook.shell) !== hook.sessionId
    )
      return;
    const from = this.stateOf(hook.shell);
    const existing = this.current(hook.shell);
    const stale = existing?.answeredSinceHook ?? false;
    if (existing) existing.answeredSinceHook = false;
    const { hookEventName, backgroundTaskCount, notificationType } = hook.event;
    if (hookEventName === 'UserPromptSubmit') this.change(hook, 'busy');
    if (
      hookEventName === 'Notification' &&
      notificationType &&
      NEEDS_INPUT_TYPES.has(notificationType) &&
      !stale
    )
      this.change(hook, 'blocked');
    if (
      hookEventName === 'Notification' &&
      notificationType === 'idle_prompt' &&
      !existing?.waitingOnBackground
    )
      this.change(hook, 'idle');
    if (hookEventName === 'Stop')
      this.change(hook, backgroundTaskCount > 0 ? 'busy' : 'idle', backgroundTaskCount > 0);
    const applied = { hook, from, to: this.stateOf(hook.shell) };
    for (const listener of this.listeners) listener(applied);
  }

  /** Records actual answer input to prevent a delayed needs-input hook from alerting. */
  onInput(shell: ShellKey, data: string): void {
    const entry = this.current(shell);
    if (!entry || entry.state !== 'blocked' || !(data.includes('\r') || ANSWERING_KEY.test(data)))
      return;
    entry.state = 'busy';
    entry.answeredSinceHook = true;
    entry.since = this.deps.now();
  }

  /** Settles silent turns for finished eligibility, except ongoing background tasks. */
  tick(): void {
    for (const [shell, entry] of this.entries) {
      if (this.deps.sessions.currentId(entry.shell) !== entry.sessionId) {
        this.entries.delete(shell);
        continue;
      }
      if (entry.state !== 'busy' || entry.waitingOnBackground) continue;
      const last = Math.max(entry.since, this.deps.lastOutputAt(entry.shell) ?? entry.since);
      if (this.deps.now() - last >= 15_000) this.entries.delete(shell);
    }
  }

  /** Removes old eligibility on PTY exit or replacement. */
  shellExited(shell: ShellKey): void {
    this.entries.delete(key(shell));
  }

  /** Returns the current notification-history state, never the dot state. */
  stateOf(shell: ShellKey): AgentState {
    return this.current(shell)?.state ?? 'idle';
  }

  /** Subscribes to authenticated hooks; returns the unsubscribe function. */
  onHookApplied(listener: (applied: AppliedHook) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private current(shell: ShellKey): HistoryEntry | null {
    const entry = this.entries.get(key(shell));
    return entry && entry.sessionId === this.deps.sessions.currentId(shell) ? entry : null;
  }

  private change(hook: ReceivedHook, state: AgentState, waitingOnBackground = false): void {
    if (state === 'idle') {
      this.entries.delete(key(hook.shell));
      return;
    }
    this.entries.set(key(hook.shell), {
      shell: { ...hook.shell },
      sessionId: hook.sessionId,
      state,
      since: this.deps.now(),
      answeredSinceHook: false,
      waitingOnBackground,
    });
  }
}
