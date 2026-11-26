/**
 * Claude-written Story chunks, rendered as a vertical timeline of per-period cards.
 *
 * Walk the merged activity + chat stream, split it into periods by idle
 * gaps, and ask Claude for a short headline + 2-3 sentence paragraph per
 * period. The raw event log still ships below the cards in a <details>.
 *
 * If Claude fails for a given period, that single card falls back to a
 * template-written headline + paragraph (counts + intent + top files)
 * so one slow or refused call never blanks the chunk. If the model is
 * unreachable for every period, we fall all the way back to the
 * template narrator so the Catch-me-up button is never dead.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import log from 'electron-log/main';
import type { ActivityEntry } from '@shared/activity';
import type { ChatEntry } from '@shared/chat';
import type { IntentUpdate } from '@shared/intent';
import {
  buildPeriodPrompt,
  parsePeriodReply,
  PERIOD_MAX_EVENTS,
  type PeriodPromptInput,
  type PeriodReply,
} from '@shared/story-period-prompt';
import type { StoryPromptEvent } from '@shared/story-prompt';
import { readRecentActivity } from '../activity/log';
import { runCliTurn } from '../group-chat/engines/run-cli';
import { claudeArgs, claudeProgress, parseClaude } from '../group-chat/engines/claude';
import { npmCli } from '../group-chat/engines/cli';
import { filenameTimestamp, storyDir, storyFile } from './paths';
import { renderStoryHtml, type TimelinePeriod, type TimelineRow } from './template';
import {
  generateStoryChunk,
  readRecentChat,
  readRecentIntent,
  resolveWindowMinutes,
  toTimelineRow,
  type GenerateOptions,
  type GenerateResult,
} from './narrator';
import { formatDuration, formatGap, splitIntoPeriods, type StoryPeriod } from './periods';

/** Per-period budget. Each call is small; a strict per-card cap is
 *  cheaper to hit than one global timeout — a stuck period fails on
 *  its own and the next one still runs. */
const PERIOD_TIMEOUT_MS = 30_000;

/** Narration model. The default Claude CLI setup uses whatever the
 *  user picked; we'd rather ask Haiku here — short, cheap, fast — but
 *  the current CLI wrapper doesn't take a model override, so we ride
 *  on the user's default. See [[./claude-cli-model.md]] (future) if we
 *  want to force one. */

export async function generateStoryChunkAI(opts: GenerateOptions): Promise<GenerateResult> {
  const now = opts.now ? opts.now() : new Date();
  const minutes = resolveWindowMinutes(opts, now);
  const windowMs = minutes * 60_000;
  const since = new Date(now.getTime() - windowMs);

  const activity = readRecentActivity(opts.projectPath, 500)
    .filter((e) => new Date(e.ts) >= since);
  const chat = readRecentChat(opts.projectPath, 200)
    .filter((e) => new Date(e.ts) >= since);
  const intent = readRecentIntent(opts.projectPath);

  const resolvedOpts: GenerateOptions = { ...opts, windowMinutes: minutes };

  // Nothing to narrate at all — defer to the template "quiet window" path.
  if (activity.length === 0 && chat.length === 0 && intent.length === 0) {
    return generateStoryChunk(resolvedOpts);
  }

  const merged = mergeEvents(activity, chat);
  const rawPeriods = splitIntoPeriods(merged, intent);

  // Edge case: all events arrived inside a single moment (durationMs 0,
  // one period). The splitter still returns one period — we narrate it.
  // Edge case: no periods (shouldn't happen when merged.length > 0, but
  // guard anyway and let the template path own it).
  if (rawPeriods.length === 0) {
    return generateStoryChunk(resolvedOpts);
  }

  const periodCards: TimelinePeriod[] = [];
  let anyAiSucceeded = false;
  for (let i = 0; i < rawPeriods.length; i++) {
    const p = rawPeriods[i]!;
    const periodInput = buildPeriodPromptInput({
      projectName: opts.projectName,
      period: p,
      periodIndex: i + 1,
      periodCount: rawPeriods.length,
      chat,
    });
    let reply: PeriodReply | null = null;
    try {
      reply = await askClaudeForPeriod(opts.projectPath, buildPeriodPrompt(periodInput));
      if (reply.headline || reply.paragraph) anyAiSucceeded = true;
    } catch (err) {
      log.warn('[story:ai] period narration failed', { period: i, err: String(err) });
    }
    const fallbackHeadline = pickFallbackHeadline(p);
    const fallbackParagraph = pickFallbackParagraph(p);
    periodCards.push({
      startLabel: hhmm(p.startTs),
      endLabel: hhmm(p.endTs),
      metaLabel: `${formatDuration(p.durationMs)} · ${p.events.length} action${p.events.length === 1 ? '' : 's'}`,
      gapBeforeLabel: i === 0 ? null : formatGap(p.gapBeforeMs),
      headline: reply?.headline || fallbackHeadline,
      paragraph: reply?.paragraph || fallbackParagraph,
    });
  }

  // Every card is from the template fallback → let the original template
  // narrator own the output; its prose was tuned for the single-window
  // layout and reads better than a strip of counts-only cards.
  if (!anyAiSucceeded) {
    return generateStoryChunk(resolvedOpts);
  }

  const timeline = buildRawTimeline(merged);
  const title = pickTitle(intent, periodCards);
  const subtitle = pickSubtitle(now, since, activity.length, chat.length);

  const html = renderStoryHtml({
    title,
    subtitle,
    periods: periodCards,
    timeline,
    project: opts.projectName,
  });

  const dir = storyDir(opts.projectPath);
  const stamp = filenameTimestamp(now.toISOString());
  const slug = slugify(title).slice(0, 48) || 'chunk';
  const file = `${stamp}--${slug}.html`;
  const absPath = storyFile(opts.projectPath, file);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(absPath, html, 'utf8');
  } catch (err) {
    log.warn('[story:ai] write failed; falling back', { err: String(err) });
    return generateStoryChunk(resolvedOpts);
  }

  return {
    chunk: {
      file,
      ts: now.toISOString(),
      title,
      blurb: subtitle,
    },
    absPath,
  };
}

