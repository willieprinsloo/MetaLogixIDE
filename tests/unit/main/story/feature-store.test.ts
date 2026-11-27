import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  existingShas,
  featureDir,
  newestEntryMtime,
  readCursor,
  readFeature,
  readFeatures,
  writeCursor,
  writeFeature,
} from '@main/story/feature-store';
import type { StoryFeature } from '@shared/story-feature';

function makeEntry(overrides: Partial<StoryFeature> = {}): StoryFeature {
  return {
    id: 'aaaaaaa',
    sha: 'a'.repeat(40),
    ts: '2026-11-27T13:00:00.000Z',
    prNumber: 26,
    title: 'fix(deps): bump majors',
    scope: 'src/main/',
    body: '## What you can now do\nYou can now install cleanly.',
    kind: 'feature',
    edited: false,
    ...overrides,
  };
}

describe('feature-store', () => {
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'story-feature-'));
  });

  it('writeFeature then readFeature roundtrips the entry by id', () => {
    const entry = makeEntry();
    writeFeature(project, entry);
    const got = readFeature(project, entry.id);
    expect(got).toEqual(entry);
  });

  it('readFeatures returns entries newest-first', () => {
    writeFeature(project, makeEntry({ id: 'aaaaaaa', ts: '2026-11-20T10:00:00.000Z' }));
    writeFeature(project, makeEntry({ id: 'bbbbbbb', sha: 'b'.repeat(40), ts: '2026-11-27T10:00:00.000Z' }));
    writeFeature(project, makeEntry({ id: 'ccccccc', sha: 'c'.repeat(40), ts: '2026-11-15T10:00:00.000Z' }));
    const ids = readFeatures(project).map((f) => f.id);
    expect(ids).toEqual(['bbbbbbb', 'aaaaaaa', 'ccccccc']);
  });

  it('readFeatures skips a corrupted JSON file without crashing', () => {
    writeFeature(project, makeEntry({ id: 'good---' }));
    writeFileSync(join(featureDir(project), 'broken.json'), '{not json');
    expect(() => readFeatures(project)).not.toThrow();
    const ids = readFeatures(project).map((f) => f.id);
    expect(ids).toEqual(['good---']);
  });

  it('existingShas lists every SHA already covered on disk', () => {
    writeFeature(project, makeEntry({ id: 'a1', sha: 'A'.repeat(40) }));
    writeFeature(project, makeEntry({ id: 'b2', sha: 'B'.repeat(40) }));
    expect(existingShas(project)).toEqual(new Set(['A'.repeat(40), 'B'.repeat(40)]));
  });

  it('writeCursor + readCursor roundtrip; missing cursor returns null', () => {
    expect(readCursor(project)).toBeNull();
    writeCursor(project, 'z'.repeat(40));
    expect(readCursor(project)?.lastSha).toBe('z'.repeat(40));
  });

  it('newestEntryMtime returns ISO timestamp for the newest file, or null on empty', () => {
    expect(newestEntryMtime(project)).toBeNull();
    writeFeature(project, makeEntry({ id: 'a' }));
    const got = newestEntryMtime(project);
    expect(got).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('writeFeature overwrites an existing entry at the same id without leaving a `.tmp`', () => {
    const first = makeEntry({ title: 'original' });
    writeFeature(project, first);
    const second = makeEntry({ title: 'edited', edited: true });
    writeFeature(project, second);
    expect(readFeature(project, first.id)?.title).toBe('edited');
    expect(readFeature(project, first.id)?.edited).toBe(true);
  });
});
