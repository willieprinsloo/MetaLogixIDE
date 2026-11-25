/**
 * The prompt the Diff tab's "Explain changes" button sends to the project's Claude CLI.
 * This is pure text assembly; the real LLM call is tested elsewhere. We assert the
 * contract so a prompt tweak can't silently drop the Intent/What-changed/Flags shape
 * that the UI depends on.
 */
import { describe, it, expect } from 'vitest';
import {
  buildExplainDiffPrompt,
  buildCommitMessagePrompt,
  truncateDiffForPrompt,
} from '@shared/diff-explain-prompt';

describe('buildExplainDiffPrompt', () => {
  it('names the file and lists the three sections the UI renders', () => {
    const p = buildExplainDiffPrompt({ newPath: 'src/foo.ts', oldPath: 'src/foo.ts', diff: 'diff --git a/src/foo.ts b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new' });
    expect(p).toMatch(/src\/foo\.ts/);
    expect(p).toMatch(/\bIntent\b/);
    expect(p).toMatch(/\bWhat changed\b/);
    expect(p).toMatch(/\bFlags\b/);
  });

  it('marks the file as a rename when oldPath differs from newPath', () => {
    const p = buildExplainDiffPrompt({ newPath: 'src/new.ts', oldPath: 'src/old.ts', diff: 'x' });
    expect(p).toMatch(/renamed from.*src\/old\.ts/i);
  });

  it('does not mark a non-rename as renamed', () => {
    const p = buildExplainDiffPrompt({ newPath: 'a.ts', oldPath: 'a.ts', diff: 'x' });
    expect(p).not.toMatch(/renamed/i);
  });

  it('pins the output to markdown (so the UI can render it)', () => {
    const p = buildExplainDiffPrompt({ newPath: 'a.ts', oldPath: 'a.ts', diff: 'x' });
    expect(p).toMatch(/markdown/i);
  });

  it('embeds the diff verbatim inside a fenced block', () => {
    const diff = 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b';
    const p = buildExplainDiffPrompt({ newPath: 'a.ts', oldPath: 'a.ts', diff });
    expect(p).toContain('```diff\n' + diff + '\n```');
  });
});

describe('truncateDiffForPrompt', () => {
  it('returns the diff unchanged when under the byte budget', () => {
    expect(truncateDiffForPrompt('hello', 100)).toEqual({ text: 'hello', truncated: false });
  });

  it('truncates at the byte budget and marks the result', () => {
    const big = 'x'.repeat(10_000);
    const r = truncateDiffForPrompt(big, 100);
    expect(r.truncated).toBe(true);
    // 100 bytes for diff + trailing "…[truncated]" marker — keep the content under budget.
    expect(r.text.length).toBeLessThanOrEqual(100 + 32);
    expect(r.text).toMatch(/truncated/i);
  });
});

describe('buildCommitMessagePrompt', () => {
  it('asks for a conventional commit first line and a short body', () => {
    const p = buildCommitMessagePrompt({ diff: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b' });
    expect(p).toMatch(/commit message/i);
    expect(p).toMatch(/first line|subject/i);
  });

  it('embeds the staged diff inside a fenced block', () => {
    const diff = 'diff --git a/x.ts b/x.ts';
    const p = buildCommitMessagePrompt({ diff });
    expect(p).toContain('```diff\n' + diff + '\n```');
  });

  it('tells Claude to lead with what a human would notice (CLAUDE.md writing-style rule)', () => {
    const p = buildCommitMessagePrompt({ diff: 'x' });
    expect(p).toMatch(/human would notice|plain language/i);
  });
});
