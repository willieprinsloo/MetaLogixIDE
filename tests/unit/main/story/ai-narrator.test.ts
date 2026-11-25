/**
 * The AI narrator turns a window of activity + chat into a Claude-written
 * story chunk. We stub the CLI so the tests never call Claude; they verify:
 *  - the prompt handed to Claude mentions the project, intent, files and
 *    event log (i.e. real data gets through, not just counts)
 *  - a successful reply ends up as prose paragraphs in the HTML chunk
 *  - a failed CLI turn falls back to the template narrator so the user
 *    still gets a chunk
 *  - an empty window skips the Claude call entirely (nothing to narrate)
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

const run = vi.hoisted(() => ({
  turn: null as unknown as ReturnType<RunCli> | null,
  calls: 0,
  lastOpts: null as Parameters<RunCli>[0] | null,
}));

vi.mock('@main/group-chat/engines/run-cli', () => ({
  runCliTurn: (opts: Parameters<RunCli>[0]) => {
    run.calls += 1;
    run.lastOpts = opts;
    return (
      run.turn ??
      Promise.resolve({
        ok: true,
        reply:
          'Claude in shell 0 spent the window tightening the diff view.\n\nIt also added a short test and pushed a commit — nothing visible yet.',
      })
    );
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

function seedIntent(projectPath: string, lines: Array<{ agent: string; shell: number; text: string }>): void {
  const dir = join(projectPath, '.metaide');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'intent-outbox.jsonl'),
    lines
      .map((l) => JSON.stringify({ from: { agent: l.agent, shell: l.shell }, text: l.text, ts: '2026-11-24T14:00:00.000Z' }))
      .join('\n') + (lines.length ? '\n' : ''),
    'utf8',
  );
}

const NOW = () => new Date('2026-11-24T14:15:00.000Z');

let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ai-story-'));
  run.turn = null;
  run.calls = 0;
  run.lastOpts = null;
});
afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe('generateStoryChunkAI', () => {
  it('runs one Claude turn and the HTML carries its prose as separate paragraphs', async () => {
    seedActivity(tmp, [
      { id: '1', ts: '2026-11-24T14:05:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Edit', target: 'src/foo.ts' },
      { id: '2', ts: '2026-11-24T14:07:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Bash', target: 'pnpm test' },
    ]);
    seedIntent(tmp, [{ agent: 'claude', shell: 0, text: 'tightening the diff view' }]);

    const mod = await import('@main/story/ai-narrator');
    const { chunk, absPath } = await mod.generateStoryChunkAI({
      projectPath: tmp, projectName: 'metaIDE', now: NOW,
    });

    expect(run.calls).toBe(1);
    expect(existsSync(absPath)).toBe(true);
    const html = readFileSync(absPath, 'utf8');
    expect(html).toContain('<p>Claude in shell 0 spent the window tightening the diff view.</p>');
    expect(html).toContain('<p>It also added a short test and pushed a commit — nothing visible yet.</p>');
    // The timeline still appears below the prose.
    expect(html).toContain('<details>');
    expect(chunk.title).toContain('Tightening the diff view');
  });

  it('passes the project, intent, edited files and human quotes into the prompt', async () => {
    seedActivity(tmp, [
      { id: '1', ts: '2026-11-24T14:05:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Edit', target: 'src/bar.ts' },
    ]);
    seedChat(tmp, [
      { id: 'c1', ts: '2026-11-24T14:06:00.000Z', from: { device: 'd0', shell: 0, agent: 'human' }, to: [{ agent: 'claude' }], body: 'please fix the Story window' },
    ]);
    seedIntent(tmp, [{ agent: 'claude', shell: 0, text: 'rewriting the narrator' }]);

    const mod = await import('@main/story/ai-narrator');
    await mod.generateStoryChunkAI({ projectPath: tmp, projectName: 'metaIDE', now: NOW });

    const prompt = run.lastOpts?.text ?? '';
    expect(prompt).toContain('metaIDE');
    expect(prompt).toContain('rewriting the narrator');
    expect(prompt).toContain('`bar.ts`');
    expect(prompt).toContain('"please fix the Story window"');
    // cwd is the project (so Claude picks up the project's CLAUDE.md and auth).
    expect(run.lastOpts?.cwd).toBe(tmp);
  });

  it('falls back to the template narrator when Claude fails', async () => {
    run.turn = Promise.resolve({ ok: false, reply: '', error: 'claude: command not found' });
    seedActivity(tmp, [
      { id: '1', ts: '2026-11-24T14:05:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Edit', target: 'src/foo.ts' },
    ]);

    const mod = await import('@main/story/ai-narrator');
    const { absPath } = await mod.generateStoryChunkAI({ projectPath: tmp, projectName: 'metaIDE', now: NOW });

    const html = readFileSync(absPath, 'utf8');
    // The template says "one agent did N things"; the AI reply never does.
    expect(html).toContain('one agent did');
  });

  it('falls back when Claude returns an empty answer', async () => {
    run.turn = Promise.resolve({ ok: true, reply: '   \n  \n ' });
    seedActivity(tmp, [
      { id: '1', ts: '2026-11-24T14:05:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Edit', target: 'src/foo.ts' },
    ]);

    const mod = await import('@main/story/ai-narrator');
    const { absPath } = await mod.generateStoryChunkAI({ projectPath: tmp, projectName: 'metaIDE', now: NOW });
    const html = readFileSync(absPath, 'utf8');
    expect(html).toContain('one agent did');
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

  it('still runs Claude when the only thing to narrate is a stated intent (regression for "Waiting for codex icons")', async () => {
    // No tool calls, no chat — but the agent said what it was waiting for.
    // The old short-circuit skipped Claude here and left a generic "nothing
    // happened" message; we want real prose that mentions the intent.
    seedActivity(tmp, []);
    seedChat(tmp, []);
    seedIntent(tmp, [{ agent: 'claude', shell: 0, text: 'waiting for codex icons' }]);
    run.turn = Promise.resolve({
      ok: true,
      reply: 'Claude in shell 0 said it was waiting for codex icons and then went quiet.',
    });

    const mod = await import('@main/story/ai-narrator');
    await mod.generateStoryChunkAI({ projectPath: tmp, projectName: 'metaIDE', now: NOW });

    expect(run.calls).toBe(1);
    // The prompt carried the intent across so Claude has something to write about.
    expect(run.lastOpts?.text ?? '').toContain('waiting for codex icons');
  });

  it('does not resume or fork a user Claude session (so the narration never lands in chat history)', async () => {
    seedActivity(tmp, [
      { id: '1', ts: '2026-11-24T14:05:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Edit', target: 'src/foo.ts' },
    ]);
    const mod = await import('@main/story/ai-narrator');
    await mod.generateStoryChunkAI({ projectPath: tmp, projectName: 'metaIDE', now: NOW });

    const args = run.lastOpts?.args ?? [];
    expect(args.join(' ')).not.toMatch(/--resume/);
    expect(args.join(' ')).not.toMatch(/--fork/);
  });
});
