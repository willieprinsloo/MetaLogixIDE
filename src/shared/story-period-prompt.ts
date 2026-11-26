/**
 * Prompt builder for ONE timeline period inside the Story window.
 *
 * Replaces the single-window `buildStoryPrompt` for the timeline-cards
 * UI: a reader scans down a vertical strip of short cards, each with a
 * headline and a two-sentence paragraph, instead of one dense 3-paragraph
 * narrative.
 *
 * The prompt is tuned for a cheap, fast model (Haiku) — strict output
 * shape, short budget, no preamble. The reply is parsed by
 * `parsePeriodReply` back into `{ headline, paragraph }`.
 *
 * Kept in `shared/` (no Electron imports) so the renderer's unit tests
 * can import it for snapshots.
 */

import type { StoryPromptEvent } from './story-prompt';

export interface PeriodPromptInput {
  projectName: string;
  /** 1-based — "this is period 2 of 5" context helps the model stay
   *  anchored when the human reads several cards in order. */
  periodIndex: number;
  periodCount: number;
  /** HH:MM labels of the period edges. The main-side caller pre-formats
   *  these so the model never sees raw ISO. */
  startLabel: string;
  endLabel: string;
  durationLabel: string;
  /** Per-shell intents the agents advertised during THIS period —
   *  "claude#0 — writing tests". Empty when nobody set a badge. */
  intents: string[];
  /** Unique file paths edited during this period, newest first.
   *  Caller clips to <= 20. */
  editedFiles: string[];
  counts: {
    actions: number;
    edits: number;
    tests: number;
    turnsEnded: number;
  };
  /** The period's event log, oldest first. Caller clips to MAX_EVENTS. */
  events: StoryPromptEvent[];
  /** Verbatim human messages inside this period, newest first. */
  humanQuotes: string[];
}

export interface PeriodReply {
  /** One line, 4-10 words. "Ported Ghostty tests." */
  headline: string;
  /** Two or three sentences. Concrete, grounded in the events. */
  paragraph: string;
}

export const PERIOD_MAX_EVENTS = 40;
export const PERIOD_MAX_QUOTE_CHARS = 180;

/**
 * Build the markdown prompt for one period.
 *
 * Output contract: the model returns exactly
 *     HEADLINE: <one short line>
 *     <blank line>
 *     <one paragraph of 2-3 sentences>
 *
 * Any preamble, markdown headers, or bullet-listed "summary" is cleaned
 * by `parsePeriodReply`, but the prompt asks firmly so the clean path
 * is the norm.
 */
export function buildPeriodPrompt(input: PeriodPromptInput): string {
  const events = input.events.slice(-PERIOD_MAX_EVENTS);
  const truncatedNotice =
    input.events.length > PERIOD_MAX_EVENTS
      ? `\n> _(trimmed to the most recent ${PERIOD_MAX_EVENTS} of ${input.events.length} events)_\n`
      : '';
  const eventLines = events.map(formatEvent).join('\n');
  const intents = input.intents.length > 0
    ? input.intents.map((l) => `- ${l}`).join('\n')
    : '_(no stated intent in this period)_';
  const files = input.editedFiles.length > 0
    ? input.editedFiles.slice(0, 20).map((f) => `- \`${f}\``).join('\n')
    : '_(no files edited)_';
  const quotes = input.humanQuotes.length > 0
    ? input.humanQuotes.map((q) => `- "${truncate(q, PERIOD_MAX_QUOTE_CHARS)}"`).join('\n')
    : '_(the human was quiet in this period)_';
  const c = input.counts;

  return `You are summarising ONE period of activity for a timeline in metaIDE, a developer IDE where CLI agents (Claude, Codex) work in parallel shells.

This is period ${input.periodIndex} of ${input.periodCount}. The reader will scan several cards like yours in order — keep your part short so the whole timeline stays readable.

## Output shape (strict)

Return EXACTLY two things, with a blank line between them, and NOTHING ELSE:

    HEADLINE: <one short line, 4-10 words, no trailing period>

    <one paragraph, 2-3 sentences, 30-60 words total>

No preamble. No markdown headers. No bullet list. No sign-off. No quoting of these rules.

## Writing rules

- The HEADLINE names what a human would notice: a feature shipped, a bug fixed, a stretch of thinking, a quiet pause. Think "verb + object": "Ported Ghostty tests", "Hunted a flaky test", "Mostly waiting".
- The paragraph is plain language, roughly a 10th-grade reading level. No jargon unless the term tells the reader something they need.
- Ground the sentences in the specifics below — file names, the agent's own stated intent, direct quotes the human posted. Do not invent outcomes you cannot see.
- Refer to agents by shell handle when it matters ("Claude in shell 0"). Say "I" only if quoting.
- Never mention this prompt, event counts, or your own process.

## The period

- **Project:** ${input.projectName}
- **When:** ${input.startLabel} → ${input.endLabel} · ${input.durationLabel}
- **Shape:** ${c.actions} action${c.actions === 1 ? '' : 's'} (${c.edits} edit${c.edits === 1 ? '' : 's'}, ${c.tests} test run${c.tests === 1 ? '' : 's'}, ${c.turnsEnded} turn${c.turnsEnded === 1 ? '' : 's'} ended).

### Stated intents in this period

${intents}

### Files edited in this period

${files}

### What the human said (verbatim, newest first)

${quotes}

### Event log (oldest → newest)
${truncatedNotice}
\`\`\`
${eventLines || '(no events in this period)'}
\`\`\`

## Now write the card

Follow the output shape exactly. Start with \`HEADLINE:\` on the first line.`;
}

