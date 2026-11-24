/**
 * Turn raw agent activity into a plain-English story chunk.
 *
 * Reads the three append-only logs the project already keeps —
 * `.metaide/activity.jsonl`, `.metaide/chat.jsonl`, and
 * `.metaide/intent-outbox.jsonl` — picks everything in a time window,
 * groups it, and produces a self-contained HTML page under
 * `.metaide/story/`.
 *
 * Spike: the summariser is template-driven (count tools, name files).
 * A later pass will hand the data to a model and ask for prose.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import log from 'electron-log/main';
import type { ActivityEntry } from '@shared/activity';
import type { ChatEntry } from '@shared/chat';
import type { IntentUpdate } from '@shared/intent';
import type { StoryChunk } from '@shared/story';
import { storyDir, storyFile, filenameTimestamp } from './paths';
import { renderStoryHtml, type StoryTemplate, type TimelineRow } from './template';
import { readRecentActivity } from '../activity/log';

const CHAT_FILE = '.metaide/chat.jsonl';
const INTENT_FILE = '.metaide/intent-outbox.jsonl';

export interface GenerateOptions {
  /** Project directory on disk. */
  projectPath: string;
  /** Project name for the header strap. */
  projectName: string;
  /** Minutes back from now to include; default 15. */
  windowMinutes?: number;
  /** Clock injector for tests. */
  now?: () => Date;
}

export interface GenerateResult {
  chunk: StoryChunk;
  absPath: string;
}

export function generateStoryChunk(opts: GenerateOptions): GenerateResult {
  const now = opts.now ? opts.now() : new Date();
  const windowMs = (opts.windowMinutes ?? 15) * 60_000;
  const since = new Date(now.getTime() - windowMs);

  const activity = readRecentActivity(opts.projectPath, 500)
    .filter((e) => new Date(e.ts) >= since);
  const chat = readRecentChat(opts.projectPath, 200)
    .filter((e) => new Date(e.ts) >= since);
  const intent = readRecentIntent(opts.projectPath);

  const built = buildTemplate({
    projectName: opts.projectName,
    now,
    since,
    activity,
    chat,
    intent,
  });
  const html = renderStoryHtml(built);

  const dir = storyDir(opts.projectPath);
  mkdirSync(dir, { recursive: true });
  const stamp = filenameTimestamp(now.toISOString());
  const slug = slugify(built.title).slice(0, 48) || 'chunk';
  const file = `${stamp}--${slug}.html`;
  const absPath = storyFile(opts.projectPath, file);
  writeFileSync(absPath, html, 'utf8');

  return {
    chunk: {
      file,
      ts: now.toISOString(),
      title: built.title,
      blurb: built.subtitle,
    },
    absPath,
  };
}

export function listStoryChunks(projectPath: string): StoryChunk[] {
  const dir = storyDir(projectPath);
  if (!existsSync(dir)) return [];
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.html'));
    const chunks: StoryChunk[] = [];
    for (const file of files) {
      const abs = storyFile(projectPath, file);
      let st;
      try { st = statSync(abs); } catch { continue; }
      // Pull title + subtitle from the file head so the list stays
      // truthful even if we rename files later.
      const head = readHead(abs, 4096);
      const title = extractTag(head, 'h1') ?? stripExt(file);
      const blurb = extractClass(head, 'subtitle') ?? '';
      chunks.push({ file, ts: st.mtime.toISOString(), title, blurb });
    }
    // newest first
    return chunks.sort((a, b) => b.ts.localeCompare(a.ts));
  } catch (err) {
    log.warn('[story] list failed', { projectPath, err });
    return [];
  }
}

export function readStoryHtml(projectPath: string, file: string): string | null {
  // Reject anything that tries to break out of the story dir — the renderer
  // will ask for `foo.html` filenames only; nothing good can come from `..`.
  if (file.includes('/') || file.includes('\\') || file.includes('..')) return null;
  const abs = storyFile(projectPath, file);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, 'utf8');
  } catch (err) {
    log.warn('[story] read failed', { projectPath, file, err });
    return null;
  }
}

// ---------- internals ----------

interface BuildInput {
  projectName: string;
  now: Date;
  since: Date;
  activity: ActivityEntry[];
  chat: ChatEntry[];
  intent: IntentUpdate[];
}

