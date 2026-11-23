import { expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { registerMetaprojectIpc, type MetaprojectIpcOptions } from '@main/metaproject/ipc-handlers';
import { metaprojectRequests } from '@shared/metaproject-contract';
import { AssignmentOperations } from '@main/metaproject/assignment-operations';
import { isMetaprojectRendererEntry, metaprojectOwner } from '@main/metaproject/owner';

it('cancels only the matching active intent in the same frame; never cancels a replacement', async () => {
  const operations = new AssignmentOperations();
  const frame = {};
  const first = { operationId: '716a3ccf-fc88-43b8-bb9a-664ec6790a48' };
  const second = { operationId: '5c17719b-2322-4ccb-98fc-45b79d0f5af2' };
  let proceed = (): void => { throw new Error('not started'); };
  const pending = operations.run(first, { frame, contextCurrent: () => true }, async owns => {
    await new Promise<void>(resolve => { proceed = resolve; });
    return { ok: true, value: owns() };
  });
  expect(operations.cancel(first, {})).toEqual({ ok: false, reason: 'stale' });
  expect(operations.cancel(first, frame)).toEqual({ ok: true, value: undefined });
  await expect(operations.run(second, { frame, contextCurrent: () => true }, owns => ({ ok: true, value: owns() }))).resolves.toEqual({ ok: true, value: true });
  proceed();
  await expect(pending).resolves.toEqual({ ok: true, value: false });
  expect(operations.cancel(first, frame)).toEqual({ ok: false, reason: 'stale' });
});

it('checks identity, liveness and trusted entry of the actual top-level frame', () => {
  const entry = 'file:///app/index.html';
  const frame = { url: `${entry}#workspace` };
  const sender = { mainFrame: frame, isDestroyed: () => false };
  const window = { webContents: sender, isDestroyed: () => false };
  const event = { sender, senderFrame: frame };
  expect(metaprojectOwner(event, window, entry)).toBe(window);
  expect(metaprojectOwner({ ...event, senderFrame: null }, window, entry)).toBeNull();
  expect(metaprojectOwner({ ...event, senderFrame: { ...frame } }, window, entry)).toBeNull();
  expect(metaprojectOwner({ ...event, sender: { ...sender } }, window, entry)).toBeNull();
  expect(metaprojectOwner(event, { ...window, isDestroyed: () => true }, entry)).toBeNull();
  expect(metaprojectOwner(event, window, 'file:///other/index.html')).toBeNull();
  expect(isMetaprojectRendererEntry('https://example.test/index.html', entry)).toBe(false);
});

function setup() {
  const channels = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>();
  const owner = { id: 1 } as BrowserWindow;
  const trusted = { sender: owner, senderFrame: {} } as unknown as IpcMainInvokeEvent;
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