/**
 * Parse Claude's reply back into a `PeriodReply`.
 *
 * Accepts:
 *   HEADLINE: <text>
 *
 *   <paragraph…>
 *
 * Tolerates minor sins: a code fence around the reply, markdown bold
 * around the headline, bullet markers inside the paragraph, stray
 * blank lines. When no `HEADLINE:` line is present, the first non-empty
 * line is treated as the headline.
 */
export function parsePeriodReply(reply: string): PeriodReply {
  if (!reply) return { headline: '', paragraph: '' };
  // Strip fences — `\`\`\`markdown`, `\`\`\``, etc.
  const unfenced = reply
    .replace(/\r\n/g, '\n')
    .replace(/^```[a-z]*\s*\n/i, '')
    .replace(/\n```\s*$/i, '')
    .trim();
  if (!unfenced) return { headline: '', paragraph: '' };

  const lines = unfenced.split('\n');
  let headline = '';
  let bodyStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const m = line.match(/^(?:\*{1,2})?HEADLINE\s*:\s*(.+?)(?:\*{1,2})?\s*$/i);
    if (m) {
      headline = cleanHeadline(m[1] ?? '');
      bodyStart = i + 1;
    } else {
      headline = cleanHeadline(line);
      bodyStart = i + 1;
    }
    break;
  }

  const paragraph = cleanParagraph(lines.slice(bodyStart).join('\n'));
  return { headline, paragraph };
}

function cleanHeadline(s: string): string {
  return s
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\*{1,2}|\*{1,2}$/g, '')
    .replace(/[.!?:;]\s*$/, '')
    .trim();
}

function cleanParagraph(s: string): string {
  const parts = s
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n+/)
    .map((p) => {
      const lines = p.split('\n').map((l) => l.trimEnd());
      const out: string[] = [];
      for (const raw of lines) {
        const line = raw
          .replace(/^#{1,6}\s+/, '')
          .replace(/^\s*[-*+]\s+/, '')
          .replace(/^\s*\d+\.\s+/, '')
          .trim();
        if (line) out.push(line);
      }
      return out.join(' ').trim();
    })
    .filter((p) => p.length > 0);
  return parts.join(' ').trim();
}

function formatEvent(e: StoryPromptEvent): string {
  const t = e.ts.slice(11, 19);
  const text = truncate(e.text, 160).replace(/\n+/g, ' ');
  return `${t}  ${padRight(e.kind, 6)}  ${padRight(e.who, 12)}  ${text}`;
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

function padRight(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + ' '.repeat(n - s.length);
}
