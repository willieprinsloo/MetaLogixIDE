import { describe, expect, it } from 'vitest';
import { parsePrNumber, scanCommits } from '@main/story/feature-scanner';

describe('parsePrNumber', () => {
  it('reads the PR number out of a standard merge commit subject', () => {
    expect(parsePrNumber('Merge pull request #26 from doubleeye/fix')).toBe(26);
  });
  it('returns null for direct commits that happen to mention a number', () => {
    expect(parsePrNumber('fix(auth): close #42 by retrying once')).toBeNull();
  });
});

describe('scanCommits', () => {
  // The scanner shells out to git. We inject `run()` so the tests stay
  // hermetic — no fixture repo, just the exact stdout git would print
  // for the given args.
  const commit = (parts: { sha: string; shortSha: string; ts: string; subject: string; body?: string }) =>
    `${parts.sha}\x1f${parts.shortSha}\x1f${parts.ts}\x1f${parts.subject}\x1f${parts.body ?? ''}\x1e`;

  it('keeps merges, keeps feat:/fix: direct commits, drops chore/refactor', async () => {
    const log = [
      commit({ sha: 'a'.repeat(40), shortSha: 'aaaaaaa', ts: '2026-11-27T13:00:00+00:00', subject: 'Merge pull request #26 from willie/fix' }),
      commit({ sha: 'b'.repeat(40), shortSha: 'bbbbbbb', ts: '2026-11-26T10:00:00+00:00', subject: 'feat: add export button' }),
      commit({ sha: 'c'.repeat(40), shortSha: 'ccccccc', ts: '2026-11-25T09:00:00+00:00', subject: 'chore: bump prettier' }),
      commit({ sha: 'd'.repeat(40), shortSha: 'ddddddd', ts: '2026-11-24T08:00:00+00:00', subject: 'fix(auth): reject empty cookie' }),
    ].join('');
    const numstat = '12\t3\tsrc/foo.ts\n4\t0\tsrc/bar.ts\n';
    const run = async (args: string[]) => (args[0] === 'log' ? log : numstat);
    const out = await scanCommits({ cwd: '/tmp/fake', run });
    const subjects = out.map((c) => c.title);
    expect(subjects).toEqual([
      'Merge pull request #26 from willie/fix',
      'feat: add export button',
      'fix(auth): reject empty cookie',
    ]);
    expect(out[0]?.prNumber).toBe(26);
    expect(out[1]?.prNumber).toBeNull();
    // numstat parsed into both the file list and the totals.
    expect(out[0]?.files).toEqual(['src/bar.ts', 'src/foo.ts']);
    expect(out[0]?.lines).toEqual({ added: 16, removed: 3 });
  });

  it('returns an empty list when git itself fails — never throws up the IPC stack', async () => {
    const run = async () => { throw new Error('not a git repo'); };
    const out = await scanCommits({ cwd: '/tmp/fake', run });
    expect(out).toEqual([]);
  });

  it('passes the since-SHA range only when sinceSha is given', async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => { calls.push(args); return ''; };
    await scanCommits({ cwd: '/tmp/fake', run, sinceSha: 'abc123' });
    expect(calls[0]).toContain('abc123..HEAD');

    calls.length = 0;
    await scanCommits({ cwd: '/tmp/fake', run });
    const hasRange = calls[0]!.some((a) => a.includes('..'));
    expect(hasRange).toBe(false);
  });
});
