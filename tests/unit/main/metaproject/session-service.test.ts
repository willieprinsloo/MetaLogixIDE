import { expect, it, vi } from 'vitest';
import { SessionService, type SessionTransport } from '@main/metaproject/session-service';
import { metaprojectActor, parseMetaprojectOrigin } from '@shared/metaproject-contract';
import { MetaprojectClient } from '@main/metaproject/client';
import { RememberedAccount } from '@main/metaproject/remembered-account';
import { encodeStoredSecret } from '@main/credential-encoding';

it('does not infer remembered from the old same-account pointer after successful secure deletion', async () => {
  const actor = metaprojectActor.parse({ id: 3, username: 'example' });
  const origin = 'https://example.test';
  const grant = { grantId: 'a7e66190-1d27-4e5c-80c0-c13080a3a9be', origin, actorId: actor.id };
  const keyring = { getPassword: vi.fn(), setPassword: vi.fn(), deletePassword: vi.fn(async () => true) };
  const account = new RememberedAccount({ read: () => grant, legacyUsername: () => '', write: () => { throw new Error('DB unavailable'); } }, keyring, false);
  const client = Object.create(MetaprojectClient.prototype) as MetaprojectClient;
  client.start = vi.fn();
  const transport: SessionTransport = { authenticate: async () => ({ ok: true, value: actor }), client: () => client, retire: vi.fn(async () => {}) };
  const service = new SessionService({ configuredOrigin: origin, allowLoopback: false, account, transport: () => transport, publish: vi.fn(), chat: vi.fn() });
  const result = await service.login({ epoch: 0, attemptId: 'intent', username: 'example', password: 'example', remember: false });
  expect(result).toMatchObject({ ok: true, value: { phase: 'signed-in', remembered: false } });
  expect(keyring.deletePassword).toHaveBeenCalledWith('metaIDE.metaproject.web.v1', grant.grantId);
  expect(keyring.setPassword).not.toHaveBeenCalled();
});

it('gives a retry after a stalled restore and ignores a late secure record', async () => {
  vi.useFakeTimers();
  try {
    const origin = 'https://example.test';
    const grant = { grantId: 'a7e66190-1d27-4e5c-80c0-c13080a3a9be', origin, actorId: 3 };
    let finish: (stored: string | null) => void = () => { throw new Error('keyring was not consulted'); };
    const getPassword = vi.fn(() => new Promise<string | null>(resolve => { finish = resolve; }));
    const account = new RememberedAccount({ read: () => grant, legacyUsername: () => '', write: vi.fn() }, { getPassword, setPassword: vi.fn(), deletePassword: vi.fn() }, false);
    const transport: SessionTransport = { authenticate: vi.fn(), client: vi.fn(), retire: vi.fn(async () => undefined) };
    const service = new SessionService({ configuredOrigin: origin, allowLoopback: false, account, transport: () => transport, publish: vi.fn(), chat: vi.fn() });
    service.start();
    expect(getPassword).toHaveBeenCalledWith('metaIDE.metaproject.web.v1', grant.grantId);
    expect(service.snapshot().phase).toBe('restoring');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(service.snapshot()).toMatchObject({ phase: 'signed-out', reason: 'unavailable', retryRestore: true });
    finish(encodeStoredSecret(JSON.stringify({ ...grant, username: 'demo', password: 'test' })));
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.authenticate).not.toHaveBeenCalled();
    expect(service.snapshot()).toMatchObject({ phase: 'signed-out', retryRestore: true });
  } finally { vi.useRealTimers(); }
});

it('never publishes a delayed successful login after cancel', async () => {
  const actor = metaprojectActor.parse({ id: 3, username: 'example' });
  let complete: (value: { ok: true; value: typeof actor }) => void = () => { throw new Error('not started'); };
  const transport: SessionTransport = {
    authenticate: () => new Promise(resolve => { complete = resolve; }), client: () => { throw new Error('stale client'); },
    retire: vi.fn(async () => {}),
  };
  const account = { current: vi.fn(), credentials: vi.fn(), forget: vi.fn(), save: vi.fn(), clearLegacy: vi.fn() };
  const service = new SessionService({ configuredOrigin: 'https://example.test', allowLoopback: false, account, transport: () => transport, publish: vi.fn(), chat: vi.fn() });
  const attemptId = 'ignored-by-domain';
  const pending = service.login({ epoch: 0, attemptId, username: 'example', password: 'example', remember: false });
  expect(service.cancel(attemptId).phase).toBe('signed-out');
  complete({ ok: true, value: actor });
  await expect(pending).resolves.toEqual({ ok: false, reason: 'stale' });
  expect(account.save).not.toHaveBeenCalled();
  expect(account.forget).not.toHaveBeenCalled();
});

