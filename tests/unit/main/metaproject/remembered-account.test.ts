import { expect, it, vi } from 'vitest';
import { RememberedAccount } from '@main/metaproject/remembered-account';
import type { MetaprojectKeyring } from '@main/metaproject/ipc-handlers';
import { accountId, parseMetaprojectOrigin } from '@shared/metaproject-contract';

it('never loads a legacy keyring password merely because settings contain a username', () => {
  const read = vi.fn();
  const account = new RememberedAccount({ read: () => undefined, write: vi.fn(), legacyUsername: () => 'legacy' }, {
    getPassword: read, setPassword: vi.fn(), deletePassword: vi.fn(),
  }, false);
  const origin = parseMetaprojectOrigin('https://example.test', false);
  if (!origin) throw new Error('invalid fixture origin');
  expect(account.current(origin)).toBeNull();
  expect(read).not.toHaveBeenCalled();
});

const origin = parseMetaprojectOrigin('https://example.test', false);
if (!origin) throw new Error('invalid fixture origin');
const former = { grantId: 'a7e66190-1d27-4e5c-80c0-c13080a3a9be', origin, actorId: 3 };

it.each([true, false])('distinguishes secure revocation from dual failure (delete succeeds: %s)', async removed => {
  const keyring = { getPassword: vi.fn(async () => 'record'), setPassword: vi.fn(), deletePassword: vi.fn(async () => removed) };
  const write = vi.fn(() => { throw new Error('store unavailable'); });
  const account = new RememberedAccount({ read: () => former, write, legacyUsername: () => '' }, keyring, false);
  await expect(account.forget()).resolves.toEqual(removed ? { committed: false } : { committed: false, warning: 'forget-incomplete' });
  expect(keyring.deletePassword).toHaveBeenCalledWith('metaIDE.metaproject.web.v1', former.grantId);
});

it('does not report remembered when saving the secure slot fails', async () => {
  const keyring = { getPassword: vi.fn(), setPassword: vi.fn(async () => { throw new Error('keyring unavailable'); }), deletePassword: vi.fn(async () => true) };
  const write = vi.fn();
  const account = new RememberedAccount({ read: () => null, write, legacyUsername: () => '' }, keyring, false);
  await expect(account.save(origin, accountId.parse(3), { username: 'demo', password: 'test' }, () => true)).resolves.toEqual({ remembered: false, warning: 'not-remembered' });
  expect(write).not.toHaveBeenCalled();
  expect(keyring.deletePassword).toHaveBeenCalledOnce();
});

it('bounds the wait for secure deletion and distinguishes a committed tombstone', async () => {
  vi.useFakeTimers();
  try {
    const write = vi.fn();
    const keyring = { getPassword: vi.fn(), setPassword: vi.fn(), deletePassword: vi.fn(() => new Promise<boolean>(() => undefined)) };
    const account = new RememberedAccount({ read: () => former, write, legacyUsername: () => '' }, keyring, false);
    const pending = account.forget();
    expect(write).toHaveBeenCalledWith(null, undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({ committed: true, warning: 'keychain-not-cleared' });
  } finally { vi.useRealTimers(); }
});

it('does not authorize an expired secure write, and removes only its unique slot when it lands', async () => {
  vi.useFakeTimers();
  try {
    let complete = (): void => { throw new Error('not started'); };
    const keyring = { getPassword: vi.fn(), setPassword: vi.fn<MetaprojectKeyring['setPassword']>(() => new Promise<void>(resolve => { complete = resolve; })), deletePassword: vi.fn(async () => true) };
    const write = vi.fn();
    const account = new RememberedAccount({ read: () => former, write, legacyUsername: () => '' }, keyring, false);
    const pending = account.save(origin, accountId.parse(3), { username: 'demo', password: 'test' }, () => true);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({ remembered: false, warning: 'not-remembered' });
    const slot = keyring.setPassword.mock.calls[0]?.[1];
    expect(slot).toEqual(expect.any(String));
    expect(slot).not.toBe(former.grantId);
    expect(write).not.toHaveBeenCalled();
    complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(keyring.deletePassword).toHaveBeenCalledOnce();
    expect(keyring.deletePassword).toHaveBeenCalledWith('metaIDE.metaproject.web.v1', slot);
    expect(write).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
