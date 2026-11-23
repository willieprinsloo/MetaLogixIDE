import { expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { registerMetaprojectIpc, type MetaprojectIpcOptions } from '@main/metaproject/ipc-handlers';
import { metaprojectRequests } from '@shared/metaproject-contract';

function setup() {
  const channels = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>();
  const owner = { id: 1 } as BrowserWindow;
  const trusted = { sender: owner } as unknown as IpcMainInvokeEvent;
  const keyring = { getPassword: vi.fn(), setPassword: vi.fn(), deletePassword: vi.fn() };
  const ipcMain: Pick<MetaprojectIpcOptions['ipcMain'], 'handle' | 'removeHandler'> = {
    handle(channel, handler) { channels.set(channel, (event, input) => Promise.resolve(handler(event, input))); },
    removeHandler(channel) { channels.delete(channel); },
  };
  const settings = {
    get: vi.fn(key => key === 'metaproject_base_url' ? 'https://example.test' : 'legacy'),
    readMetaprojectPrivate: vi.fn(), writeMetaprojectPrivate: vi.fn(),
  };
  const lifecycle = registerMetaprojectIpc({
    ipcMain, settings, projects: {}, roots: { list: () => [] }, keyring, allowLoopbackHttp: false,
    owner: () => owner, authorize: (event: IpcMainInvokeEvent) => event === trusted ? owner : null,
    send: vi.fn(), openExternal: vi.fn(),
  } as unknown as MetaprojectIpcOptions);
  async function call(channel: string, input?: unknown, event = trusted): Promise<unknown> {
    const handler = channels.get(channel);
    if (!handler) throw new Error(`Missing channel ${channel}`);
    return handler(event, input);
  }
  return { lifecycle, channels, owner, keyring, call };
}

it('registers the frozen session/assignment/Board API, not the legacy password endpoints', async () => {
  const { lifecycle, channels, keyring, call } = setup();
  lifecycle.start(); lifecycle.start();
  expect(keyring.getPassword).not.toHaveBeenCalled();
  expect(Object.keys(metaprojectRequests).filter(channel => !channels.has(channel))).toEqual([]);
  for (const channel of ['login', 'auto-login', 'credentials-load', 'credentials-clear', 'list-projects', 'create-project', 'link-local-project']) {
    expect(channels.has(`metaproject:${channel}`)).toBe(false);
  }
  expect(await call('metaproject:session-status')).toMatchObject({ epoch: 0, phase: 'signed-out' });
  lifecycle.dispose();
  expect(channels.size).toBe(0);
});

it('rejects missing Chat epoch and rejects Board invocations from a different frame owner', async () => {
  const { lifecycle, call } = setup();
  await expect(call('metaproject:list-all-channels', { scope: 'all' })).rejects.toThrow('invalid-input');
  await expect(call('metaproject:list-all-channels', { scope: 'all', epoch: 0 })).rejects.toThrow('signed-out');
  await expect(call('metaproject:board-browser', { projectId: 1, revision: 'e'.repeat(64) }, {} as IpcMainInvokeEvent))
    .resolves.toEqual({ ok: false, reason: 'stale' });
  lifecycle.dispose();
});
