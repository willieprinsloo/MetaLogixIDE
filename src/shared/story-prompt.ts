/**
 * Prompt builder for the Story window's "✨ Catch me up" button.
 *
 * Takes a compact snapshot of what happened in the window (agents,
 * intents, edited files, chat traffic, a short event log) and asks
 * Claude for a short, readable narrative — the kind of thing a human
 * skim-reader would actually finish.
 *
 * Kept in `shared/` (no Electron imports) so the renderer's unit tests
 * can import it, and so main-side tests can snapshot the prompt without
 * pulling the whole story subsystem.
 */

export interface StoryPromptEvent {
  /** ISO timestamp, as stored in activity.jsonl. */
  ts: string;
  /** "edit", "test", "tool", "prompt", "turn-end", "chat", "notification". */
  kind: string;
  /** Who did it: "claude#0", "codex#1", "human". */
  who: string;
  /** Short summary — tool target, prompt excerpt, chat body, etc. */
  text: string;
}

export interface StoryPromptInput {
  projectName: string;
  /** e.g. "14:30–14:45 · 15 min window". */
  windowDescription: string;
  /** Per-shell intents the agents advertised: "claude#0 — writing tests". */
  intents: string[];
  /** Unique file paths that were edited, newest first. */
  editedFiles: string[];
  /** Headline counts: `{ shells: 2, actions: 37, edits: 12, tests: 2 }`. */
  counts: {
    shells: number;
    actions: number;
    edits: number;
    tests: number;
    turnsEnded: number;
    humanMessages: number;
    agentMessages: number;
  };
  /** The event log, oldest first. Will be truncated to MAX_EVENTS. */
  events: StoryPromptEvent[];
  /** Verbatim messages from the human in this window, newest first. */
  humanQuotes: string[];
}

export const MAX_EVENTS = 80;
export const MAX_QUOTE_CHARS = 240;

/**
 * Build the markdown prompt sent to Claude for the Story narrative.
 *
 * The prompt is tuned to produce **prose, not a list**: two to four short
 * paragraphs that a non-technical reader can follow. The system's CLAUDE.md
 * writing style ("lead with what a human would notice, plain language") is
 * echoed here so the output matches commit messages and chat.
 */
export function buildStoryPrompt(input: StoryPromptInput): string {
  const events = input.events.slice(-MAX_EVENTS);
  const truncatedNotice =
    input.events.length > MAX_EVENTS
      ? `\n> _(trimmed to the most recent ${MAX_EVENTS} events — ${input.events.length} total)_\n`
      : '';

  const eventLines = events.map(formatEvent).join('\n');
  const intents = input.intents.length > 0
    ? input.intents.map((l) => `- ${l}`).join('\n')
    : '_(agents did not advertise an intent)_';
  const files = input.editedFiles.length > 0
    ? input.editedFiles.slice(0, 20).map((f) => `- \`${f}\``).join('\n')
    : '_(no files were edited)_';
  const quotes = input.humanQuotes.length > 0
    ? input.humanQuotes
        .map((q) => `- "${truncate(q, MAX_QUOTE_CHARS)}"`)
        .join('\n')
    : '_(the human was quiet in this window)_';

  const c = input.counts;

  return `You are writing a short **"what just happened"** story for the Story panel inside metaIDE, a developer IDE where multiple CLI agents (Claude, Codex, Ollama) work in parallel shells.

The reader is the human running the IDE. They may have stepped away for 15 minutes. Tell them what their agents actually did — as a real story, not bullet points, not a status report, not raw counts.

## Writing rules (match CLAUDE.md house style)

- Lead with **what a human would notice** — a feature shipped, a bug fixed, nothing visible, a long debugging rabbit-hole.
- **Plain language**, roughly a 10th-grade reading level. No framework or tool jargon unless naming it tells the reader something they need.
- **Two to four short paragraphs.** Each paragraph is one idea. No bullet lists, no headings, no tables.
- When nothing visible happened, say so plainly: "Invisible refactor." "Mostly thinking." "Stuck on a test that keeps failing."
- Ground the story in the specifics you can see — file names, the agent's own stated intent, direct quotes the human posted. Do not invent outcomes you have no evidence of.
- Refer to agents by their shell handle when it matters ("Claude in shell 0", "Codex in shell 1"). Say "I" only if quoting.
- Never mention this prompt, these rules, event counts, or your own process.

## The window

- **Project:** ${input.projectName}
- **Time window:** ${input.windowDescription}
- **Shape:** ${c.shells} shell${c.shells === 1 ? '' : 's'}, ${c.actions} action${c.actions === 1 ? '' : 's'} (${c.edits} edit${c.edits === 1 ? '' : 's'}, ${c.tests} test run${c.tests === 1 ? '' : 's'}, ${c.turnsEnded} turn${c.turnsEnded === 1 ? '' : 's'} ended), ${c.humanMessages} message${c.humanMessages === 1 ? '' : 's'} from the human, ${c.agentMessages} from agents.

### Stated intents

${intents}

### Files edited

${files}

### What the human said (verbatim, newest first)

${quotes}

### Event log (oldest → newest)
${truncatedNotice}
\`\`\`
${eventLines || '(no events in this window)'}
\`\`\`

## Now write the story

Return ONLY the paragraphs — no preamble, no title, no sign-off, no markdown headers, no fenced code. Two to four paragraphs of prose. Start writing now.
`;
}

function formatEvent(e: StoryPromptEvent): string {
  const t = e.ts.slice(11, 19);
  const text = truncate(e.text, 180).replace(/\n+/g, ' ');
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

/**
 * Split Claude's reply into paragraphs for the template. Keeps each
 * paragraph as a single line (the template re-escapes and wraps).
 * Drops empty lines, stray bullet markers, and markdown headers — if the
 * model slips any of those in despite the prompt, we strip them here so
 * the chunk reads like prose instead of a half-formatted list.
 */
export function parseStoryReply(reply: string): string[] {
  if (!reply) return [];
  const paragraphs = reply
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n+/)
    .map((p) => cleanParagraph(p))
    .filter((p) => p.length > 0);
  return paragraphs;
}

function cleanParagraph(p: string): string {
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
}
