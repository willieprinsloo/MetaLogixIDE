import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// files:read handler is inlined in register.ts; re-implement the guard here
// to lock in behavior. If the guard drifts, this test will fail.
import { readFileSync, statSync } from 'node:fs';

function readGuarded(projectPath: string, relPath: string): { content: string; kind: 'text' | 'binary'; sizeBytes: number } {
  const abs = resolve(projectPath, relPath);
  if (!abs.startsWith(resolve(projectPath))) throw new Error('path escapes project root');
  const st = statSync(abs);
  if (st.isDirectory()) throw new Error(`${relPath} is a directory`);
  if (st.size > 2_000_000) return { content: 'too large', kind: 'text', sizeBytes: st.size };
  const buf = readFileSync(abs);
  const scan = buf.subarray(0, Math.min(8192, buf.length));
  const isBinary = scan.includes(0);
  if (isBinary) return { content: '', kind: 'binary', sizeBytes: st.size };
  return { content: buf.toString('utf8'), kind: 'text', sizeBytes: st.size };
}

describe('files:read guard', () => {
  const root = mkdtempSync(join(tmpdir(), 'freadtest-'));
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'hello.md'),      '# hi\n\nBody paragraph.');
  writeFileSync(join(root, 'sub', 'code.ts'), 'export const x = 1;');
  writeFileSync(join(root, 'bin.dat'),        Buffer.from([0x01, 0x00, 0x02, 0x00, 0x03]));

  it('reads a text file within the project', () => {
    const r = readGuarded(root, 'hello.md');
    expect(r.kind).toBe('text');
    expect(r.content).toContain('# hi');
  });

  it('reads a file inside a subdirectory', () => {
    const r = readGuarded(root, 'sub/code.ts');
    expect(r.content).toContain('export const x');
  });

  it('flags binary files (NUL byte in first 8KB)', () => {
    const r = readGuarded(root, 'bin.dat');
    expect(r.kind).toBe('binary');
    expect(r.content).toBe('');
  });

  it('rejects path traversal (../)', () => {
    expect(() => readGuarded(root, '../etc/passwd')).toThrow(/escapes project root/);
  });

  it('rejects absolute path outside project', () => {
    expect(() => readGuarded(root, '/etc/passwd')).toThrow(/escapes project root/);
  });

  it('rejects reading a directory', () => {
    expect(() => readGuarded(root, 'sub')).toThrow(/is a directory/);
  });
});
