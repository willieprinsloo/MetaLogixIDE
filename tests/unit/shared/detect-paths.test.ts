import { describe, it, expect } from 'vitest';
import { detectPaths } from '@shared/detect-paths';

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
});
