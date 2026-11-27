/**
 * Turn a FeedbackReport into the markdown body a human (or an agent)
 * would see on the board, plus a one-line title in the shape the board
 * expects. Lives on the main side so the shape is identical for user
 * reports (via IPC) and agent outbox lines (via the watcher).
 *
 * Pure — no FS, no IPC, no Electron imports. Unit-testable in isolation.
 */

import { FEEDBACK_LIMITS, type FeedbackReport, type FeedbackSource } from '@shared/feedback';

export interface ComposedTicket {
  /** Ticket name, trimmed and capped to the shared titleMax. Already
   *  carries the `[bug]` / `[idea]` prefix so a reader scanning the
   *  board can tell them apart at a glance. */
  readonly name: string;
  /** Markdown body. Mirrors what a thoughtful human writes: a short
   *  reporter line, the user's description, then a context block. */
  readonly body: string;
  /** Labels to apply — always `user-feedback` or `agent-reported`. The
   *  board can filter by these and nothing else in the pipeline cares. */
  readonly labels: readonly string[];
}

export function composeTicket(report: FeedbackReport): ComposedTicket {
  const name = ellipsize(`[${report.type}] ${report.title.trim()}`, FEEDBACK_LIMITS.titleMax);
  const body = buildBody(report);
  const labels = report.source.kind === 'agent'
    ? ['agent-reported']
    : ['user-feedback'];
  return { name, body, labels };
}

function buildBody(report: FeedbackReport): string {
  const parts: string[] = [];
  parts.push(describeReporter(report.source));
  const description = report.description.trim();
  if (description) {
    parts.push('');
    parts.push('## What happened');
    parts.push(description);
  }
  parts.push('');
  parts.push('## Environment');
  parts.push(`- metaIDE **${report.context.appVersion}**`);
  parts.push(`- ${prettyPlatform(report.context.osPlatform)} (${report.context.osRelease})`);
  parts.push(`- Terminal engine: ${report.context.terminalEngine}`);
  parts.push(`- Reported: ${report.context.composedAt}`);
  return parts.join('\n');
}

function describeReporter(source: FeedbackSource): string {
  if (source.kind === 'user') return '_Filed from inside metaIDE._';
  const shell = source.shellIndex === 0 ? '' : ` (shell ${source.shellIndex})`;
  return `_Filed by agent **${source.agent}**${shell}._`;
}

function prettyPlatform(raw: string): string {
  switch (raw) {
    case 'darwin': return 'macOS';
    case 'win32': return 'Windows';
    case 'linux': return 'Linux';
    default: return raw;
  }
}

function ellipsize(text: string, max: number): string {
  if (text.length <= max) return text;
  // Keep the "[bug] " prefix visible; trim the tail with an ellipsis so
  // the title still reads as one thought.
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
