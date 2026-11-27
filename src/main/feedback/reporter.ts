/**
 * Submit a feedback report to the MetaIDE board.
 *
 * v1 strategy: compose the ticket, log it, and hand the human (or the
 * caller) back a URL that opens the MetaIDE kanban in a browser plus
 * the formatted markdown they can paste into a new ticket. The main
 * process does NOT currently POST directly to the tickets API — the
 * server endpoint is not confirmed in this codebase, and shipping a
 * guessed call that silently fails would be worse than making the user
 * paste once. METAI-9 (or a sibling follow-up) will land the direct
 * create once the endpoint is verified.
 *
 * Shared by both IPC (user dialog) and the agent outbox watcher.
 */

import log from 'electron-log/main';
import { FEEDBACK_PROJECT_ID, type FeedbackReport, type FeedbackSubmitResult } from '@shared/feedback';
import { composeTicket } from './compose';
import { createRateLimiter, type RateLimiter } from './rate-limit';

/** Default MetaIDE board origin. The feature targets a specific project
 *  (the MetaIDE board, 129) which lives at a known public host; callers
 *  can override by passing an explicit `origin`. */
export const DEFAULT_FEEDBACK_ORIGIN = 'https://projects.metalogix.solutions';

export interface SubmitDeps {
  /** Metaproject board origin for the user's MetaIDE board session.
   *  Defaults to `DEFAULT_FEEDBACK_ORIGIN`; pass a different value for
   *  a self-hosted deployment or for tests. */
  readonly origin?: string | null;
  /** In-memory rate limiter shared across all submissions for this
   *  main process. Injected so tests can control the clock. */
  readonly limiter?: RateLimiter;
}

export interface SubmittedReport {
  /** Shaped ticket the board would receive once the direct API lands. */
  readonly ticket: ReturnType<typeof composeTicket>;
  /** Board URL the caller should open to let the human finish creating
   *  the ticket manually. Includes the project id. */
  readonly boardUrl: string | null;
  /** Full report echoed back so the renderer can put the markdown on
   *  the user's clipboard. */
  readonly markdown: string;
}

const DEFAULT_LIMITER = createRateLimiter();

export function submitReport(report: FeedbackReport, deps: SubmitDeps): FeedbackSubmitResult & { submitted?: SubmittedReport } {
  const limiter = deps.limiter ?? DEFAULT_LIMITER;
  const key = report.source.kind === 'agent'
    ? { kind: 'agent' as const, agent: report.source.agent }
    : { kind: 'user' as const };
  const decision = limiter.check(key);
  if (!decision.ok) {
    return { ok: false, message: `Too many reports in a short window. Try again in about ${Math.ceil(decision.retryAfterMs / 60_000)} minute(s).` };
  }
  limiter.record(key);
  const ticket = composeTicket(report);
  const markdown = `# ${ticket.name}\n\n${ticket.body}`;
  const origin = deps.origin === undefined ? DEFAULT_FEEDBACK_ORIGIN : deps.origin;
  const boardUrl = origin ? `${origin}/projects/${FEEDBACK_PROJECT_ID}/kanban` : null;
  log.info('[feedback] accepted report', {
    source: report.source.kind,
    type: report.type,
    titleLength: report.title.length,
    bodyLength: markdown.length,
  });
  return {
    ok: true,
    ticketUrl: boardUrl ?? undefined,
    message: boardUrl
      ? 'Report text copied to your clipboard. Open the board and paste it into a new ticket.'
      : 'Report text copied to your clipboard. Sign in to the MetaIDE board, then paste it into a new ticket.',
    submitted: { ticket, boardUrl, markdown },
  };
}