async function askClaudeForPeriod(projectPath: string, prompt: string): Promise<PeriodReply> {
  const cmd = npmCli('@anthropic-ai/claude-code', 'claude');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PERIOD_TIMEOUT_MS);
  try {
    const result = await runCliTurn({
      cmd,
      // One-shot per period — must not land in the user's Claude session history.
      args: claudeArgs({ forkFrom: null, engineSession: null, permission: 'auto' }),
      cwd: projectPath,
      text: prompt,
      progress: claudeProgress(),
      parse: parseClaude,
      signal: controller.signal,
    });
    if (!result.ok) throw new Error(result.error ?? 'claude returned no answer');
    const reply = (result.reply ?? '').trim();
    if (!reply) throw new Error('claude returned an empty answer');
    return parsePeriodReply(reply);
  } finally {
    clearTimeout(timer);
  }
}

interface PeriodInputArgs {
  projectName: string;
  period: StoryPeriod;
  periodIndex: number;
  periodCount: number;
  chat: ChatEntry[];
}

/**
 * Pack one period into the prompt's structured input. The period's own
 * events already come merged (activity + chat-as-activity) in ts order
 * from the splitter; we re-derive the chat quotes from the original
 * `chat` list so we can show the human's *verbatim* bodies.
 */
function buildPeriodPromptInput(args: PeriodInputArgs): PeriodPromptInput {
  const { period, chat } = args;
  const edits = period.events.filter(isEditTool);
  const tests = period.events.filter(isTestLike);
  const turnsEnded = period.events.filter((e) => e.kind === 'turn-end').length;
  const editedFiles = uniq(edits.map((e) => shortFile(e.target)).filter(Boolean));

  const intents = period.intents
    .slice()
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .filter((i) => i.text && i.text.trim())
    .map((i) => `${i.agent}#${i.shell} — ${i.text.trim()}`);

  const humanQuotes = chat
    .filter((c) => c.from.agent === 'human' && c.body)
    .filter((c) => c.ts >= period.startTs && c.ts <= period.endTs)
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .map((c) => c.body);

  const events: StoryPromptEvent[] = period.events.slice(-PERIOD_MAX_EVENTS).map(eventFor);

  return {
    projectName: args.projectName,
    periodIndex: args.periodIndex,
    periodCount: args.periodCount,
    startLabel: hhmm(period.startTs),
    endLabel: hhmm(period.endTs),
    durationLabel: formatDuration(period.durationMs),
    intents,
    editedFiles,
    counts: {
      actions: period.events.length,
      edits: edits.length,
      tests: tests.length,
      turnsEnded,
    },
    events,
    humanQuotes,
  };
}

/** Build the raw-events table shown under the cards. Capped at 200
 *  rows regardless of period count so very long windows stay legible. */
function buildRawTimeline(merged: ActivityEntry[]): TimelineRow[] {
  return merged.slice(-200).map(toTimelineRow);
}

/**
 * Merge activity + chat into one ts-sorted stream, labelling chat with
 * a synthetic `tool: 'chat'` so the splitter and the raw-events table
 * can both recognise it.
 */
function mergeEvents(activity: ActivityEntry[], chat: ChatEntry[]): ActivityEntry[] {
  const chatLike = chat.map(chatToActivityLike);
  return [...activity, ...chatLike].sort((a, b) => a.ts.localeCompare(b.ts));
}

function chatToActivityLike(c: ChatEntry): ActivityEntry {
  return {
    id: c.id,
    ts: c.ts,
    agent: c.from.agent,
    shellIndex: c.from.shell,
    kind: 'tool',
    tool: 'chat',
    text: c.body,
  };
}

