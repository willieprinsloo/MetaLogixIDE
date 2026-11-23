import { expect, it, vi } from 'vitest';
import { SessionService, type SessionTransport } from '@main/metaproject/session-service';
import { metaprojectActor } from '@shared/metaproject-contract';
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
