import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mutateChat, type ChatRead } from '@main/metaproject/chat-mutations';
import { MetaprojectClient } from '@main/metaproject/client';
import { WebFailure, type WebReply, type WebRequest } from '@main/metaproject/web-session';
import { parseMetaprojectOrigin, remoteProjectId } from '@shared/metaproject-contract';

const socketIo = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: socketIo.connect, NodeWebSocket: vi.fn() }));

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

it.each(['edit', 'delete'] as const)('accepts a scoped REST acknowledgement for a global message on %s', async kind => {
  const response = { success: true, id: 12, message: { id: 12, channel_id: 6, project_id: null } };
  const observed = vi.fn();
  const read: ChatRead = async (path, schema, input) => {
    observed(path, input);
    return schema.parse(response);
  };
  const input = { ...target, messageId: 12 };
  await expect(mutateChat(read, kind === 'edit' ? { ...input, kind, message: 'edited' } : { ...input, kind })).resolves.toEqual({ ok: true });
  expect(observed).toHaveBeenCalledOnce();
  expect(observed).toHaveBeenCalledWith(`${path}/messages/12/`, kind === 'edit' ? { method: 'PATCH', json: { message: 'edited' } } : { method: 'DELETE' });
  await expect(mutateChat(read, { ...target, kind: 'send', message: 'text' })).rejects.toMatchObject({ reason: 'protocol' });
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
    socketIo.connect.mockReturnValue(socket);
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

function jsonReply(body: object): WebReply {
  return { status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify(body)) };
}

function workspaceReply(projectId: number | null = null, channelId = 6): WebReply {
  return jsonReply({ success: true, channels: [{ id: channelId, project_id: projectId, name: 'General', is_private: false }] });
}

function socketPort() {
  const incoming = new EventEmitter();
  const outgoing = new EventEmitter();
  const engine = { readyState: 'open', transport: { writable: true } };
  const sendBuffer: Array<{ data: unknown }> = [];
  const sent = vi.fn();
  const emit = vi.fn((event: string, body: unknown) => {
    outgoing.emit('send', event, body);
    sent(event, body);
  });
  const socket = {
    connected: true, io: { engine }, sendBuffer,
    on: incoming.on.bind(incoming), once: incoming.once.bind(incoming),
    connect: vi.fn(), disconnect: vi.fn(),
    onAnyOutgoing: (listener: (...args: unknown[]) => void) => outgoing.on('send', listener),
    offAnyOutgoing: (listener: (...args: unknown[]) => void) => outgoing.off('send', listener),
    volatile: { emit },
  };
  return { socket, incoming, emit, sent, sendBuffer, engine };
}

function clientPort() {
  const origin = parseMetaprojectOrigin('https://example.test', false);
  if (!origin) throw new Error('invalid fixture');
  const controller = new AbortController();
  const request = vi.fn<WebRequest>();
  const cookies = vi.fn<ConstructorParameters<typeof MetaprojectClient>[0]['jar']['cookies']['get']>()
    .mockResolvedValue([{ name: 'session', value: 'fake', httpOnly: true, sameSite: 'lax' }]);
  const forward = vi.fn();
  const changed = vi.fn();
  const rejected = vi.fn();
  const client = new MetaprojectClient({ origin, signal: controller.signal, userId: 5, request, changed, rejected, forward,
    jar: { getUserAgent: () => 'test', cookies: { get: cookies } },
  });
  const first = socketPort();
  socketIo.connect.mockReturnValue(first.socket);
  return { client, controller, request, cookies, first, forward, changed, rejected };
}

function verify({ incoming }: ReturnType<typeof socketPort>, userId = 5): void {
  incoming.emit('connected', { status: 'success', user_id: userId });
}

it('submits exactly one verified global message, without a project or an acknowledgement', async () => {
  const { client, first, request, controller, cookies } = clientPort();
  try {
    request.mockResolvedValueOnce(workspaceReply());
    client.start();
    await Promise.resolve();
    verify(first);
    await expect(client.sendGlobalMessage({ channelId: 6, message: 'reply', parentMessageId: 9 }, () => true)).resolves.toEqual({ submitted: true });
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/chat/channels/?scope=global', signal: controller.signal }));
    expect(cookies.mock.calls.map(([query]) => query.name)).toEqual(['session']);
    expect(first.sent).toHaveBeenCalledOnce();
    expect(first.sent).toHaveBeenCalledWith('send_channel_message', { channel_id: 6, message: 'reply', parent_message_id: 9 });
    expect(first.sendBuffer).toEqual([]);
  } finally { controller.abort(); }
});

it.each([[4, 6], [null, 7]] as const)('denies an entry for project %s and room %s when it does not establish global membership', async (projectId, channelId) => {
  const { client, first, request, controller } = clientPort();
  try {
    request.mockResolvedValueOnce(workspaceReply(projectId, channelId));
    client.start();
    await Promise.resolve();
    verify(first);
    await expect(client.sendGlobalMessage({ channelId: 6, message: 'keep' }, () => true)).rejects.toMatchObject({ reason: 'denied' });
    expect(request).toHaveBeenCalledOnce();
    expect(first.emit).not.toHaveBeenCalled();
  } finally { controller.abort(); }
});

it('does not submit through an unverified, disconnected, or backpressured socket', async () => {
  const { client, first, request, controller, rejected } = clientPort();
  try {
    const send = () => client.sendGlobalMessage({ channelId: 6, message: 'retain' }, () => true);
    client.start();
    await Promise.resolve();
    verify(first, 8);
    expect(rejected).toHaveBeenCalledOnce();
    await expect(send()).rejects.toMatchObject({ reason: 'network' });
    verify(first);
    first.socket.connected = false;
    await expect(send()).rejects.toMatchObject({ reason: 'network' });
    first.socket.connected = true;
    first.engine.transport.writable = false;
    await expect(send()).rejects.toMatchObject({ reason: 'network' });
    first.engine.transport.writable = true;
    first.engine.readyState = 'closing';
    await expect(send()).rejects.toMatchObject({ reason: 'network' });
    expect(first.emit).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  } finally { controller.abort(); }
});

it.each(['owner', 'session', 'socket'] as const)('fences a membership result after %s changes, with no emission or replay', async lost => {
  vi.useFakeTimers();
  const jitter = vi.spyOn(Math, 'random').mockReturnValue(0);
  const { client, first, request, controller, changed, forward } = clientPort();
  try {
    let finish: (reply: WebReply) => void = () => { throw new Error('membership not requested'); };
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(jsonReply({ success: true, projects: [] }));
    client.start();
    await Promise.resolve();
    verify(first);
    const current = vi.fn(() => true);
    const pending = client.sendGlobalMessage({ channelId: 6, message: 'retain' }, current);
    expect(request).toHaveBeenCalledOnce();
    const next = socketPort();
    if (lost === 'owner') current.mockReturnValue(false);
    if (lost === 'session') controller.abort();
    if (lost === 'socket') {
      socketIo.connect.mockReturnValue(next.socket);
      first.incoming.emit('disconnect');
      expect(changed).toHaveBeenLastCalledWith(false);
      expect(forward).toHaveBeenLastCalledWith('disconnect', undefined);
      await vi.advanceTimersByTimeAsync(2000);
      expect(next.socket.connect).toHaveBeenCalledOnce();
      verify(next);
      expect(changed).toHaveBeenLastCalledWith(true);
    }
    finish(workspaceReply());
    await expect(pending).rejects.toMatchObject({ reason: lost === 'socket' ? 'network' : 'stale' });
    expect(first.emit).not.toHaveBeenCalled();
    expect(next.emit).not.toHaveBeenCalled();
  } finally { controller.abort(); jitter.mockRestore(); vi.useRealTimers(); }
});

it.each(['discard', 'throw', 'buffer'] as const)('does not treat local %s as submission or retain the write for replay', async outcome => {
  const { client, first, request, controller } = clientPort();
  try {
    request.mockResolvedValueOnce(workspaceReply());
    client.start();
    await Promise.resolve();
    verify(first);
    const unrelated = { data: ['join_channel', { channel_id: 7 }] };
    first.sendBuffer.push(unrelated);
    first.emit.mockImplementationOnce((event, body) => {
      if (outcome === 'throw') throw new Error('local transport error');
      if (outcome === 'buffer') first.sendBuffer.push({ data: [event, body] });
    });
    await expect(client.sendGlobalMessage({ channelId: 6, message: 'retain' }, () => true)).rejects.toMatchObject({ reason: 'network' });
    expect(first.emit).toHaveBeenCalledOnce();
    expect(first.emit).toHaveBeenCalledWith('send_channel_message', { channel_id: 6, message: 'retain', parent_message_id: null });
    expect(first.sent).not.toHaveBeenCalled();
    expect(first.sendBuffer).toEqual([unrelated]);
  } finally { controller.abort(); }
});

it('uses only the current CSRF cookie at the matching project mutation path', async () => {
  const { client, request, cookies, controller } = clientPort();
  try {
    cookies.mockResolvedValueOnce([{ name: 'csrf_token', value: 'opaque.test', httpOnly: false, sameSite: 'lax' }]);
    request.mockResolvedValueOnce(jsonReply({ success: true, message: { id: 12, channel_id: 6, project_id: 4 } }));
    await expect(client.mutateChat({ ...target, kind: 'send', message: 'draft' })).resolves.toEqual({ ok: true });
    expect(cookies).toHaveBeenCalledOnce();
    expect(cookies).toHaveBeenCalledWith({ url: `https://example.test${path}/messages/`, name: 'csrf_token' });
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ path: `${path}/messages/`, method: 'POST', csrf: 'opaque.test' }));
    cookies.mockResolvedValueOnce([]);
    await expect(client.mutateChat({ ...target, kind: 'send', message: 'draft' })).rejects.toMatchObject({ reason: 'protocol' });
    expect(request).toHaveBeenCalledOnce();
  } finally { controller.abort(); }
});

it('distinguishes project-ID mismatch and authoritative expiry from an attachment denial', async () => {
  const { client, request, rejected, controller } = clientPort();
  try {
    request.mockResolvedValueOnce(jsonReply({ success: true, project: { id: 5, name: 'other' } }));
    await expect(client.checkProject(remoteProjectId.parse(4))).rejects.toMatchObject({ reason: 'protocol' });
    const body = Buffer.from('attachment');
    request.mockResolvedValueOnce({ status: 200, contentType: 'application/octet-stream', body });
    await expect(client.fetchAttachment(4, 23)).resolves.toBe(body);
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/api/projects/4/chat/attachments/23/download', limit: 25 * 1024 * 1024 }));
    request.mockResolvedValueOnce({ status: 403, contentType: '', body });
    await expect(client.fetchAttachment(4, 23)).rejects.toMatchObject({ reason: 'denied' });
    expect(rejected).not.toHaveBeenCalled();
    request.mockResolvedValueOnce({ status: 302, location: '/auth/login?next=/api/chat/channels/' });
    await expect(client.listAllChannels('global')).rejects.toMatchObject({ reason: 'expired' });
    expect(rejected).toHaveBeenCalledOnce();
  } finally { controller.abort(); }
});
