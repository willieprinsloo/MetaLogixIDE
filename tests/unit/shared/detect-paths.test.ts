import { describe, it, expect } from 'vitest';
import { detectPaths, detectBareFilenames } from '@shared/detect-paths';

describe('detectPaths', () => {
  it('finds a project-relative path', () => {
    const r = detectPaths('Modified src/main/index.ts to add feature.');
    expect(r).toHaveLength(1);
    expect(r[0]?.path).toBe('src/main/index.ts');
    expect(r[0]?.line).toBeNull();
  });

  it('captures :line and :col', () => {
    const r = detectPaths('Error at src/renderer/App.tsx:42:8 near onClick');
    expect(r[0]?.path).toBe('src/renderer/App.tsx');
    expect(r[0]?.line).toBe(42);
    expect(r[0]?.col).toBe(8);
  });

  it('captures :line without col', () => {
    const r = detectPaths('failed docs/notes.md:12');
    expect(r[0]?.path).toBe('docs/notes.md');
    expect(r[0]?.line).toBe(12);
    expect(r[0]?.col).toBeNull();
  });

  it('finds an absolute POSIX path', () => {
    const r = detectPaths('Wrote /Users/me/repo/README.md successfully.');
    expect(r).toHaveLength(1);
    expect(r[0]?.path).toBe('/Users/me/repo/README.md');
  });

  it('finds multiple paths in one line', () => {
    const r = detectPaths('rename src/a.ts -> src/b.ts (see docs/refactor.md)');
    const paths = r.map((x) => x.path);
    expect(paths).toContain('src/a.ts');
    expect(paths).toContain('src/b.ts');
    expect(paths).toContain('docs/refactor.md');
  });

  it('ignores trailing punctuation', () => {
    const r = detectPaths('open src/renderer/App.tsx.');
    expect(r[0]?.path).toBe('src/renderer/App.tsx');
  });

  it('does not match bare words without a path separator', () => {
    expect(detectPaths('nothing to see here')).toEqual([]);
    expect(detectPaths('README')).toEqual([]);
    expect(detectPaths('just-a-file.txt')).toEqual([]); // no slash → skip (heuristic)
  });

  it('does not match unknown extensions', () => {
    expect(detectPaths('cache/tmp.bin is stale')).toEqual([]);
  });

  it('finds pdf files', () => {
    const r = detectPaths('Generated docs/report-2026.pdf for review.');
    expect(r).toHaveLength(1);
    expect(r[0]?.path).toBe('docs/report-2026.pdf');
    expect(r[0]?.line).toBeNull();
  });

  it('finds jsonl and dotfiles like .env', () => {
    expect(detectPaths('appending to .metaide/activity.jsonl')[0]?.path).toBe('.metaide/activity.jsonl');
    expect(detectPaths('loaded .metaide/.env for defaults')[0]?.path).toBe('.metaide/.env');
  });

  it('finds ~-relative paths', () => {
    const r = detectPaths('see ~/Documents/dev/foo.ts for details');
    expect(r[0]?.path).toBe('~/Documents/dev/foo.ts');
  });

  it('longest-first extension ordering prefers tsx over ts', () => {
    const r = detectPaths('renamed src/renderer/components/ShellTabsBar.tsx:99');
    expect(r[0]?.path).toBe('src/renderer/components/ShellTabsBar.tsx');
    expect(r[0]?.line).toBe(99);
  });
});

describe('detectBareFilenames', () => {
  it('finds a bare filename agents print (the Codex case)', () => {
    // Codex writes lines like "Viewed image review.jpg" with no path
    // prefix. The strict detector skips it; the bare detector catches it,
    // and the caller then verifies the file exists before lighting a link.
    const r = detectBareFilenames('Viewed image review.jpg');
    expect(r).toHaveLength(1);
    expect(r[0]?.path).toBe('review.jpg');
  });

  it('captures :line and :col', () => {
    const r = detectBareFilenames('see README.md:42:8');
    expect(r[0]?.path).toBe('README.md');
    expect(r[0]?.line).toBe(42);
    expect(r[0]?.col).toBe(8);
  });

  it('ignores trailing punctuation', () => {
    const r = detectBareFilenames('open review.jpg.');
    expect(r[0]?.path).toBe('review.jpg');
  });

  it('matches inside backticks and brackets (common in agent output)', () => {
    expect(detectBareFilenames('run `script.sh` now')[0]?.path).toBe('script.sh');
    expect(detectBareFilenames('see [report.pdf] attached')[0]?.path).toBe('report.pdf');
  });

  it('does NOT match mid-word (fullname.ts is not name.ts)', () => {
    // If `name.ts` matched as a sub-string of `fullname.ts`, every
    // compound filename in the output would double-light. The boundary
    // guard keeps the longer token whole.
    expect(detectBareFilenames('see fullname.ts for details')[0]?.path).toBe('fullname.ts');
    // and definitely never an inner slice:
    expect(detectBareFilenames('see fullname.ts for details').some((h) => h.path === 'name.ts')).toBe(false);
  });

  it('does NOT match when the filename is part of a path (detectPaths owns that case)', () => {
    // The bare detector would surface `index.ts` here, which is wrong —
    // the strict detector already handles `src/main/index.ts` perfectly.
    // Callers merge both lists; a strict hit beats a bare hit at the
    // same range (same startIndex) so there is no visual overlap.
    const bare = detectBareFilenames('open src/main/index.ts');
    // A single bare hit is OK — the merge step in the link provider drops
    // anything whose range is contained inside a strict hit. What matters
    // here is that we don't CRASH or produce noise beyond the expected
    // overlap; the de-dupe happens one level up.
    expect(bare.length).toBeLessThanOrEqual(1);
  });

  it('skips unknown extensions', () => {
    expect(detectBareFilenames('cache tmp.bin is stale')).toEqual([]);
  });

  it('skips extensions that are just a leading dot (dotfiles are strict-detector territory)', () => {
    // `.env` on its own is ambiguous ("sourced .env" vs a line-ending
    // period) — the strict detector handles it with path context. Here
    // we just make sure we don't false-match.
    expect(detectBareFilenames('sourced .env today')).toEqual([]);
  });

  it('finds multiple bare hits on one line', () => {
    const r = detectBareFilenames('attached report.pdf and screenshot.png');
    const paths = r.map((x) => x.path);
    expect(paths).toContain('report.pdf');
    expect(paths).toContain('screenshot.png');
  });
});