function buildTemplate(inp: BuildInput): StoryTemplate {
  const all = [...inp.activity, ...inp.chat.map(chatToActivityLike)].sort(
    (a, b) => a.ts.localeCompare(b.ts),
  );
  const shells = new Map<number, ActivityEntry[]>();
  for (const e of inp.activity) {
    const arr = shells.get(e.shellIndex) ?? [];
    arr.push(e);
    shells.set(e.shellIndex, arr);
  }
  const edits = inp.activity.filter(isEditTool);
  const tests = inp.activity.filter(isTestLike);
  const prompts = inp.activity.filter((e) => e.kind === 'prompt');
  const turnEnds = inp.activity.filter((e) => e.kind === 'turn-end');
  const humanChats = inp.chat.filter((c) => c.from.agent === 'human');
  const agentChats = inp.chat.filter((c) => c.from.agent !== 'human');
  const filesTouched = uniq(edits.map((e) => shortFile(e.target)).filter(Boolean));

  const title = pickTitle({ intent: inp.intent, chats: agentChats, edits, prompts });
  const subtitle = pickSubtitle(inp);

  const paragraphs: string[] = [];

  if (all.length === 0) {
    // Honest about an empty window — don't fabricate activity.
    paragraphs.push(
      'Nothing was logged in this window. Agents may have been idle, or this project has no shells attached yet.',
    );
  } else {
    // First paragraph: overall shape.
    paragraphs.push(overallParagraph({
      shellCount: shells.size,
      activityCount: inp.activity.length,
      editCount: edits.length,
      testCount: tests.length,
      turnEndCount: turnEnds.length,
      filesTouched,
    }));

    // One paragraph per shell when there are several, so each agent's thread is legible.
    if (shells.size > 1) {
      for (const [shell, entries] of [...shells.entries()].sort((a, b) => a[0] - b[0])) {
        paragraphs.push(perShellParagraph(shell, entries, inp.intent));
      }
    }

    // Chat traffic with the human, if any.
    if (humanChats.length > 0 || agentChats.length > 0) {
      paragraphs.push(chatParagraph(humanChats, agentChats));
    }
  }

  return {
    title,
    subtitle,
    paragraphs,
    timeline: all.slice(-200).map(toTimelineRow),
    project: inp.projectName,
  };
}

function overallParagraph(x: {
  shellCount: number;
  activityCount: number;
  editCount: number;
  testCount: number;
  turnEndCount: number;
  filesTouched: string[];
}): string {
  const bits: string[] = [];
  const agents = x.shellCount === 1 ? 'one agent' : `${x.shellCount} agents`;
  bits.push(`In this window, ${agents} did ${x.activityCount} things`);
  if (x.editCount > 0) bits.push(`edited ${plural(x.editCount, 'file')}`);
  if (x.testCount > 0) bits.push(`ran tests ${x.testCount === 1 ? 'once' : `${x.testCount} times`}`);
  if (x.turnEndCount > 0) bits.push(`finished ${plural(x.turnEndCount, 'turn')}`);
  let p = bits.join(', ') + '.';
  if (x.filesTouched.length > 0) {
    const list = x.filesTouched.slice(0, 5).join(', ');
    const more = x.filesTouched.length > 5 ? `, and ${x.filesTouched.length - 5} more` : '';
    p += ` Files it touched: ${list}${more}.`;
  }
  return p;
}

function perShellParagraph(shell: number, entries: ActivityEntry[], intents: IntentUpdate[]): string {
  const edits = entries.filter(isEditTool);
  const tests = entries.filter(isTestLike);
  const otherTools = entries.filter((e) => e.kind === 'tool' && !isEditTool(e) && !isTestLike(e));
  const latestIntent = intents
    .filter((i) => i.shell === shell)
    .sort((a, b) => b.ts.localeCompare(a.ts))[0];
  const bits: string[] = [];
  bits.push(`Shell #${shell}`);
  if (latestIntent?.text) bits.push(`said it was "${latestIntent.text}"`);
  bits.push(`did ${entries.length} actions`);
  const detail: string[] = [];
  if (edits.length) detail.push(plural(edits.length, 'edit'));
  if (tests.length) detail.push(`${tests.length} test ${plural(tests.length, 'run')}`);
  if (otherTools.length) detail.push(`${otherTools.length} other ${plural(otherTools.length, 'tool')}`);
  if (detail.length) bits.push(`— ${detail.join(', ')}`);
  return bits.join(', ') + '.';
}

function chatParagraph(human: ChatEntry[], agent: ChatEntry[]): string {
  if (human.length === 0 && agent.length === 0) return '';
  const bits: string[] = [];
  if (human.length > 0) {
    const first = human[0]?.body ?? '';
    const preview = truncate(first, 80);
    bits.push(
      human.length === 1
        ? `You said: "${preview}".`
        : `You posted ${human.length} times (first: "${preview}").`,
    );
  }
  if (agent.length > 0) {
    bits.push(`Agents posted ${plural(agent.length, 'reply')} in the chat bus.`);
  }
  return bits.join(' ');
}

