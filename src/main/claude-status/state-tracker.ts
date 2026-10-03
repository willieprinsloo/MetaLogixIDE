/**
 * Per-shell Claude state machine (service layer): idle, busy or blocked,
 * driven by authenticated hook events, answering keystrokes written to a
 * blocked shell, and a stale-busy guard over PTY output silence. Busy may be
 * "waiting on background work" (a `Stop` with background tasks), which the
 * guard and `idle_prompt` leave alone; a needs-input Notification that
 * arrives after the user answered, with no hook since, is stale and ignored.
 * An entry counts only while its hook session is the shell's current one,
 * so a respawn, a release or a shell that never had a session reads idle.
 * Two streams go out: `onChange` (real transitions, the renderer allow-list
 * `{projectId, shellIndex, state}`) and `onHookApplied` (every confirmed
 * hook with its from/to state, main-process only, for the notifier). The
 * tracker is the single place a hook session is confirmed. Never consults
 * notification toggles or what the user is viewing (AC11), and never logs
 * PTY input.
 */
import { stateTransitionFor, type HookTransition } from '@main/claude-hooks/hook-event';
import type { ReceivedHook } from '@main/claude-hooks/receiver';
import type { ShellKey } from '@main/claude-hooks/session-registry';
import type { ClaudeShellState, ClaudeShellStateEntry } from '@shared/claude-state';
import { isAnsweringInput } from './answer-input';

/** A busy shell with no PTY output for this long becomes idle (spec D3), unless it is waiting on background work. */
export const STALE_BUSY_MS = 15_000;

/** Injected ports; `lastOutputAt` is the ms epoch of the shell's last PTY output, or null when unknown. */
export interface ClaudeStateTrackerDeps {
  sessions: { confirm(sessionId: string): boolean; currentId(shell: ShellKey): string | null };
  lastOutputAt(shell: ShellKey): number | null;
  now(): number;
}

/** Receives one entry per real state transition. */
export type ClaudeStateListener = (entry: ClaudeShellStateEntry) => void;

/** One confirmed hook and the shell's state before and after the tracker applied it (`from` may equal `to`). */
export interface AppliedHook {
  hook: ReceivedHook;
  from: ClaudeShellState;
  to: ClaudeShellState;
}

/** Receives every confirmed hook after it was applied. */
export type AppliedHookListener = (applied: AppliedHook) => void;

interface Entry {
  shell: ShellKey;
  sessionId: string;
  state: Exclude<ClaudeShellState, 'idle'>;
  since: number;
  waitingOnBackground: boolean;
  answeredSinceHook: boolean;
}

interface Outcome {
  state: ClaudeShellState;
  waitingOnBackground: boolean;
}

interface RuleContext {
  stale: boolean;
  waiting: boolean;
}

const BUSY: Outcome = { state: 'busy', waitingOnBackground: false };
const BLOCKED: Outcome = { state: 'blocked', waitingOnBackground: false };
const IDLE: Outcome = { state: 'idle', waitingOnBackground: false };

/** Resolves a transition rule against the shell's flags; null leaves the shell untouched. */
const RESOLVE: Readonly<Record<HookTransition, (ctx: RuleContext) => Outcome | null>> = {
  busy: () => BUSY,
  blocked: () => BLOCKED,
  'blocked-unless-stale': (ctx) => (ctx.stale ? null : BLOCKED),
  background: () => ({ state: 'busy', waitingOnBackground: true }),
  idle: () => IDLE,
  'idle-unless-waiting': (ctx) => (ctx.waiting ? null : IDLE),
};

const shellKeyString = (shell: ShellKey): string => `${shell.projectId}:${shell.shellIndex}`;

/** Tracks each hook-tracked shell's Claude state; see the module docblock. */
export class ClaudeStateTracker {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<ClaudeStateListener>();
  private readonly appliedListeners = new Set<AppliedHookListener>();

  constructor(private readonly deps: ClaudeStateTrackerDeps) {}

