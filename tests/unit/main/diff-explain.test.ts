/**
 * The main-side explainDiff() runs one headless Claude CLI turn via the
 * shared runCliTurn plumbing, caches the result per (projectId, kind, hash),
 * and returns markdown. The CLI itself is stubbed — we assert the arg shape
 * and the cache behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type RunCli = typeof import('@main/group-chat/engines/run-cli').runCliTurn;

const run = vi.hoisted(() => ({ turn: null as unknown as ReturnType<RunCli> | null, calls: 0, lastOpts: null as Parameters<RunCli>[0] | null }));

vi.mock('@main/group-chat/engines/run-cli', () => ({
  runCliTurn: (opts: Parameters<RunCli>[0]) => {
    run.calls += 1;
    run.lastOpts = opts;
    return run.turn ?? Promise.resolve({ ok: true, reply: '## Intent\nExample explanation.' });
  },
}));

// The claude CLI resolver can look at disk; stub it.
vi.mock('@main/group-chat/engines/cli', () => ({
  npmCli: () => ['claude'],
}));

beforeEach(() => {
  run.turn = null;
  run.calls = 0;
  run.lastOpts = null;
});

describe('explainDiff', () => {
  it('runs the CLI with the explain prompt on stdin and the project cwd, then returns the reply as text', async () => {
    const mod = await import('@main/diff-explain');
    mod.__resetCacheForTests();
    const r = await mod.explainDiff({
      projectId: 1,
      projectPath: '/tmp/fake-project',
      kind: 'explain',
      diff: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b',
      newPath: 'a.ts',
      oldPath: 'a.ts',
    });
    expect(r).toEqual({ status: 'ok', text: '## Intent\nExample explanation.', cached: false });
    expect(run.calls).toBe(1);
    expect(run.lastOpts?.cwd).toBe('/tmp/fake-project');
    expect(run.lastOpts?.text).toMatch(/Intent/);
    expect(run.lastOpts?.text).toMatch(/```diff/);
  });

  it('caches the result by (projectId, kind, cacheHash) and avoids a second CLI call', async () => {
    const mod = await import('@main/diff-explain');
    mod.__resetCacheForTests();
    const req = {
      projectId: 1,
      projectPath: '/tmp/fake',
      kind: 'explain' as const,
      diff: 'x',
      newPath: 'a.ts',
      oldPath: 'a.ts',
      cacheHash: 'sha-abc',
    };
    const a = await mod.explainDiff(req);
    const b = await mod.explainDiff(req);
    expect(a.status).toBe('ok');
    expect(b).toEqual({ ...a, cached: true });
    expect(run.calls).toBe(1);
  });

  it('a second request with a different hash does not reuse the cached entry', async () => {
    const mod = await import('@main/diff-explain');
    mod.__resetCacheForTests();
    await mod.explainDiff({ projectId: 1, projectPath: '/tmp', kind: 'explain', diff: 'x', newPath: 'a.ts', oldPath: 'a.ts', cacheHash: 'h1' });
    await mod.explainDiff({ projectId: 1, projectPath: '/tmp', kind: 'explain', diff: 'y', newPath: 'a.ts', oldPath: 'a.ts', cacheHash: 'h2' });
    expect(run.calls).toBe(2);
  });

  it('a failed CLI turn becomes an error response (never throws)', async () => {
    run.turn = Promise.resolve({ ok: false, reply: '', error: 'claude: command not found' });
    const mod = await import('@main/diff-explain');
    mod.__resetCacheForTests();
    const r = await mod.explainDiff({ projectId: 1, projectPath: '/tmp', kind: 'explain', diff: 'x', newPath: 'a.ts', oldPath: 'a.ts' });
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.message).toMatch(/claude: command not found/);
  });

  it('kind "commit" sends the commit-message prompt instead', async () => {
    const mod = await import('@main/diff-explain');
    mod.__resetCacheForTests();
    await mod.explainDiff({ projectId: 1, projectPath: '/tmp', kind: 'commit', diff: 'x' });
    expect(run.lastOpts?.text).toMatch(/commit message/i);
    expect(run.lastOpts?.text).not.toMatch(/Flags/);
  });
});
