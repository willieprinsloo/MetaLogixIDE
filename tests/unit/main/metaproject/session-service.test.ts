import { expect, it, vi } from 'vitest';
import { SessionService, type SessionTransport } from '@main/metaproject/session-service';
import { metaprojectActor } from '@shared/metaproject-contract';

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
