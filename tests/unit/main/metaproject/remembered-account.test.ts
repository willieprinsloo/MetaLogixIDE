import { expect, it, vi } from 'vitest';
import { RememberedAccount } from '@main/metaproject/remembered-account';
import { parseMetaprojectOrigin } from '@shared/metaproject-contract';

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
