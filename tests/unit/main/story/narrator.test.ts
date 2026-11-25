/**
 * Narrator tests: seed a tmp project with activity/chat/intent files,
 * generate a chunk, verify the rendered HTML, round-trip through
 * listStoryChunks + readStoryHtml, and probe the edge cases we care
 * about (empty log, window filtering, path-traversal defence).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateStoryChunk,
  listStoryChunks,
  readStoryHtml,
} from '@main/story/narrator';
import type { ActivityEntry } from '@shared/activity';
import type { ChatEntry } from '@shared/chat';
import { STORY_DIR } from '@shared/story';

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

function fixedNow(): Date { return new Date('2026-11-24T14:15:00.000Z'); }

let tmp = '';
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'story-')); });
afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe('generateStoryChunk', () => {
  it('writes an HTML file under .metaide/story/', () => {
    seedActivity(tmp, [
      { id: '1', ts: '2026-11-24T14:05:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Edit', target: 'src/foo.ts' },
    ]);
    const { chunk, absPath } = generateStoryChunk({
      projectPath: tmp, projectName: 'proj', now: fixedNow,
    });
    expect(existsSync(absPath)).toBe(true);
    expect(absPath).toContain(STORY_DIR);
    expect(chunk.file).toMatch(/\.html$/);
    expect(chunk.ts).toBe('2026-11-24T14:15:00.000Z');
    expect(readFileSync(absPath, 'utf8')).toContain('<h1>');
  });

  it('writes a filesystem-safe filename', () => {
    seedActivity(tmp, []);
    const { chunk } = generateStoryChunk({ projectPath: tmp, projectName: 'proj', now: fixedNow });
    // No colons (would break on Windows), no spaces, HTML extension.
    expect(chunk.file).not.toContain(':');
    expect(chunk.file).not.toContain(' ');
    expect(chunk.file.endsWith('.html')).toBe(true);
  });

  it('writes an empty-state chunk when nothing happened in the window', () => {
    // No activity, no chat, no intent.
    mkdirSync(join(tmp, '.metaide'), { recursive: true });
    const { absPath } = generateStoryChunk({ projectPath: tmp, projectName: 'proj', now: fixedNow });
    const html = readFileSync(absPath, 'utf8');
    expect(html).toContain('Nothing was logged in this window');
    expect(html).toContain('Agents may have been idle');
  });

  it('names the latest intent in the empty-state chunk when one is set', () => {
    // No activity and no chat, but an intent was recorded. Instead of the
    // generic "may have been idle" line we want the chunk to tell the
    // user what the agent said it was doing.
    mkdirSync(join(tmp, '.metaide'), { recursive: true });
    seedIntent(tmp, [{ agent: 'claude', shell: 0, text: 'waiting for codex icons' }]);
    const { absPath } = generateStoryChunk({ projectPath: tmp, projectName: 'proj', now: fixedNow });
    const html = readFileSync(absPath, 'utf8');
    expect(html).toContain('Nothing was logged in this window');
    // The template escapes HTML entities, so the quote marks become `&quot;` — assert the escaped form.
    expect(html).toContain('&quot;waiting for codex icons&quot;');
    expect(html).toContain('claude in shell 0');
    expect(html).not.toContain('Agents may have been idle');
  });

  it('excludes entries older than the window', () => {
    seedActivity(tmp, [
      { id: 'old', ts: '2026-11-24T13:30:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Edit', target: 'ancient.ts' },
      { id: 'new', ts: '2026-11-24T14:10:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Edit', target: 'recent.ts' },
    ]);
    const { absPath } = generateStoryChunk({
      projectPath: tmp, projectName: 'proj', now: fixedNow, windowMinutes: 15,
    });
    const html = readFileSync(absPath, 'utf8');
    expect(html).toContain('recent.ts');
    expect(html).not.toContain('ancient.ts');
  });

  it('writes a per-shell paragraph when more than one shell has activity', () => {
    seedActivity(tmp, [
      { id: '1', ts: '2026-11-24T14:05:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Edit', target: 'a.ts' },
      { id: '2', ts: '2026-11-24T14:06:00.000Z', agent: 'codex', shellIndex: 1, kind: 'tool', tool: 'Edit', target: 'b.ts' },
    ]);
    const { absPath } = generateStoryChunk({ projectPath: tmp, projectName: 'proj', now: fixedNow });
    const html = readFileSync(absPath, 'utf8');
    expect(html).toContain('Shell #0');
    expect(html).toContain('Shell #1');
  });

  it("uses the latest intent as the chunk's title when present", () => {
    seedActivity(tmp, [
      { id: '1', ts: '2026-11-24T14:05:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Edit', target: 'a.ts' },
    ]);
    seedIntent(tmp, [{ agent: 'claude', shell: 0, text: 'fixing the login redirect bug' }]);
    const { chunk } = generateStoryChunk({ projectPath: tmp, projectName: 'proj', now: fixedNow });
    expect(chunk.title).toBe('Fixing the login redirect bug');
  });

  it('falls back to "Worked on <file>" when there is no intent', () => {
    seedActivity(tmp, [
      { id: '1', ts: '2026-11-24T14:05:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Edit', target: 'src/auth/login.ts' },
    ]);
    const { chunk } = generateStoryChunk({ projectPath: tmp, projectName: 'proj', now: fixedNow });
    expect(chunk.title).toBe('Worked on login.ts');
  });

  it('weaves in chat exchanges with the human', () => {
    seedActivity(tmp, []);
    seedChat(tmp, [
      {
        id: 'c1', ts: '2026-11-24T14:05:00.000Z',
        from: { device: 'dev', shell: 0, agent: 'human' },
        to: [{ agent: 'claude' }],
        body: 'please add dark mode',
      },
    ]);
    const { absPath } = generateStoryChunk({ projectPath: tmp, projectName: 'proj', now: fixedNow });
    const html = readFileSync(absPath, 'utf8');
    expect(html).toContain('You said');
    expect(html).toContain('please add dark mode');
  });

  it('colour-codes chat rows with the "chat" kind in the timeline', () => {
    seedActivity(tmp, []);
    seedChat(tmp, [
      {
        id: 'c1', ts: '2026-11-24T14:05:00.000Z',
        from: { device: 'dev', shell: 0, agent: 'human' },
        to: [{ agent: 'claude' }],
        body: 'hey',
      },
    ]);
    const { absPath } = generateStoryChunk({ projectPath: tmp, projectName: 'proj', now: fixedNow });
    const html = readFileSync(absPath, 'utf8');
    // Chat should route through the --k-chat CSS class, not --k-prompt.
    expect(html).toContain('class="k k-chat"');
    expect(html).not.toContain('class="k k-prompt"');
  });

  it('does not classify a Read of latest.ts as a test run', () => {
    seedActivity(tmp, [
      // path SEGMENT match: "test"/"spec" should not fire on substring matches
      // like latest.ts, inspector.ts, src/inspect.ts.
      { id: '1', ts: '2026-11-24T14:05:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Read', target: 'src/latest.ts' },
      { id: '2', ts: '2026-11-24T14:06:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Read', target: 'src/inspector.ts' },
    ]);
    const { absPath } = generateStoryChunk({ projectPath: tmp, projectName: 'proj', now: fixedNow });
    const html = readFileSync(absPath, 'utf8');
    expect(html).not.toContain('class="k k-test"');
  });

  it('wraps a filesystem write failure in a chunk-aware error', () => {
    // Point the project at a path whose parent is NOT writable — the
    // mkdir+write inside generateStoryChunk should throw with a message
    // that names the chunk location, not a bare errno.
    const bad = join(tmp, 'readonly-root');
    try {
      // Create as a regular file, so mkdir(bad/.metaide/story, recursive) fails.
      writeFileSync(bad, 'blocking');
      seedActivity(bad, []);
    } catch { /* noop — we don't actually seed */ }
    expect(() => generateStoryChunk({ projectPath: bad, projectName: 'proj', now: fixedNow }))
      .toThrow(/could not write story chunk/);
  });
});

