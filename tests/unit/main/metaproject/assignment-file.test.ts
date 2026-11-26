import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAssignmentFile, commitAssignmentFile } from '@main/metaproject/assignment-file';

it('rejects external edits and symlinks without changing their bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'assignment-unit-'));
  try {
    const dir = join(root, 'project');
    mkdirSync(dir);
    const path = join(dir, '.metaproject.yaml');
    writeFileSync(path, 'project_id: 4\n');
    const loaded = readAssignmentFile(root, dir);
    if (!loaded.ok) throw new Error('could not read fixture');
    writeFileSync(path, 'project_id: 51\n');
    expect(commitAssignmentFile(loaded.value, null, () => true)).toEqual({ ok: false, reason: 'conflict' });
    expect(readFileSync(path, 'utf8')).toBe('project_id: 51\n');
    rmSync(path);
    const elsewhere = join(root, 'elsewhere');
    writeFileSync(elsewhere, 'project_id: 99\n');
    symlinkSync(elsewhere, path);
    expect(readAssignmentFile(root, dir)).toEqual({ ok: false, reason: 'invalid-file' });
  } finally { rmSync(root, { force: true, recursive: true }); }
});

it('never changes bytes for unreadable unrelated YAML', () => {
  const root = mkdtempSync(join(tmpdir(), 'assignment-unit-'));
  try {
    const path = join(root, '.metaproject.yaml');
    const original = 'project_id: 4\nother: [unclosed\n';
    writeFileSync(path, original);
    expect(readAssignmentFile(root, root)).toEqual({ ok: false, reason: 'invalid-file' });
    expect(readFileSync(path, 'utf8')).toBe(original);
  } finally { rmSync(root, { force: true, recursive: true }); }
});
