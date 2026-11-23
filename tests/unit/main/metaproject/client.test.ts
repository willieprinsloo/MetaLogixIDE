import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { io } from 'socket.io-client';
import { mutateChat, type ChatRead } from '@main/metaproject/chat-mutations';
import { MetaprojectClient } from '@main/metaproject/client';
import { WebFailure } from '@main/metaproject/web-session';
import { parseMetaprojectOrigin } from '@shared/metaproject-contract';

vi.mock('socket.io-client', () => ({ io: vi.fn(), NodeWebSocket: vi.fn() }));

const target = { projectId: 4, channelId: 6 };
const path = '/api/projects/4/chat/channels/6';

it('sends one scoped request and waits for a message in the matching channel', async () => {
  const response = { success: true, message: { id: 12, channel_id: 6, project_id: 4 } };
  const received = vi.fn();
  const read: ChatRead = async (path, schema, input) => { received(path, schema, input); return schema.parse(response); };
  await expect(mutateChat(read, { ...target, kind: 'send', message: 'draft', parentMessageId: 9 })).resolves.toEqual({ ok: true });
  expect(received).toHaveBeenCalledOnce();
  expect(received).toHaveBeenCalledWith(`${path}/messages/`, expect.anything(), { method: 'POST', json: { message: 'draft', parent_message_id: 9 } });
  await expect(mutateChat(read, { ...target, kind: 'edit', message: 'edited', messageId: 13 })).rejects.toMatchObject({ reason: 'protocol' });
});

it('waits for verified room acknowledgement across backpressure and rejects missing confirmation', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  try {
    const origin = parseMetaprojectOrigin('https://example.test', false);
    if (!origin) throw new Error('invalid fixture');
    const incoming = new EventEmitter();
    const socket = Object.assign(incoming, {
      connected: true,
      connect: vi.fn(), disconnect: vi.fn(),
      emit: vi.fn(),
    });
    vi.mocked(io).mockImplementation(() => socket as never);
    const forward = vi.fn();
    const request = vi.fn();
    const client = new MetaprojectClient({ origin, signal: controller.signal, userId: 5, request,
      changed: vi.fn(), rejected: vi.fn(), forward,
      jar: { getUserAgent: () => 'test', cookies: { get: async () => [{ name: 'session', value: 'fake', httpOnly: true, sameSite: 'lax' }] } },
    });
    client.start();
    await Promise.resolve();
    await expect(client.joinChannel(6)).rejects.toMatchObject({ reason: 'network' });
    EventEmitter.prototype.emit.call(incoming, 'connected', { status: 'success', user_id: 5 });
    expect(forward).toHaveBeenCalledWith('connect', undefined);
    const joined = client.joinChannel(6);
    const unconfirmed = client.joinChannel(7);
    const failure = expect(unconfirmed).rejects.toMatchObject({ reason: 'network' });
    expect(socket.emit.mock.calls).toEqual([['join_channel', { channel_id: 6 }], ['join_channel', { channel_id: 7 }]]);
    EventEmitter.prototype.emit.call(incoming, 'channel_joined', { channel_id: 6 });
    await expect(joined).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(5000);
    await failure;
    expect(socket.emit).toHaveBeenCalledTimes(2);
    expect(request).not.toHaveBeenCalled();
  } finally { controller.abort(); vi.useRealTimers(); }
});

it.each(['denied', 'network'] as const)('surfaces %s without replay', async reason => {
  const read = vi.fn(async () => { throw new WebFailure(reason); });
  await expect(mutateChat(read, { ...target, kind: 'delete', messageId: 12 })).rejects.toMatchObject({ reason });
  expect(read).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledWith(`${path}/messages/12/`, expect.anything(), { method: 'DELETE' });
});
