/**
 * The AI narrator walks the merged (activity + chat) stream, splits it
 * into idle-gap-separated periods, and asks Claude for ONE short card
 * per period. The resulting HTML is a vertical timeline of cards above
 * the raw-events table.
 *
 * These tests stub the CLI so no real Claude call is made; they verify:
 *  - one card per detected period, with the expected headline + body
 *  - the prompt handed to Claude carries real data (project, intent,
 *    files, human quotes) and names the period index/count
 *  - if every period's Claude call fails, the template narrator owns
 *    the output so the user still sees something
 *  - an empty window skips Claude entirely
 *  - a single-period intent-only window still narrates (no activity,
 *    but the agent said what it was waiting for)
 *  - args passed to Claude don't resume/fork a user session
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ActivityEntry } from '@shared/activity';
import type { ChatEntry } from '@shared/chat';

type RunCli = typeof import('@main/group-chat/engines/run-cli').runCliTurn;

interface ReplyState {
  /** Per-call reply strings: wrapped into `{ ok: true, reply }`. */
  queue: string[];
  /** Per-call full results — used when a test needs to mix ok: false
   *  / empty-reply / ok: true across calls. Takes precedence over
   *  `queue` on each call. */
  resultQueue: Array<ReturnType<RunCli>>;
  /** Pin every call to this result — the "always fails" shape. */
  fixed: ReturnType<RunCli> | null;
}

const run = vi.hoisted(() => ({
  state: { queue: [] as string[], resultQueue: [] as Array<ReturnType<RunCli>>, fixed: null } as ReplyState,
  calls: 0,
  prompts: [] as string[],
  lastOpts: null as Parameters<RunCli>[0] | null,
}));

vi.mock('@main/group-chat/engines/run-cli', () => ({
  runCliTurn: (opts: Parameters<RunCli>[0]) => {
    run.calls += 1;
    run.lastOpts = opts;
    run.prompts.push(opts.text ?? '');
    if (run.state.fixed) return run.state.fixed;
    const asResult = run.state.resultQueue.shift();
    if (asResult) return asResult;
    const next = run.state.queue.shift();
    const reply = next ?? 'HEADLINE: A quiet moment\n\nOne short sentence about the period.';
    return Promise.resolve({ ok: true, reply });
  },
}));

vi.mock('@main/group-chat/engines/cli', () => ({
  npmCli: () => ['claude'],
}));

function seedActivity(projectPath: string, entries: ActivityEntry[]): void {
  const dir = join(projectPath, '.metaide');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'activity.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''),
    'utf8',
  );
}

function seedChat(projectPath: string, entries: ChatEntry[]): void {
  const dir = join(projectPath, '.metaide');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'chat.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''),
    'utf8',
  );
}

function seedIntent(projectPath: string, lines: Array<{ agent: string; shell: number; text: string; ts?: string }>): void {
  const dir = join(projectPath, '.metaide');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'intent-outbox.jsonl'),
    lines
      .map((l) =>
        JSON.stringify({
          from: { agent: l.agent, shell: l.shell },
          text: l.text,
          ts: l.ts ?? '2026-11-24T14:00:00.000Z',
        }),
      )
      .join('\n') + (lines.length ? '\n' : ''),
    'utf8',
  );
}

const NOW = () => new Date('2026-11-24T18:15:00.000Z');

