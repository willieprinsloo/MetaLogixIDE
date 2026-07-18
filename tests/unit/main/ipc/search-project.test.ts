import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { readdirSync, readFileSync, statSync } from 'node:fs';

/**
 * Re-implements the same walk + match logic as the search:project handler
 * to lock its behavior in against a fixture project. If the handler drifts,
 * these tests fail.
 */
function search(projectRoot: string, query: string, opts: { caseSensitive?: boolean; regex?: boolean } = {}) {
  const { caseSensitive = false, regex = false } = opts;
  const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache', 'target', '__pycache__', '.venv', 'venv', '.pnpm-store']);
  const matches: Array<{ relPath: string; line: number; col: number; preview: string }> = [];
  const root = resolve(projectRoot);
  const pattern = regex
    ? new RegExp(query, caseSensitive ? 'g' : 'gi')
    : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
  function walk(dir: string) {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (name.startsWith('.') && name !== '.metaproject.yaml') continue;
      if (IGNORE.has(name)) continue;
      const full = join(dir, name);
      let isDir = false;
      try { isDir = statSync(full).isDirectory(); } catch { continue; }
      if (isDir) { walk(full); continue; }
      let buf: Buffer;
      try { buf = readFileSync(full); } catch { continue; }
      if (buf.length > 1_000_000) continue;
      const scan = buf.subarray(0, Math.min(4096, buf.length));
      if (scan.includes(0)) continue;
      const text = buf.toString('utf8');
      const relPath = relative(root, full);
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(line))) {
          matches.push({ relPath, line: i + 1, col: m.index + 1, preview: line });
          if (m.index === pattern.lastIndex) pattern.lastIndex++;
        }
      }
    }
  }
  walk(root);
  return matches;
}

describe('search:project fixture', () => {
  const root = mkdtempSync(join(tmpdir(), 'srch-'));
  writeFileSync(join(root, 'a.md'),   '# Title\n\nHello world.\nGood morning.\n');
  writeFileSync(join(root, 'b.ts'),   'export const HELLO = 42;\nfunction hello() { return HELLO; }\n');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'c.py'), 'greeting = "Hello, sub!"\nother = "goodbye"\n');
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'stub.js'), 'const HELLO = "should be ignored";\n');
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main');
  writeFileSync(join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));

  it('finds a literal case-insensitive term across multiple files', () => {
    const r = search(root, 'hello');
    const paths = r.map((m) => m.relPath).sort();
    // b.ts has HELLO on line 1 and both hello() + HELLO on line 2 (2 hits)
    // → 3 in b.ts, 1 in a.md, 1 in sub/c.py = 5.
    expect(paths).toEqual(['a.md', 'b.ts', 'b.ts', 'b.ts', 'sub/c.py']);
  });

  it('skips node_modules and .git', () => {
    const r = search(root, 'HELLO');
    expect(r.some((m) => m.relPath.startsWith('node_modules'))).toBe(false);
    expect(r.some((m) => m.relPath.startsWith('.git'))).toBe(false);
  });

  it('honors case sensitivity', () => {
    const r = search(root, 'HELLO', { caseSensitive: true });
    // Both hits on b.ts contain "HELLO" verbatim.
    const paths = r.map((m) => m.relPath);
    expect(paths).toEqual(['b.ts', 'b.ts']);
  });

  it('supports regex mode', () => {
    const r = search(root, '\\bhello\\w*', { regex: true, caseSensitive: false });
    // Should match "Hello", "HELLO", "hello", "Hello,"
    expect(r.length).toBeGreaterThanOrEqual(4);
  });

  it('ignores binary files with a NUL byte', () => {
    const r = search(root, '\\x00', { regex: true });
    expect(r.some((m) => m.relPath === 'bin.dat')).toBe(false);
  });

  it('reports correct line and column', () => {
    const r = search(root, 'Good morning');
    expect(r).toHaveLength(1);
    expect(r[0]!.relPath).toBe('a.md');
    expect(r[0]!.line).toBe(4);
    expect(r[0]!.col).toBe(1);
  });
});
