// @vitest-environment jsdom
/** File-tool activity targeting: which Activity entries count as file targets, and peek resolution. */
import { describe, expect, it, vi } from 'vitest';
import type { ActivityEntry } from '@shared/activity';

const peek = vi.hoisted(() => ({
  found: true,
  relPath: 'src/a.ts',
  projectId: 7,
  failing: false,
  calls: [] as Array<{ projectId: number; relPath: string; maxLines: number }>,
}));

vi.mock('@renderer/api', () => ({
  api: {
    invoke: async (channel: string, payload: { projectId: number; relPath: string; maxLines?: number }) => {
      if (channel !== 'files:peek') throw new Error(`unexpected channel ${channel}`);
      if (peek.failing) throw new Error(`no project ${payload.projectId}`);
      peek.calls.push({ projectId: payload.projectId, relPath: payload.relPath, maxLines: payload.maxLines ?? 0 });
      return { found: peek.found, relPath: peek.relPath, projectId: peek.projectId, kind: 'text', head: '', sizeBytes: 0, totalLines: null };
    },
  },
}));

import { FILE_TOOLS, isFileToolActivity, resolveFileTarget } from '@renderer/agent-file-targets';

const toolEntry = (tool: string, target: string | null, ok: boolean | true = true): ActivityEntry => ({
  id: 'x', ts: '2026-11-14T00:00:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool',
  ...(ok === true ? {} : { ok: ok as boolean }),
  tool, ...(target != null ? { target } : {}),
});

describe('isFileToolActivity', () => {
  it('is true for Edit with a target', () => {
    expect(isFileToolActivity(toolEntry('Edit', '/work/1/src/a.ts'))).toBe(true);
  });
  it('is false for Bash', () => {
    expect(isFileToolActivity(toolEntry('Bash', 'git status'))).toBe(false);
  });
  it('is false for a tool entry without a target', () => {
    expect(isFileToolActivity(toolEntry('Edit', null))).toBe(false);
  });
  it('is false for prompt entries', () => {
    expect(isFileToolActivity({ id: 'x', ts: '2026-11-14T00:00:00.000Z', agent: 'claude', shellIndex: 0, kind: 'prompt', target: 'src/a.ts' })).toBe(false);
  });
  it('covers every file tool', () => {
    expect([...FILE_TOOLS]).toEqual(expect.arrayContaining(['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit']));
  });
});

describe('resolveFileTarget', () => {
  it('resolves a found peek in the same project', async () => {
    peek.calls.length = 0;
    const hit = await resolveFileTarget(7, '/work/1/src/a.ts');
    expect(hit).toEqual({ relPath: 'src/a.ts', projectId: 7 });
    expect(peek.calls[0]).toEqual({ projectId: 7, relPath: '/work/1/src/a.ts', maxLines: 1 });
  });
  it('returns null when the file is not found', async () => {
    peek.found = false;
    try {
      expect(await resolveFileTarget(7, 'nope.ts')).toBeNull();
    } finally { peek.found = true; }
  });
  it('returns null when the file belongs to another project', async () => {
    peek.projectId = 9;
    try {
      expect(await resolveFileTarget(7, '/work/9/src/a.ts')).toBeNull();
    } finally { peek.projectId = 7; }
  });

  it('returns null instead of rejecting when the peek IPC throws (project vanished mid-flight)', async () => {
    peek.failing = true;
    try {
      await expect(resolveFileTarget(7, '/gone/a.ts')).resolves.toBeNull();
    } finally { peek.failing = false; }
  });
});