function sessionPort() {
  const origin = parseMetaprojectOrigin('https://example.test', false);
  if (!origin) throw new Error('invalid fixture origin');
  const actor = metaprojectActor.parse({ id: 3, username: 'demo' });
  const credentials = { username: 'demo', password: 'test' };
  const input = { ...credentials, epoch: 0, attemptId: 'fixture-intent', remember: false };
  const grant = { grantId: 'a7e66190-1d27-4e5c-80c0-c13080a3a9be', origin, actorId: actor.id };
  const account = {
    current: vi.fn<RememberedAccount['current']>(() => grant),
    credentials: vi.fn<RememberedAccount['credentials']>(async () => credentials),
    forget: vi.fn<RememberedAccount['forget']>(async () => ({ committed: true })),
    save: vi.fn<RememberedAccount['save']>(async () => ({ remembered: true })),
    clearLegacy: vi.fn<RememberedAccount['clearLegacy']>(async () => true),
  };
  const client = new MetaprojectClient({ origin, userId: actor.id, signal: new AbortController().signal, request: vi.fn(),
    jar: { cookies: { get: vi.fn() }, getUserAgent: vi.fn() }, changed: vi.fn(), rejected: vi.fn(), forward: vi.fn(),
  });
  const start = vi.spyOn(client, 'start').mockImplementation(() => undefined);
  const transport = {
    authenticate: vi.fn<SessionTransport['authenticate']>(async () => ({ ok: true, value: actor })),
    client: vi.fn<SessionTransport['client']>(() => client), retire: vi.fn<SessionTransport['retire']>(async () => undefined),
  };
  const publish = vi.fn();
  const chat = vi.fn();
  const service = new SessionService({ configuredOrigin: origin, allowLoopback: false, account, transport: () => transport, publish, chat });
  return { service, input, grant, actor, account, client, start, transport, publish, chat, origin };
}

it.each(['matching', 'changed-grant', 'wrong-actor', 'missing-credentials'] as const)('restores only the current grant and matching principal (%s)', async outcome => {
  vi.useFakeTimers();
  const { service, actor, account, transport, start, origin, grant } = sessionPort();
  try {
    if (outcome === 'changed-grant') account.current.mockReturnValueOnce(grant).mockReturnValue(null);
    if (outcome === 'wrong-actor') transport.authenticate.mockResolvedValueOnce({ ok: true, value: metaprojectActor.parse({ id: 4, username: 'other' }) });
    if (outcome === 'missing-credentials') account.credentials.mockResolvedValueOnce(null);
    service.start();
    service.start();
    expect(account.current).toHaveBeenCalledWith(origin);
    expect(account.credentials).toHaveBeenCalledOnce();
    expect(service.snapshot()).toMatchObject({ phase: 'restoring', epoch: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.authenticate).toHaveBeenCalledTimes(outcome === 'missing-credentials' ? 0 : 1);
    if (outcome === 'matching') {
      expect(service.snapshot()).toMatchObject({ phase: 'signed-in', epoch: 1, actor, remembered: true });
      expect(start).toHaveBeenCalledOnce();
      expect(account.forget).not.toHaveBeenCalled();
    } else {
      expect(service.snapshot()).toMatchObject({ phase: 'signed-out', epoch: 2, reason: outcome === 'changed-grant' ? 'stale' : 'rejected' });
      expect(start).not.toHaveBeenCalled();
      expect(transport.retire).toHaveBeenCalledWith(false);
      expect(account.forget).toHaveBeenCalledTimes(outcome === 'changed-grant' ? 0 : 1);
    }
  } finally { service.dispose(); vi.useRealTimers(); }
});

it('honors the restore retry window and does not retry a remote failure automatically', async () => {
  vi.useFakeTimers();
  const { service, transport, account } = sessionPort();
  try {
    transport.authenticate.mockResolvedValueOnce({ ok: false, reason: 'throttled', retryAfterMs: 2500 });
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.snapshot()).toMatchObject({ phase: 'signed-out', epoch: 2, reason: 'throttled', retryRestore: true });
    await expect(service.retry(1)).resolves.toEqual({ ok: false, reason: 'stale' });
    await expect(service.retry(2)).resolves.toEqual({ ok: false, reason: 'throttled' });
    await vi.advanceTimersByTimeAsync(2499);
    await expect(service.retry(2)).resolves.toEqual({ ok: false, reason: 'throttled' });
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.authenticate).toHaveBeenCalledOnce();
    await expect(service.retry(2)).resolves.toMatchObject({ ok: true, value: { phase: 'signed-in', epoch: 3, remembered: true } });
    expect(transport.authenticate).toHaveBeenCalledTimes(2);
    expect(account.credentials).toHaveBeenCalledTimes(2);
    await expect(service.retry(3)).resolves.toEqual({ ok: false, reason: 'conflict' });
  } finally { service.dispose(); vi.useRealTimers(); }
});

