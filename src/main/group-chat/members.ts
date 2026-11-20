/**
 * One group-chat turn on one member. Two kinds:
 *
 * - Claude tab: the member's live interactive Claude keeps its full context, so the round message
 *   is typed into the tab. It waits until Claude is idle, the user hasn't typed for a quiet period,
 *   and the input box holds no draft (the app never touches the user's own input). It pastes the
 *   message as one bracketed paste plus Enter, then answers from the transcript on the tab's next
 *   Stop hook. Stop sends Escape only while our message is the one being answered.
 * - Headless: one engine run (Codex / Gemini CLI, Ollama HTTP); Stop aborts it.
 *
 * Every turn settles exactly once with `{ text }` or `{ failed }`, so a round can never hang.
 */
import type { AgentState } from '@shared/agent-state';
import { claudeInputHasDraft } from '@main/agent-status/claude-screen';
import type { TranscriptAnswer } from './transcript';
import type { TurnItem, TurnResult } from './engines/types';

export type TurnOutcome = { text: string } | { failed: string };
export type TurnPhase = 'queued' | 'waiting-idle' | 'waiting-draft' | 'running';
export interface MemberTurn {
  start(text: string): void;
  stop(reason: string): void;
  phase(): TurnPhase;
  done: Promise<TurnOutcome>;
}

type Shell = { projectId: number; shellIndex: number };
export interface ClaudeTabPorts {
  /** The open tab currently holding this member's Claude session, or null. */
  shell: () => Shell | null;
  state: (shell: Shell) => AgentState | null;
  screenRows: (shell: Shell) => Promise<string[]>;
  lastUserInputAt: (shell: Shell) => number;
  /** Writes to the tab without counting as the user's typing. */
  write: (shell: Shell, data: string) => void;
  /** Stop hooks from this member's Claude session only; returns an unsubscribe. */
  onStop: (cb: (transcriptPath: string) => void) => () => void;
  readAnswer: (path: string, header: string) => Promise<TranscriptAnswer>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => () => void;
}

export const QUIET_MS = 3000;
export const POLL_MS = 500;
export const BRACKETED = (text: string): string => `\x1b[200~${text}\x1b[201~`;
const ESCAPE = '\x1b';
const NOT_OPEN = 'its Claude tab isn’t open';
const CLOSED = 'its Claude tab was closed';

function settleOnce() {
  let resolve!: (o: TurnOutcome) => void;
  const done = new Promise<TurnOutcome>((r) => { resolve = r; });
  let settled = false;
  return {
    done,
    get settled() { return settled; },
    finish(o: TurnOutcome): boolean {
      if (settled) return false;
      settled = true;
      resolve(o);
      return true;
    },
  };
}

const sameShell = (a: Shell | null, b: Shell | null) => !!a && !!b && a.projectId === b.projectId && a.shellIndex === b.shellIndex;

export function claudeTabTurn(ports: ClaudeTabPorts, o: { quietMs?: number; pollMs?: number } = {}): MemberTurn {
  const quietMs = o.quietMs ?? QUIET_MS;
  const pollMs = o.pollMs ?? POLL_MS;
  const s = settleOnce();
  let phase: TurnPhase = 'queued';
  let text = '';
  let header = '';
  let pastedInto: Shell | null = null;
  let cancelTimer: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;

  const schedule = (fn: () => void, ms: number) => { cancelTimer?.(); cancelTimer = ports.setTimer(fn, ms); };
  const finish = (out: TurnOutcome) => {
    if (!s.finish(out)) return;
    cancelTimer?.();
    unsubscribe?.();
    cancelTimer = unsubscribe = null;
  };

  async function waitForTab(): Promise<void> {
    if (s.settled) return;
    const shell = ports.shell();
    if (!shell) { finish({ failed: NOT_OPEN }); return; }
    if (ports.state(shell) !== 'idle' || ports.now() - ports.lastUserInputAt(shell) < quietMs) {
      phase = 'waiting-idle';
      schedule(() => void waitForTab(), pollMs);
      return;
    }
    const rows = await ports.screenRows(shell);
    if (s.settled) return;
    if (claudeInputHasDraft(rows)) {
      phase = 'waiting-draft';
      schedule(() => void waitForTab(), pollMs);
      return;
    }
    // listen before typing, so a fast Stop can't be missed
    unsubscribe = ports.onStop((path) => void onStop(path));
    ports.write(shell, BRACKETED(text));
    ports.write(shell, '\r');
    pastedInto = shell;
    phase = 'running';
    schedule(watchTab, pollMs);
  }

  function watchTab(): void {
    if (s.settled) return;
    if (!sameShell(ports.shell(), pastedInto)) { finish({ failed: CLOSED }); return; }
    schedule(watchTab, pollMs);
  }

  async function onStop(path: string): Promise<void> {
    if (s.settled) return;
    const a = await ports.readAnswer(path, header);
    if (a.status === 'answered') finish({ text: a.text });
  }

  return {
    start(t: string) {
      text = t;
      header = t.split('\n', 1)[0] ?? '';
      schedule(() => void waitForTab(), 0);
    },
    stop(reason: string) {
      if (s.settled) return;
      if (phase === 'running' && pastedInto && sameShell(ports.shell(), pastedInto)) ports.write(pastedInto, ESCAPE);
      finish({ failed: reason });
    },
    phase: () => phase,
    done: s.done,
  };
}

export interface HeadlessPorts {
  /** Runs the member's engine in its project folder. */
  run: (item: TurnItem, signal: AbortSignal) => Promise<TurnResult>;
}

export function headlessTurn(ports: HeadlessPorts, item: Omit<TurnItem, 'text'>): MemberTurn & { result(): TurnResult | null } {
  const s = settleOnce();
  const ctl = new AbortController();
  let phase: TurnPhase = 'queued';
  let result: TurnResult | null = null;
  return {
    start(text: string) {
      phase = 'running';
      ports.run({ ...item, text }, ctl.signal).then(
        (r) => { result = r; s.finish(r.ok ? { text: r.reply } : { failed: r.error || 'the turn failed' }); },
        (e: unknown) => { s.finish({ failed: e instanceof Error ? e.message : String(e) }); },
      );
    },
    stop(reason: string) {
      if (s.settled) return;
      ctl.abort();
      s.finish({ failed: reason });
    },
    phase: () => phase,
    result: () => result,
    done: s.done,
  };
}
