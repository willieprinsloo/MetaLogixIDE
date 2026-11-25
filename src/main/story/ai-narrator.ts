/**
 * Claude-written Story chunks.
 *
 * Takes the same activity + chat + intent window the template narrator
 * uses, feeds a compact summary to the shared headless Claude CLI, and
 * writes an HTML chunk whose prose paragraphs were authored by Claude
 * rather than filled in from counts. The detailed timeline below the
 * prose still comes from the raw event log.
 *
 * If Claude fails, times out, or returns an empty answer, we fall back
 * to the template narrator so the Catch-me-up button is never dead.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import log from 'electron-log/main';
import type { ActivityEntry } from '@shared/activity';
import type { ChatEntry } from '@shared/chat';
import type { IntentUpdate } from '@shared/intent';
import { buildStoryPrompt, parseStoryReply, type StoryPromptEvent } from '@shared/story-prompt';
import { readRecentActivity } from '../activity/log';
import { runCliTurn } from '../group-chat/engines/run-cli';
import { claudeArgs, claudeProgress, parseClaude } from '../group-chat/engines/claude';
import { npmCli } from '../group-chat/engines/cli';
import { filenameTimestamp, storyDir, storyFile } from './paths';
import { renderStoryHtml, type TimelineRow } from './template';
import {
  generateStoryChunk,
  readRecentChat,
  readRecentIntent,
  resolveWindowMinutes,
  toTimelineRow,
  type GenerateOptions,
  type GenerateResult,
} from './narrator';

const AI_TIMEOUT_MS = 60_000;

/**
 * Try to write an AI-narrated story chunk. On any failure (no Claude on
 * PATH, aborted, empty reply, write error) delegate to the template
 * narrator so the user still gets a chunk.
 */
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

  // Window the AI picked (or the user passed in) — reuse it everywhere
  // below so the template fallback and any error path narrate the SAME
  // window the AI looked at, not another `'auto'` round.
  const resolvedOpts: GenerateOptions = { ...opts, windowMinutes: minutes };

  // Nothing to narrate at all — no events, no chat, no stated intent. The
  // template's honest "quiet window" message is already the right output;
  // don't spend a Claude call on it. A window with only an intent (and no
  // tool calls) is still worth narrating — e.g. "Shell 0 said it was
  // waiting for codex icons and stayed quiet since."
  if (activity.length === 0 && chat.length === 0 && intent.length === 0) {
    return generateStoryChunk(resolvedOpts);
  }

  const prompt = buildStoryPrompt(buildPromptInput({
    projectName: opts.projectName,
    now,
    since,
    activity,
    chat,
    intent,
  }));

  let prose: string[] | null = null;
  try {
    prose = await askClaudeForProse(opts.projectPath, prompt);
  } catch (err) {
    log.warn('[story:ai] claude failed; using template', { err: String(err) });
  }

  if (!prose || prose.length === 0) {
    return generateStoryChunk(resolvedOpts);
  }

  const timeline = buildTimeline(activity, chat);
  const title = pickAiTitle(intent, prose);
  const subtitle = pickSubtitle(now, since, activity.length, chat.length);

  const html = renderStoryHtml({
    title,
    subtitle,
    paragraphs: prose,
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
    // Fall back to the template path on any write error so the user still
    // gets something.
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

async function askClaudeForProse(projectPath: string, prompt: string): Promise<string[]> {
  const cmd = npmCli('@anthropic-ai/claude-code', 'claude');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const result = await runCliTurn({
      cmd,
      // No resume / no fork — a one-shot narration must not land in the
      // user's Claude session history.
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
    return parseStoryReply(reply);
  } finally {
    clearTimeout(timer);
  }
}

interface AiInput {
  projectName: string;
  now: Date;
  since: Date;
  activity: ActivityEntry[];
  chat: ChatEntry[];
  intent: IntentUpdate[];
}

function buildPromptInput(inp: AiInput) {
  const shells = new Set(inp.activity.map((e) => e.shellIndex));
  const edits = inp.activity.filter(isEditTool);
  const tests = inp.activity.filter(isTestLike);
  const turnsEnded = inp.activity.filter((e) => e.kind === 'turn-end').length;
  const humanMessages = inp.chat.filter((c) => c.from.agent === 'human').length;
  const agentMessages = inp.chat.length - humanMessages;
  const editedFiles = uniq(edits.map((e) => shortFile(e.target)).filter(Boolean));

  const intents = inp.intent
    .filter((i) => i.text && i.text.trim())
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .map((i) => `${i.agent}#${i.shell} — ${i.text.trim()}`);

  const humanQuotes = inp.chat
    .filter((c) => c.from.agent === 'human' && c.body)
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .map((c) => c.body);

  const events: StoryPromptEvent[] = merge(inp.activity, inp.chat).map(eventFor);

  const windowDescription = `${hhmm(inp.since)}–${hhmm(inp.now)} · ${Math.max(
    1,
    Math.round((inp.now.getTime() - inp.since.getTime()) / 60_000),
  )} min window`;

  return {
    projectName: inp.projectName,
    windowDescription,
    intents,
    editedFiles,
    counts: {
      shells: shells.size,
      actions: inp.activity.length,
      edits: edits.length,
      tests: tests.length,
      turnsEnded,
      humanMessages,
      agentMessages,
    },
    events,
    humanQuotes,
  };
}

function buildTimeline(activity: ActivityEntry[], chat: ChatEntry[]): TimelineRow[] {
  const all = merge(activity, chat);
  return all.slice(-200).map(toTimelineRow);
}

/** Choose a concrete title. Latest intent wins; otherwise take the first
 *  short sentence of the prose. */
function pickAiTitle(intent: IntentUpdate[], prose: string[]): string {
  const latest = intent.sort((a, b) => b.ts.localeCompare(a.ts))[0]?.text;
  if (latest && latest.trim()) return capitalise(truncate(latest.trim(), 70));
  const first = prose[0] ?? '';
  const firstSentence = first.split(/(?<=[.!?])\s+/)[0] ?? first;
  if (firstSentence) return truncate(firstSentence, 70);
  return 'What just happened';
}

function pickSubtitle(now: Date, since: Date, actions: number, chats: number): string {
  const span = Math.max(1, Math.round((now.getTime() - since.getTime()) / 60_000));
  return `${hhmm(since)}–${hhmm(now)} · ${span} min window · ${actions} events · ${chats} chat`;
}

function merge(activity: ActivityEntry[], chat: ChatEntry[]): ActivityEntry[] {
  return [...activity, ...chat.map(chatToActivityLike)].sort((a, b) => a.ts.localeCompare(b.ts));
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

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function capitalise(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