function eventFor(e: ActivityEntry): StoryPromptEvent {
  const kind =
    e.kind !== 'tool' ? e.kind :
    e.tool === 'chat' ? 'chat' :
    isEditTool(e) ? 'edit' :
    isTestLike(e) ? 'test' : 'tool';
  const who = e.agent === 'human' ? 'human' : `${e.agent}#${e.shellIndex}`;
  const text =
    e.kind === 'tool' ? `${e.tool ?? ''}${e.target ? ' · ' + shortFile(e.target) : ''}${e.text ? ' — ' + truncate(e.text, 120) : ''}` :
    e.kind === 'prompt' ? truncate(e.text ?? '', 180) :
    e.kind === 'notification' ? truncate(e.text ?? '', 180) :
    'turn ended';
  return { ts: e.ts, kind, who, text };
}

/**
 * Pick a chunk-level title. Prefer the LATEST intent set in any period
 * (that's the one the user saw most recently in the badge). Otherwise
 * fall back to the first card's headline, which Claude already wrote.
 */
function pickTitle(intents: IntentUpdate[], cards: TimelinePeriod[]): string {
  const latest = intents
    .slice()
    .sort((a, b) => b.ts.localeCompare(a.ts))[0]?.text;
  if (latest && latest.trim()) return capitalise(truncate(latest.trim(), 70));
  const first = cards[0]?.headline;
  if (first && first.trim()) return truncate(first.trim(), 70);
  return 'What just happened';
}

/**
 * Subtitle that doesn't lie about long windows. Multi-day: include
 * dates so the header strip isn't `07:14 – 07:14`. Same-day: HH:MM only.
 */
function pickSubtitle(now: Date, since: Date, actions: number, chats: number): string {
  const spanMinutes = Math.max(1, Math.round((now.getTime() - since.getTime()) / 60_000));
  const span = formatDuration(spanMinutes * 60_000);
  const multiDay = spanMinutes >= 24 * 60;
  const from = multiDay ? dateTimeLabel(since) : hhmm(since.toISOString());
  const to = multiDay ? dateTimeLabel(now) : hhmm(now.toISOString());
  return `${from} → ${to} · ${span} · ${actions} event${actions === 1 ? '' : 's'} · ${chats} chat`;
}

// ---------- fallbacks when one period's AI call fails ----------

/** Short, concrete sentence a reader can still use. Latest intent wins;
 *  otherwise the dominant kind ("Edited files", "Ran tests", "Worked"). */
function pickFallbackHeadline(p: StoryPeriod): string {
  const intent = p.intents
    .slice()
    .sort((a, b) => b.ts.localeCompare(a.ts))[0]?.text;
  if (intent && intent.trim()) return capitalise(truncate(intent.trim(), 60));
  const edits = p.events.filter(isEditTool).length;
  const tests = p.events.filter(isTestLike).length;
  if (edits > 0 && tests > 0) return 'Edited and tested';
  if (edits > 0) return `Edited ${edits} file${edits === 1 ? '' : 's'}`;
  if (tests > 0) return `Ran tests ${tests === 1 ? 'once' : `${tests} times`}`;
  return 'Worked';
}

function pickFallbackParagraph(p: StoryPeriod): string {
  const edits = p.events.filter(isEditTool);
  const tests = p.events.filter(isTestLike).length;
  const files = uniq(edits.map((e) => shortFile(e.target)).filter(Boolean)).slice(0, 5);
  const parts: string[] = [];
  parts.push(`${p.events.length} action${p.events.length === 1 ? '' : 's'} over ${formatDuration(p.durationMs)}.`);
  if (edits.length) parts.push(`Edited ${edits.length} file${edits.length === 1 ? '' : 's'}${files.length ? ' (' + files.join(', ') + ')' : ''}.`);
  if (tests) parts.push(`Ran tests ${tests === 1 ? 'once' : `${tests} times`}.`);
  return parts.join(' ');
}

// ---------- shared helpers ----------

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Create']);
function isEditTool(e: ActivityEntry): boolean {
  return e.kind === 'tool' && !!e.tool && EDIT_TOOLS.has(e.tool);
}

function isTestLike(e: ActivityEntry): boolean {
  if (e.kind !== 'tool') return false;
  const target = (e.target ?? '').toLowerCase();
  if (e.tool === 'Bash') return /\bpnpm (test|vitest)\b|\bnpm test\b|\bvitest\b/.test(target);
  const segments = target.split(/[/\\.]/);
  return (
    segments.includes('test') ||
    segments.includes('tests') ||
    segments.includes('spec') ||
    segments.includes('specs') ||
    /\.test\.|\.spec\./.test(target)
  );
}

function shortFile(path?: string): string {
  if (!path) return '';
  const trimmed = path.replace(/^.*\//, '');
  return trimmed || basename(path);
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

/** HH:MM from an ISO ts. Date-free so cards stay narrow; the subtitle
 *  carries the date for multi-day windows. */
function hhmm(ts: string): string {
  return ts.slice(11, 16);
}

/** "Nov 24 13:40" — compact, year-free (the subtitle is always
 *  about "recent" work). Falls back to the ISO prefix if parsing
 *  fails so a bad row never throws. */
function dateTimeLabel(d: Date): string {
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return d.toISOString().slice(0, 16).replace('T', ' ');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mm = months[d.getMonth()] ?? 'Jan';
  return `${mm} ${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function capitalise(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