describe('listStoryChunks', () => {
  it('returns [] when the project has no story dir yet', () => {
    expect(listStoryChunks(tmp)).toEqual([]);
  });

  it('returns one entry per .html file, newest first', () => {
    seedActivity(tmp, [
      { id: '1', ts: '2026-11-24T14:05:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Edit', target: 'a.ts' },
    ]);
    generateStoryChunk({ projectPath: tmp, projectName: 'proj', now: () => new Date('2026-11-24T14:00:00.000Z') });
    generateStoryChunk({ projectPath: tmp, projectName: 'proj', now: () => new Date('2026-11-24T14:10:00.000Z') });
    const chunks = listStoryChunks(tmp);
    expect(chunks.length).toBe(2);
    // Newest first (mtime ordering).
    expect(new Date(chunks[0]!.ts).getTime()).toBeGreaterThanOrEqual(new Date(chunks[1]!.ts).getTime());
  });

  it('skips files that are not .html', () => {
    const dir = join(tmp, STORY_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.md'), '# not a chunk');
    writeFileSync(join(dir, 'ok.html'), '<!doctype html><html><head><title>t</title></head><body><h1>Ok</h1><div class="subtitle">Bar</div></body></html>');
    const chunks = listStoryChunks(tmp);
    expect(chunks.map((c) => c.file)).toEqual(['ok.html']);
  });
});

describe('readStoryHtml', () => {
  it('returns the file contents when the file exists', () => {
    const dir = join(tmp, STORY_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ok.html'), '<html>ok</html>');
    expect(readStoryHtml(tmp, 'ok.html')).toBe('<html>ok</html>');
  });

  it('returns null when the file does not exist', () => {
    expect(readStoryHtml(tmp, 'missing.html')).toBeNull();
  });

  it('refuses to read a path that tries to break out of the story dir', () => {
    // These should not be resolved — attempting them returns null, never the
    // contents of /etc/passwd.
    expect(readStoryHtml(tmp, '../../../etc/passwd')).toBeNull();
    expect(readStoryHtml(tmp, '..\\..\\windows\\system32\\drivers\\etc\\hosts')).toBeNull();
    expect(readStoryHtml(tmp, 'sub/nested.html')).toBeNull();
  });
});