it('retires the live lease before durable forget and drops late Chat callbacks', async () => {
  const { service, transport, account, input, chat, client } = sessionPort();
  try {
    await expect(service.login(input)).resolves.toMatchObject({ ok: true, value: { epoch: 1, phase: 'signed-in' } });
    expect(service.client(1)?.client).toBe(client);
    await expect(service.login({ ...input, epoch: 1 })).resolves.toEqual({ ok: false, reason: 'conflict' });
    const port = transport.client.mock.lastCall?.[0];
    if (!port) throw new Error('client not created');
    port.changed(true);
    port.forward('connect', undefined);
    expect(service.snapshot()).toMatchObject({ connected: true });
    expect(chat).toHaveBeenCalledWith(1, 'connect', undefined);
    let complete: (value: Awaited<ReturnType<RememberedAccount['forget']>>) => void = () => { throw new Error('forget not started'); };
    account.forget.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const logout = service.logout(1);
    expect(port.signal.aborted).toBe(true);
    expect(service.client(1)).toBeNull();
    expect(service.snapshot()).toMatchObject({ phase: 'signed-out', epoch: 2 });
    expect(transport.retire).toHaveBeenCalledWith(true);
    await expect(service.logout(2)).resolves.toEqual({ ok: false, reason: 'conflict' });
    port.forward('connect', undefined);
    port.changed(true);
    port.rejected();
    expect(chat).toHaveBeenCalledOnce();
    complete({ committed: false, warning: 'forget-incomplete' });
    await expect(logout).resolves.toMatchObject({ ok: true, value: { phase: 'signed-out', epoch: 2, warning: 'forget-incomplete' } });
  } finally { service.dispose(); }
});

it('keeps the old configured origin when secure transition does not commit', async () => {
  const { service, account, origin } = sessionPort();
  try {
    await expect(service.changeOrigin(0, 'HTTPS://EXAMPLE.TEST:443')).resolves.toMatchObject({ ok: true, value: { epoch: 0, origin } });
    await expect(service.changeOrigin(0, 'http://refused.test')).resolves.toEqual({ ok: false, reason: 'invalid-origin' });
    expect(account.forget).not.toHaveBeenCalled();
    account.forget.mockResolvedValueOnce({ committed: false });
    account.clearLegacy.mockResolvedValueOnce(false);
    await expect(service.changeOrigin(0, 'https://second.test')).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect(service.snapshot()).toMatchObject({ phase: 'signed-out', configuredOrigin: origin, epoch: 1, warning: 'keychain-not-cleared' });
    await expect(service.changeOrigin(1, 'https://second.test')).resolves.toMatchObject({ ok: true, value: { configuredOrigin: 'https://second.test', epoch: 2 } });
    expect(account.forget.mock.calls).toEqual([['https://second.test'], ['https://second.test']]);
  } finally { service.dispose(); }
});