  /** Confirms and applies one authenticated hook event, then reports it; events from a released session are dropped (AC9). */
  handle(hook: ReceivedHook): void {
    if (!this.deps.sessions.confirm(hook.sessionId)) return;
    const from = this.stateOf(hook.shell);
    this.applyRule(hook, stateTransitionFor(hook.event));
    const applied: AppliedHook = { hook, from, to: this.stateOf(hook.shell) };
    for (const listener of this.appliedListeners) listener(applied);
  }

  /** Moves a blocked shell to busy when `data` answers its prompt (AC7), marking a following needs-input as stale. */
  onInput(shell: ShellKey, data: string): void {
    const entry = this.currentEntry(shell);
    if (entry?.state !== 'blocked' || !isAnsweringInput(data)) return;
    this.transition(shell, entry.sessionId, BUSY, true);
  }

  /** Expires busy shells silent for `STALE_BUSY_MS` unless waiting on background work (AC8, AC25); drops entries of replaced sessions. */
  tick(): void {
    const now = this.deps.now();
    for (const entry of [...this.entries.values()]) {
      if (entry.state !== 'busy' || entry.waitingOnBackground) continue;
      if (!this.isCurrent(entry)) { this.entries.delete(shellKeyString(entry.shell)); continue; }
      const lastActive = Math.max(entry.since, this.deps.lastOutputAt(entry.shell) ?? entry.since);
      if (now - lastActive >= STALE_BUSY_MS) this.transition(entry.shell, entry.sessionId, IDLE);
    }
  }

  /** Discards the shell's state after its PTY exited, emitting idle when it was busy or blocked (AC9, AC26). */
  shellExited(shell: ShellKey): void {
    if (!this.entries.delete(shellKeyString(shell))) return;
    this.emit(shell, 'idle');
  }

  /** The shell's current state; idle unless its entry belongs to its current hook session. */
  stateOf(shell: ShellKey): ClaudeShellState {
    return this.currentEntry(shell)?.state ?? 'idle';
  }

  /** Every shell whose current state is busy or blocked, as fresh entries. */
  list(): ClaudeShellStateEntry[] {
    return [...this.entries.values()]
      .filter((entry) => this.isCurrent(entry))
      .map((entry) => toStateEntry(entry.shell, entry.state));
  }

  /** Subscribes to state transitions; returns the unsubscribe function. */
  onChange(listener: ClaudeStateListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Subscribes to every confirmed hook with its from/to state; returns the unsubscribe function. */
  onHookApplied(listener: AppliedHookListener): () => void {
    this.appliedListeners.add(listener);
    return () => { this.appliedListeners.delete(listener); };
  }

  private applyRule(hook: ReceivedHook, rule: HookTransition | null): void {
    const entry = this.currentEntry(hook.shell);
    const ctx: RuleContext = { stale: entry?.answeredSinceHook ?? false, waiting: entry?.waitingOnBackground ?? false };
    if (entry) entry.answeredSinceHook = false;
    const outcome = rule === null ? null : RESOLVE[rule](ctx);
    if (outcome) this.transition(hook.shell, hook.sessionId, outcome);
  }

  private transition(shell: ShellKey, sessionId: string, outcome: Outcome, answeredSinceHook = false): void {
    const previous = this.stateOf(shell);
    const key = shellKeyString(shell);
    const { state, waitingOnBackground } = outcome;
    if (state === 'idle') this.entries.delete(key);
    else this.entries.set(key, { shell: { ...shell }, sessionId, state, since: this.deps.now(), waitingOnBackground, answeredSinceHook });
    if (state !== previous) this.emit(shell, state);
  }

  private currentEntry(shell: ShellKey): Entry | null {
    const entry = this.entries.get(shellKeyString(shell));
    return entry && this.isCurrent(entry) ? entry : null;
  }

  private isCurrent(entry: Entry): boolean {
    return entry.sessionId === this.deps.sessions.currentId(entry.shell);
  }

  private emit(shell: ShellKey, state: ClaudeShellState): void {
    console.debug('[claude-status] state changed', toStateEntry(shell, state));
    for (const listener of this.listeners) listener(toStateEntry(shell, state));
  }
}

function toStateEntry(shell: ShellKey, state: ClaudeShellState): ClaudeShellStateEntry {
  return { projectId: shell.projectId, shellIndex: shell.shellIndex, state };
}
