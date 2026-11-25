/**
 * Real end-to-end test for the AI story narrator.
 *
 * Unlike the unit tests (which stub `runCliTurn`), this one spawns the
 * actual `claude` CLI against this very repo's `.metaide/` logs, writes
 * a chunk to a tmp dir, and prints the prose so a human reviewer can
 * see what the user will see.
 *
 * Skipped unless `STORY_AI_REAL=1` is in the environment — the test
 * costs a Claude call and only makes sense when Claude is on PATH.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { generateStoryChunkAI } from '@main/story/ai-narrator';

const ENABLED = process.env.STORY_AI_REAL === '1';
const d = ENABLED ? describe : describe.skip;

const METAIDE_PATH = resolve(__dirname, '..', '..');

let tmp = '';
beforeAll(() => {
  if (!ENABLED) return;
  // Confirm Claude is on PATH — otherwise the real call just fails fast
  // and the test is meaningless.
  try {
    execFileSync('claude', ['--version'], { stdio: 'pipe' });
  } catch (err) {
    throw new Error('STORY_AI_REAL=1 but `claude` is not on PATH: ' + String(err));
  }
  tmp = mkdtempSync(join(tmpdir(), 'story-real-'));
  // Copy the real .metaide/ logs into the tmp project so the narrator
  // finds something to narrate. Safer than pointing it at the live dir
  // (it writes chunks into `.metaide/story/`).
  const src = join(METAIDE_PATH, '.metaide');
  const dst = join(tmp, '.metaide');
  mkdirSync(dst, { recursive: true });
  for (const name of ['activity.jsonl', 'chat.jsonl', 'intent-outbox.jsonl']) {
    const from = join(src, name);
    if (existsSync(from)) cpSync(from, join(dst, name));
  }
});

afterAll(() => {
  if (!ENABLED) return;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

d('story AI narrator — real CLI', () => {
  it('writes a chunk with real Claude-written prose', async () => {
    const { chunk, absPath } = await generateStoryChunkAI({
      projectPath: tmp,
      projectName: 'metaIDE',
      // Big window so we are sure something gets picked up.
      windowMinutes: 120,
    });

    expect(existsSync(absPath)).toBe(true);
    const html = readFileSync(absPath, 'utf8');
    // The HTML must contain prose paragraphs — not the generic template
    // "Nothing was logged" fallback.
    expect(html).not.toContain('Nothing was logged in this window');
    expect(html).toMatch(/<p>[^<]+<\/p>/);
    // Print the chunk so a human reviewer can judge the prose quality.
    console.log('\n[story-ai-real] title  :', chunk.title);
    console.log('[story-ai-real] subtitle:', chunk.blurb);
    console.log('[story-ai-real] file    :', absPath);
    const paragraphs = Array.from(html.matchAll(/<p>([^<]+)<\/p>/g)).map((m) => m[1]);
    for (const p of paragraphs) {
      console.log('[story-ai-real] ¶', p);
    }
  }, 120_000);
});