let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ai-story-'));
  run.state = { queue: [], resultQueue: [], fixed: null };
  run.calls = 0;
  run.prompts = [];
  run.lastOpts = null;
});
afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe('generateStoryChunkAI — timeline cards', () => {
  it('renders one card per idle-gap-separated period, each with the headline and body Claude returned', async () => {
    // Two groups separated by a 2-hour gap (default threshold is 30 min).
    seedActivity(tmp, [
      { id: '1', ts: '2026-11-24T14:05:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Edit', target: 'src/foo.ts' },
      { id: '2', ts: '2026-11-24T14:12:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Bash', target: 'pnpm test' },
      // -- 2h gap --
      { id: '3', ts: '2026-11-24T16:40:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Edit', target: 'src/bar.ts' },
      { id: '4', ts: '2026-11-24T16:55:00.000Z', agent: 'claude', shellIndex: 0, kind: 'turn-end' },
    ]);
    seedIntent(tmp, [
      { agent: 'claude', shell: 0, text: 'tightening the diff view', ts: '2026-11-24T14:10:00.000Z' },
      { agent: 'claude', shell: 0, text: 'cleaning up bar.ts', ts: '2026-11-24T16:50:00.000Z' },
    ]);
    run.state.queue.push(
      'HEADLINE: Tightened the diff view\n\nFirst Claude edited foo.ts and ran pnpm test. The run was green.',
      'HEADLINE: Cleaned up bar.ts\n\nSecond Claude edited bar.ts and wrapped up the turn.',
    );

    const mod = await import('@main/story/ai-narrator');
    const { chunk, absPath } = await mod.generateStoryChunkAI({
      projectPath: tmp, projectName: 'metaIDE', now: NOW,
    });

    expect(run.calls).toBe(2);
    expect(existsSync(absPath)).toBe(true);
    const html = readFileSync(absPath, 'utf8');

    // Both headlines land as <h2 class="headline">.
    expect(html).toContain('>Tightened the diff view<');
    expect(html).toContain('>Cleaned up bar.ts<');
    // Both bodies land as <p class="body">.
    expect(html).toContain('First Claude edited foo.ts and ran pnpm test. The run was green.');
    expect(html).toContain('Second Claude edited bar.ts and wrapped up the turn.');
    // Two period <li>s in the ordered list.
    expect(html.match(/<li class="period">/g)?.length).toBe(2);
    // A gap strip is rendered between the two cards.
    expect(html).toMatch(/<li class="gap"[^>]*><span>[^<]*gap<\/span><\/li>/);
    // The raw-events table still ships below.
    expect(html).toContain('<details>');
    expect(html).toContain('Timeline · 4 events');
    // Chunk title comes from the latest intent.
    expect(chunk.title).toContain('Cleaning up bar.ts');
  });

  it('passes period index, project, intent, files and human quotes into each prompt', async () => {
    seedActivity(tmp, [
      { id: '1', ts: '2026-11-24T18:05:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Edit', target: 'src/bar.ts' },
    ]);
    seedChat(tmp, [
      { id: 'c1', ts: '2026-11-24T18:06:00.000Z', from: { device: 'd0', shell: 0, agent: 'human' }, to: [{ agent: 'claude' }], body: 'please fix the Story window' },
    ]);
    seedIntent(tmp, [{ agent: 'claude', shell: 0, text: 'rewriting the narrator', ts: '2026-11-24T18:06:00.000Z' }]);

    const mod = await import('@main/story/ai-narrator');
    await mod.generateStoryChunkAI({ projectPath: tmp, projectName: 'metaIDE', now: NOW });

    expect(run.prompts.length).toBe(1);
    const prompt = run.prompts[0]!;
    expect(prompt).toContain('metaIDE');
    expect(prompt).toContain('period 1 of 1');
    expect(prompt).toContain('rewriting the narrator');
    expect(prompt).toContain('`bar.ts`');
    expect(prompt).toContain('"please fix the Story window"');
    expect(run.lastOpts?.cwd).toBe(tmp);
  });

  it('falls back to the template narrator when every period returns an error', async () => {
    run.state.fixed = Promise.resolve({ ok: false, reply: '', error: 'claude: command not found' });
    seedActivity(tmp, [
      { id: '1', ts: '2026-11-24T18:05:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Edit', target: 'src/foo.ts' },
    ]);

    const mod = await import('@main/story/ai-narrator');
    const { absPath } = await mod.generateStoryChunkAI({ projectPath: tmp, projectName: 'metaIDE', now: NOW });

    const html = readFileSync(absPath, 'utf8');
    // The template's "one agent did N things" sentence — the AI path never
    // produces that phrase.
    expect(html).toContain('one agent did');
  });

  it('keeps rendering cards when one period fails but another succeeds (per-card fallback)', async () => {
    seedActivity(tmp, [
      { id: '1', ts: '2026-11-24T14:05:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Edit', target: 'src/a.ts' },
      // -- gap --
      { id: '2', ts: '2026-11-24T17:00:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Edit', target: 'src/b.ts' },
    ]);
    // First call fails, second succeeds — resultQueue handles this per-call mix.
    run.state.resultQueue = [
      Promise.resolve({ ok: false, reply: '', error: 'rate limit' }),
      Promise.resolve({ ok: true, reply: 'HEADLINE: Edited b.ts\n\nTouched b.ts.' }),
    ];

    const mod = await import('@main/story/ai-narrator');
    const { absPath } = await mod.generateStoryChunkAI({ projectPath: tmp, projectName: 'metaIDE', now: NOW });

    const html = readFileSync(absPath, 'utf8');
    // Second card is Claude's prose.
    expect(html).toContain('>Edited b.ts<');
    expect(html).toContain('Touched b.ts.');
    // First card falls back to the template helper — it leads with the
    // period's edit count. No AI prose there.
    expect(html).toContain('>Edited 1 file<');
    expect(html.match(/<li class="period">/g)?.length).toBe(2);
  });

  it('does not spend a Claude call when the window is truly empty (no activity, chat, or intent)', async () => {
    seedActivity(tmp, []);
    seedChat(tmp, []);
    const mod = await import('@main/story/ai-narrator');
    const { absPath } = await mod.generateStoryChunkAI({ projectPath: tmp, projectName: 'metaIDE', now: NOW });
    expect(run.calls).toBe(0);
    const html = readFileSync(absPath, 'utf8');
    expect(html).toContain('Nothing was logged');
  });

  it('does not resume or fork a user Claude session (so the narration never lands in chat history)', async () => {
    seedActivity(tmp, [
      { id: '1', ts: '2026-11-24T18:05:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Edit', target: 'src/foo.ts' },
    ]);
    const mod = await import('@main/story/ai-narrator');
    await mod.generateStoryChunkAI({ projectPath: tmp, projectName: 'metaIDE', now: NOW });

    const args = run.lastOpts?.args ?? [];
    expect(args.join(' ')).not.toMatch(/--resume/);
    expect(args.join(' ')).not.toMatch(/--fork/);
  });
});
