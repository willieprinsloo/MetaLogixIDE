import { describe, it, expect, vi } from 'vitest';
import type { Services } from '@main/services';

vi.mock('electron', () => ({
  app: { getFileIcon: vi.fn() }, dialog: {}, nativeImage: {}, nativeTheme: {}, shell: {}, BrowserWindow: {},
}));

const { handlers } = await import('@main/ipc/register');

function servicesWith(groupChat: unknown): Services {
  return { groupChat } as unknown as Services;
}

describe('group-chat IPC handlers', () => {
  it('refuse to run before group chats are installed', async () => {
    await expect(handlers['groups:list'](servicesWith(null), { projectId: 1 })).rejects.toThrow(/not ready/);
  });

  it('groups:say refuses empty text without touching the service', async () => {
    const say = vi.fn();
    await expect(handlers['groups:say'](servicesWith({ say }), { id: 'g', text: '   ' })).rejects.toThrow(/empty/);
    expect(say).not.toHaveBeenCalled();
  });

  it('groups:say passes the text through and returns the group', async () => {
    const say = vi.fn(() => ({ id: 'g' }));
    expect(await handlers['groups:say'](servicesWith({ say }), { id: 'g', text: 'hi' })).toEqual({ group: { id: 'g' } });
    expect(say).toHaveBeenCalledWith('g', 'hi');
  });

  it('groups:delete surfaces the refusal for a running group', async () => {
    const remove = vi.fn(() => { throw new Error('Stop the conversation first'); });
    await expect(handlers['groups:delete'](servicesWith({ remove }), { id: 'g' })).rejects.toThrow(/Stop the conversation first/);
  });

  it('groups:add-headless rejects an unknown engine', async () => {
    const addHeadless = vi.fn();
    await expect(handlers['groups:add-headless'](servicesWith({ addHeadless }), { id: 'g', engine: 'grok' as never, name: 'x' })).rejects.toThrow(/engine/);
    expect(addHeadless).not.toHaveBeenCalled();
  });

  it('groups:update clamps through the service and returns the group', async () => {
    const update = vi.fn(() => ({ id: 'g', maxRounds: 10 }));
    expect(await handlers['groups:update'](servicesWith({ update }), { id: 'g', maxRounds: 99 })).toEqual({ group: { id: 'g', maxRounds: 10 } });
  });
});