function pickTitle(x: { intent: IntentUpdate[]; chats: ChatEntry[]; edits: ActivityEntry[]; prompts: ActivityEntry[] }): string {
  const latestIntent = x.intent.sort((a, b) => b.ts.localeCompare(a.ts))[0]?.text;
  if (latestIntent) return capitalise(latestIntent);
  const lastEdit = x.edits[x.edits.length - 1];
  if (lastEdit) {
    const file = shortFile(lastEdit.target);
    if (file) return `Worked on ${file}`;
  }
  const firstPrompt = x.prompts[0];
  if (firstPrompt?.text) return capitalise(truncate(firstPrompt.text, 60));
  const firstChat = x.chats[0];
  if (firstChat?.body) return capitalise(truncate(firstChat.body, 60));
  return 'A quiet chunk';
}

function pickSubtitle(inp: BuildInput): string {
  const span = Math.max(1, Math.round((inp.now.getTime() - inp.since.getTime()) / 60_000));
  const timeFrom = hhmm(inp.since);
  const timeTo = hhmm(inp.now);
  return `${timeFrom}–${timeTo} · ${span} min window · ${inp.activity.length} events · ${inp.chat.length} chat`;
}

function chatToActivityLike(c: ChatEntry): ActivityEntry {
  return {
    id: c.id,
    ts: c.ts,
    agent: c.from.agent,
    shellIndex: c.from.shell,
    kind: 'prompt',
    text: c.body,
  };
}

function toTimelineRow(e: ActivityEntry): TimelineRow {
  const kind = kindFor(e);
  const who = `${e.agent}#${e.shellIndex}`;
  const text =
    e.kind === 'tool' ? `${e.tool ?? ''}${e.target ? ' · ' + shortFile(e.target) : ''}${e.ok === false ? ' (failed)' : ''}` :
    e.kind === 'prompt' ? truncate(e.text ?? '', 180) :
    e.kind === 'notification' ? truncate(e.text ?? '', 180) :
    'turn ended';
  return { time: e.ts.slice(11, 19), kind, who, text };
}

function kindFor(e: ActivityEntry): string {
  if (e.kind !== 'tool') return e.kind;
  if (isEditTool(e)) return 'edit';
  if (isTestLike(e)) return 'test';
  return 'tool';
}

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Create']);
function isEditTool(e: ActivityEntry): boolean {
  return e.kind === 'tool' && !!e.tool && EDIT_TOOLS.has(e.tool);
}

function isTestLike(e: ActivityEntry): boolean {
  if (e.kind !== 'tool') return false;
  const target = (e.target ?? '').toLowerCase();
  return target.includes('test') || target.includes('spec') || (e.tool === 'Bash' && target.startsWith('pnpm test'));
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
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

function capitalise(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function stripExt(f: string): string {
  return f.replace(/\.[^./]+$/, '');
}

function readHead(path: string, bytes: number): string {
  try {
    const buf = Buffer.alloc(bytes);
    const fd = openSync(path, 'r');
    try {
      const n = readSync(fd, buf, 0, bytes, 0);
      return buf.slice(0, n).toString('utf8');
    } finally {
      try { closeSync(fd); } catch { /* best-effort */ }
    }
  } catch { return ''; }
}

function extractTag(html: string, tag: string): string | null {
  const m = html.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, 'i'));
  return m?.[1] ? decodeEntities(m[1]) : null;
}

function extractClass(html: string, cls: string): string | null {
  const m = html.match(new RegExp(`class="${cls}"[^>]*>([^<]+)<`, 'i'));
  return m?.[1] ? decodeEntities(m[1]) : null;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// ---------- JSONL readers (lightweight; the heavy ones live in chat/log and activity/log) ----------

function readRecentChat(projectPath: string, limit: number): ChatEntry[] {
  const path = `${projectPath}/${CHAT_FILE}`;
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0);
    const out: ChatEntry[] = [];
    for (const line of lines.slice(-limit)) {
      try { out.push(JSON.parse(line) as ChatEntry); } catch { /* skip */ }
    }
    return out;
  } catch { return []; }
}

function readRecentIntent(projectPath: string): IntentUpdate[] {
  // Latest intent per (agent,shell) — tail only.
  const path = `${projectPath}/${INTENT_FILE}`;
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0);
    const latest = new Map<string, IntentUpdate>();
    for (const line of lines.slice(-500)) {
      try {
        const raw = JSON.parse(line) as { from?: { agent?: string; shell?: number }; text?: string; ts?: string };
        const agent = raw.from?.agent;
        const shell = raw.from?.shell;
        if (!agent || typeof shell !== 'number') continue;
        const upd: IntentUpdate = {
          agent,
          shell,
          text: raw.text ?? '',
          ts: raw.ts ?? new Date().toISOString(),
        };
        latest.set(`${agent}#${shell}`, upd);
      } catch { /* skip */ }
    }
    return [...latest.values()];
  } catch { return []; }
}
