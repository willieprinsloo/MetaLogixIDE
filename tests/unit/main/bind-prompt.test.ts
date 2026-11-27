import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { bindSkipPath, folderNameFor, isBindSkipped, recordBindSkip } from '@main/bind-prompt';

describe('bind-prompt sentinel', () => {
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'bind-prompt-'));
  });

  it('isBindSkipped is false for a fresh project', () => {
    expect(isBindSkipped(project)).toBe(false);
  });

  it('recordBindSkip writes a sentinel beside the other .metaide state', () => {
    recordBindSkip(project);
    expect(existsSync(bindSkipPath(project))).toBe(true);
    expect(isBindSkipped(project)).toBe(true);
    // Sentinel includes a timestamp line, useful when auditing from a shell.
    expect(readFileSync(bindSkipPath(project), 'utf8')).toMatch(/skipped-at: \d{4}-\d{2}-\d{2}T/);
  });

  it('recordBindSkip is idempotent — calling twice is safe and keeps the latest timestamp', () => {
    recordBindSkip(project, () => new Date('2026-11-27T12:00:00Z'));
    expect(readFileSync(bindSkipPath(project), 'utf8')).toContain('2026-11-27');
    recordBindSkip(project, () => new Date('2026-11-28T12:00:00Z'));
    expect(readFileSync(bindSkipPath(project), 'utf8')).toContain('2026-11-28');
  });

  it('recordBindSkip creates .metaide if it is missing', () => {
    expect(existsSync(join(project, '.metaide'))).toBe(false);
    recordBindSkip(project);
    expect(existsSync(join(project, '.metaide'))).toBe(true);
  });

  it('folderNameFor returns the folder basename, or "project" when the path is bare', () => {
    expect(folderNameFor('/tmp/foo/bar')).toBe('bar');
    expect(folderNameFor('/')).toBe('project');
  });
});
