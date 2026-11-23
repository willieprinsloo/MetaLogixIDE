/**
 * One group-chat turn on one member: one headless engine run (Claude `claude -p`, Codex / Gemini
 * CLI, Ollama HTTP); Stop aborts it. A Claude member runs on its own fork of the tab's
 * conversation it was added from, so nothing is ever typed into the user's tab.
 *
 * Every turn settles exactly once with `{ text }` or `{ failed }`, so a round can never hang.
 */
import type { TurnPhase } from '@shared/group-chat';
import type { TurnItem, TurnResult } from './engines/types';

export type { TurnPhase } from '@shared/group-chat';
export type TurnOutcome = { text: string } | { failed: string };
export interface MemberTurn {
  start(text: string): void;
  stop(reason: string): void;
  phase(): TurnPhase;
  done: Promise<TurnOutcome>;
}

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
