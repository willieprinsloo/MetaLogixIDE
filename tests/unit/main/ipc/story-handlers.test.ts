/**
 * Story IPC handler contract — the handlers are a thin wrapper over the
 * narrator module, so the tests here focus on the edges that only the
 * IPC layer owns: project lookup, list/read/generate shapes, and the
 * generate→broadcast behavior that drives the live refresh in other
 * open renderers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handlers } from '@main/ipc/register';
import type { Services } from '@main/services';
import type { ActivityEntry } from '@shared/activity';

// The handlers call BrowserWindow.getAllWindows() when a generate succeeds.
// Keep track of what got broadcast so the test can assert on it.
const sentMessages: Array<{ channel: string; payload: unknown }> = [];
vi.mock('electron', () => {
  const win = { webContents: { send: (channel: string, payload: unknown) => { sentMessages.push({ channel, payload }); } } };
  return {
    BrowserWindow: { getAllWindows: () => [win] },
    // The handler module also imports these at module load — provide inert stubs.
    app: { getPath: () => tmpdir(), on: () => {}, whenReady: () => Promise.resolve(), isReady: () => true },
    dialog: {},
    nativeImage: {},
    nativeTheme: {},
    shell: {},
  };
});

function makeServices(projectId: number, projectPath: string): Services {
  return {
    projects: {
      get: (id: number) => (id === projectId ? { id, path: projectPath, name: 'proj' } : null),
    },
  } as unknown as Services;
}

function seedActivity(projectPath: string, entries: ActivityEntry[]): void {
  const dir = join(projectPath, '.metaide');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'activity.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''),
    'utf8',
  );
}

let tmp = '';
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'story-ipc-')); sentMessages.length = 0; });
afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe('story:generate', () => {
  it('writes a chunk and broadcasts story:changed', async () => {
    seedActivity(tmp, [
      { id: '1', ts: new Date().toISOString(), agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Edit', target: 'foo.ts' },
    ]);
    const svc = makeServices(42, tmp);
    const { chunk } = await handlers['story:generate'](svc, { projectId: 42, windowMinutes: 15 });
    expect(chunk.file).toMatch(/\.html$/);
    expect(existsSync(join(tmp, '.metaide/story', chunk.file))).toBe(true);
    expect(sentMessages).toEqual([{ channel: 'story:changed', payload: { projectId: 42 } }]);
  });

  it('rejects an unknown project', async () => {
    const svc = makeServices(42, tmp);
    await expect(
      handlers['story:generate'](svc, { projectId: 99, windowMinutes: 15 }),
    ).rejects.toThrow(/no project/);
  });
});

describe('story:list', () => {
  it('returns [] before any chunk has been written', async () => {
    const svc = makeServices(42, tmp);
    const { chunks } = await handlers['story:list'](svc, { projectId: 42 });
    expect(chunks).toEqual([]);
  });

  it('returns the chunks generate just wrote', async () => {
    const svc = makeServices(42, tmp);
    seedActivity(tmp, [
      { id: '1', ts: new Date().toISOString(), agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Edit', target: 'foo.ts' },
    ]);
    await handlers['story:generate'](svc, { projectId: 42, windowMinutes: 15 });
    const { chunks } = await handlers['story:list'](svc, { projectId: 42 });
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.file).toMatch(/\.html$/);
    expect(chunks[0]!.title).toBeTruthy();
  });

  it('rejects an unknown project', async () => {
    const svc = makeServices(42, tmp);
    await expect(handlers['story:list'](svc, { projectId: 99 })).rejects.toThrow(/no project/);
  });
});

describe('story:read', () => {
  it('returns the chunk HTML for a known file', async () => {
    const svc = makeServices(42, tmp);
    seedActivity(tmp, [
      { id: '1', ts: new Date().toISOString(), agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Edit', target: 'foo.ts' },
    ]);
    const { chunk } = await handlers['story:generate'](svc, { projectId: 42, windowMinutes: 15 });
    const { html } = await handlers['story:read'](svc, { projectId: 42, file: chunk.file });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<h1>');
  });

  it('returns html: null for a filename that does not exist', async () => {
    const svc = makeServices(42, tmp);
    const { html } = await handlers['story:read'](svc, { projectId: 42, file: 'nope.html' });
    expect(html).toBeNull();
  });

  it('returns html: null for a path-traversal attempt', async () => {
    const svc = makeServices(42, tmp);
    const { html } = await handlers['story:read'](svc, { projectId: 42, file: '../../../etc/passwd' });
    expect(html).toBeNull();
  });

  it('rejects an unknown project', async () => {
    const svc = makeServices(42, tmp);
    await expect(handlers['story:read'](svc, { projectId: 99, file: 'x.html' })).rejects.toThrow(/no project/);
  });
});
