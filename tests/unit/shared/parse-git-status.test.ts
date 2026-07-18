import { describe, it, expect } from 'vitest';
import { parseGitStatus } from '@shared/parse-git-status';

describe('parseGitStatus', () => {
  it('reads branch, ahead, behind from header', () => {
    const out = parseGitStatus('## main...origin/main [ahead 3, behind 1]\n');
    expect(out.branch).toBe('main');
    expect(out.ahead).toBe(3);
    expect(out.behind).toBe(1);
  });

  it('handles branch with no upstream', () => {
    const out = parseGitStatus('## feature/x\n');
    expect(out.branch).toBe('feature/x');
    expect(out.ahead).toBe(0);
    expect(out.behind).toBe(0);
  });

  it('reports null branch on detached HEAD', () => {
    const out = parseGitStatus('## HEAD (no branch)\n');
    expect(out.branch).toBeNull();
  });

  it('parses modified / added / deleted / renamed', () => {
    const raw = [
      '## main',
      ' M src/a.ts',
      'A  src/b.ts',
      ' D old.txt',
      'R  old.md -> new.md',
    ].join('\n');
    const { files } = parseGitStatus(raw);
    expect(files['src/a.ts']).toBe('M');
    expect(files['src/b.ts']).toBe('A');
    expect(files['old.txt']).toBe('D');
    expect(files['new.md']).toBe('R');
    expect(files['old.md']).toBeUndefined(); // rename tracks new path only
  });

  it('parses untracked and ignored', () => {
    const raw = '## main\n?? scratch.md\n!! .env.local\n';
    const { files } = parseGitStatus(raw);
    expect(files['scratch.md']).toBe('?');
    expect(files['.env.local']).toBe('!');
  });

  it('flags conflicts', () => {
    const raw = '## main\nUU src/conflict.ts\nAA src/both-added.ts\n';
    const { files } = parseGitStatus(raw);
    expect(files['src/conflict.ts']).toBe('U');
    expect(files['src/both-added.ts']).toBe('U');
  });

  it('is stable on empty input', () => {
    expect(parseGitStatus('')).toEqual({ branch: null, ahead: 0, behind: 0, files: {} });
  });
});
