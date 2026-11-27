/**
 * Report-a-bug / leave-feedback — shared contract.
 *
 * One report ends up as one ticket on the MetaIDE board (always project
 * 129, regardless of which project the user has open — they're reporting
 * on metaIDE itself, not whatever folder they're working in). Users file
 * reports through a dialog; agents file them by appending one JSON line
 * per report to `.metaide/feedback-outbox.jsonl`, mirroring the existing
 * chat and intent outboxes.
 *
 * This module owns the shapes. The main-side watcher lives in
 * `src/main/feedback/outbox-watcher.ts`; the submitter in
 * `src/main/feedback/reporter.ts`.
 */

/** Hard-coded target of every report. The ticket says so, and the user
 *  confirmed. If we ever want to let people report against their own
 *  project instead, flip this to a configurable value. */
export const FEEDBACK_PROJECT_ID = 129;

/** Who filed the report. Agents get a visible label on the resulting
 *  ticket; users don't. */
export type FeedbackSource =
  | { readonly kind: 'user' }
  | { readonly kind: 'agent'; readonly agent: string; readonly shellIndex: number };

/** What kind of report — maps to the ticket's `item_type` and a
 *  `user-feedback` / `agent-reported` label. */
export type FeedbackType = 'bug' | 'idea';

/** Always-collected context. The dialog pre-fills these from the preload
 *  bridge; the agent outbox gets them filled in by the main process so
 *  agents can't forge a different version string. */
export interface FeedbackContext {
  /** metaIDE semver from `package.json`, e.g. `0.3.6`. */
  readonly appVersion: string;
  /** Node's `os.platform()` value: `darwin` | `win32` | `linux`. */
  readonly osPlatform: string;
  /** Node's `os.release()` kernel string — enough to disambiguate OS versions. */
  readonly osRelease: string;
  /** Terminal rendering engine in use: `xterm` or `ghostty`. */
  readonly terminalEngine: 'xterm' | 'ghostty' | 'unknown';
  /** ISO timestamp the report was composed. The main process fills this
   *  in if the client left it blank. */
  readonly composedAt: string;
}

/** The report the user composes, before it's turned into a ticket. */
export interface FeedbackReport {
  readonly type: FeedbackType;
  /** 1 line, up to 160 chars after trimming. */
  readonly title: string;
  /** Freeform markdown, up to 8 KiB. Empty is allowed (a bug with just
   *  a title is still a ticket). */
  readonly description: string;
  readonly source: FeedbackSource;
  readonly context: FeedbackContext;
}

/** Hard caps used by both the UI and the main-side validator. The sizes
 *  bound the ticket payload and protect against an agent in a tight loop
 *  filling the outbox with megabytes of garbage. */
export const FEEDBACK_LIMITS = {
  titleMax: 160,
  descriptionMax: 8 * 1024,
} as const;

/** Result of a submit attempt. `ticketUrl` is omitted when the server
 *  returned 2xx but no url field — the toast then falls back to the
 *  project board URL. */
export interface FeedbackSubmitResult {
  readonly ok: boolean;
  /** Full deep link to the created ticket (may be absent on fallback). */
  readonly ticketUrl?: string;
  /** Plain-English message to show the user; set when `ok` is false or
   *  when a fallback path was taken (e.g. "Saved to the outbox — still
   *  signed out"). */
  readonly message?: string;
}

/** Shape the agent outbox watcher accepts. Deliberately a tiny subset of
 *  `FeedbackReport` — context comes from the main process, not the
 *  agent, so an agent can't lie about its version string. */
export interface FeedbackOutboxEntry {
  readonly type: FeedbackType;
  readonly title: string;
  readonly description?: string;
  readonly from: { readonly agent: string; readonly shell?: number };
}

export const FEEDBACK_OUTBOX_RELPATH = '.metaide/feedback-outbox.jsonl';
