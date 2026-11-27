import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshFeatures, topScope } from '@main/story/feature-generator';
import type { CommitCandidate } from '@main/story/feature-scanner';
import { KIND_LABEL_FEATURE, KIND_LABEL_MAINTENANCE } from '@shared/story-feature-prompt';
import { readFeatures, readCursor } from '@main/story/feature-store';

function makeCommit(parts: Partial<CommitCandidate> = {}): CommitCandidate {
  return {
    sha: 'a'.repeat(40),
    shortSha: 'aaaaaaa',
    ts: '2026-11-27T13:00:00.000Z',
    prNumber: 26,
    title: 'fix(deps): bump majors',
    body: '',
    files: ['package.json', 'pnpm-lock.yaml'],
    lines: { added: 10, removed: 5 },
    ...parts,
  };
}

describe('topScope', () => {
  it('returns the longest shared folder prefix across changed files', () => {
    expect(topScope(['src/main/a.ts', 'src/main/b.ts'])).toBe('src/main/');
    expect(topScope(['src/main/a.ts', 'src/renderer/b.tsx'])).toBe('src/');
  });
  it('is the empty string when nothing is shared above the repo root', () => {
    expect(topScope(['package.json', 'src/a.ts'])).toBe('');
  });
  it('for a single file, returns the file path (handy for one-file fixes)', () => {
    expect(topScope(['src/foo.ts'])).toBe('src/foo.ts');
  });
});

describe('refreshFeatures', () => {
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'story-feature-gen-'));
  });

  it('writes one entry per new commit, tags maintenance from the trailer, and advances the cursor', async () => {
    // The real scanner returns newest-first; mirror that in the mock
    // so the generator's oldest-first processing lines up with the
    // call order our `ask` mock expects.
    const scan = vi.fn().mockResolvedValue([
      makeCommit({ sha: 'B'.repeat(40), shortSha: 'BBBBBBB', ts: '2026-11-27T10:00:00.000Z', title: 'Merge PR #2' }),
      makeCommit({ sha: 'A'.repeat(40), shortSha: 'AAAAAAA', ts: '2026-11-26T10:00:00.000Z', title: 'Merge PR #1' }),
    ]);
    // Oldest first: AAAAAAA (feature), then BBBBBBB (maintenance).
    const ask = vi.fn()
      .mockResolvedValueOnce(`## What you can now do\nYou can now X.\n${KIND_LABEL_FEATURE}`)
      .mockResolvedValueOnce(`## Maintenance\nCI tweak.\n${KIND_LABEL_MAINTENANCE}`);

    const result = await refreshFeatures({
      projectPath: project,
      projectName: 'demo',
      scan,
      ask,
    });

    expect(result.added).toBe(2);
    expect(result.failed).toBe(0);
    const entries = readFeatures(project);
    expect(entries.map((e) => e.id).sort()).toEqual(['AAAAAAA', 'BBBBBBB']);
    const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
    expect(byId.AAAAAAA?.kind).toBe('feature');
    expect(byId.BBBBBBB?.kind).toBe('maintenance');
    // Generator writes oldest-first, so the cursor ends up on the newest
    // commit (the last one written in this batch).
    expect(readCursor(project)?.lastSha).toBe('B'.repeat(40));
  });

  it('skips commits whose SHA already has an entry on disk (idempotent refresh)', async () => {
    // First refresh writes one entry.
    const askOk = vi.fn().mockResolvedValue(`## X\nY.\n${KIND_LABEL_FEATURE}`);
    await refreshFeatures({
      projectPath: project,
      projectName: 'demo',
      scan: vi.fn().mockResolvedValue([makeCommit({ sha: 'X'.repeat(40), shortSha: 'XXXXXXX' })]),
      ask: askOk,
    });
    // Second refresh sees the same commit again — generator must not re-ask.
    const askSecond = vi.fn();
    const result = await refreshFeatures({
      projectPath: project,
      projectName: 'demo',
      scan: vi.fn().mockResolvedValue([makeCommit({ sha: 'X'.repeat(40), shortSha: 'XXXXXXX' })]),
      ask: askSecond,
    });
    expect(result.added).toBe(0);
    expect(askSecond).not.toHaveBeenCalled();
  });

  it('counts a failed generation as `failed`, keeps processing the rest, and does not write a partial entry', async () => {
    const scan = vi.fn().mockResolvedValue([
      makeCommit({ sha: 'A'.repeat(40), shortSha: 'AAAAAAA' }),
      makeCommit({ sha: 'B'.repeat(40), shortSha: 'BBBBBBB' }),
    ]);
    const ask = vi.fn()
      .mockRejectedValueOnce(new Error('claude timed out'))
      .mockResolvedValueOnce(`## X\nY.\n${KIND_LABEL_FEATURE}`);
    const result = await refreshFeatures({
      projectPath: project,
      projectName: 'demo',
      scan,
      ask,
    });
    expect(result.added).toBe(1);
    expect(result.failed).toBe(1);
    const ids = readFeatures(project).map((e) => e.id);
    // Only one entry on disk — the failed commit never got an entry.
    expect(ids.length).toBe(1);
  });

  it('emits onEntry for each written entry (renderer streaming hook)', async () => {
    const seen: string[] = [];
    await refreshFeatures({
      projectPath: project,
      projectName: 'demo',
      scan: vi.fn().mockResolvedValue([
        makeCommit({ sha: 'A'.repeat(40), shortSha: 'AAAAAAA' }),
        makeCommit({ sha: 'B'.repeat(40), shortSha: 'BBBBBBB' }),
      ]),
      ask: vi.fn().mockResolvedValue(`## X\nY.\n${KIND_LABEL_FEATURE}`),
      onEntry: (e) => { seen.push(e.id); },
    });
    expect(seen).toEqual(['BBBBBBB', 'AAAAAAA']);
  });

  it('honors maxEntries so a long-dormant repo does not fire a hundred Claude calls at once', async () => {
    const commits = Array.from({ length: 20 }, (_, i) =>
      makeCommit({
        sha: String(i).padStart(40, '0'),
        shortSha: String(i).padStart(7, '0'),
        ts: new Date(2026, 10, i + 1).toISOString(),
      }),
    );
    const ask = vi.fn().mockResolvedValue(`## X\nY.\n${KIND_LABEL_FEATURE}`);
    const result = await refreshFeatures({
      projectPath: project,
      projectName: 'demo',
      scan: vi.fn().mockResolvedValue(commits),
      ask,
      maxEntries: 3,
    });
    expect(result.added).toBe(3);
    expect(ask).toHaveBeenCalledTimes(3);
  });
});
