import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatService, type ChatProjectsDep } from '@main/chat/service';
import { readRecentChat } from '@main/chat/log';

interface DepsForTest {
  projects: ChatProjectsDep & { get: Mock };
  deviceId: string;
  broadcast: Mock;
}

const makeDeps = (projectPath: string): DepsForTest => {
  const get: Mock = vi.fn().mockReturnValue({ id: 7, path: projectPath });
  return { projects: { get }, deviceId: 'dev-a', broadcast: vi.fn() };
};

describe('chat service', () => {
  it('append writes the entry and broadcasts chat:changed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-svc-'));
    const deps = makeDeps(dir);
    const svc = createChatService(deps);
    const { entry } = await svc.append({
      projectId: 7,
      from: { shell: 1, agent: 'claude' },
      body: 'hi',
    });
    expect(entry.from.device).toBe('dev-a');
    expect(entry.id).toMatch(/dev-a/);
    expect(entry.ts).toMatch(/^\d{4}-/);
    expect(deps.broadcast).toHaveBeenCalledWith('chat:changed', { projectId: 7, entry });
    expect(readRecentChat(dir, 10)).toEqual([entry]);
  });

  it('list reads back the log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-svc-'));
    const svc = createChatService(makeDeps(dir));
    await svc.append({ projectId: 7, from: { shell: 1, agent: 'claude' }, body: 'one' });
    await svc.append({ projectId: 7, from: { shell: 2, agent: 'codex' }, body: 'two' });
    const { entries } = await svc.list({ projectId: 7, limit: 10 });
    expect(entries.map((e) => e.body)).toEqual(['one', 'two']);
  });

  it('append rejects unknown projectId', async () => {
    const deps = makeDeps('/x');
    deps.projects.get.mockReturnValue(null);
    const svc = createChatService(deps);
    await expect(
      svc.append({ projectId: 99, from: { shell: 1, agent: 'claude' }, body: 'x' }),
    ).rejects.toThrow(/unknown project/);
  });
});
