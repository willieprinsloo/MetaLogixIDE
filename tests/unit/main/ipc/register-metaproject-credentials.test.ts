/**
 * Wiring tests for the Metaproject password stored through the credential
 * store: `metaproject:login` writes to it, and `credentials-load` /
 * `auto-login` read it back. The store is a plain in-memory fake, so the
 * real safeStorage / keychain is never touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcMain } from 'electron';
import { registerIpc } from '@main/ipc/register';
import type { CredentialStore } from '@main/credential-store';

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const USER = 'alice';
const HOSTILE = 'p\\a\nss wörd ✓\\n';
const BASE_URL_DEFAULT = 'https://projects.metalogix.solutions';

type Handler = (e: unknown, req: unknown) => Promise<unknown>;

function fakeIpcMain(): IpcMain & { handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  return {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
    handlers,
  } as unknown as ReturnType<typeof fakeIpcMain>;
}

function fakeCredentialStore(): CredentialStore & { readonly entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    isAvailable: () => true,
    save: vi.fn(async (account: string, password: string) => {
      entries.set(account, password);
      return true;
    }),
    load: vi.fn(async (account: string) => entries.get(account) ?? null),
    clear: vi.fn(async (account: string) => {
      entries.delete(account);
    }),
  };
}

function setup(lastUsername: string | null = USER) {
  const metaproject = {
    login: vi.fn(async () => ({ userName: 'Alice' })),
    connectSocket: vi.fn(),
    isLoggedIn: vi.fn(() => false),
    currentUserName: vi.fn(() => null),
    onEvent: vi.fn(),
  };
  const settings = {
    get: vi.fn((key: string) => (key === 'metaproject_last_username' ? lastUsername : null)),
    set: vi.fn(),
  };
  const credentialStore = fakeCredentialStore();
  const ipc = fakeIpcMain();
  registerIpc(
    ipc as unknown as IpcMain,
    { metaproject, settings, credentialStore } as unknown as Parameters<typeof registerIpc>[1],
    () => {},
  );
  const call = (channel: string, req?: unknown) => ipc.handlers.get(channel)!({}, req);
  return { metaproject, credentialStore, call };
}

describe('metaproject:login credential storage', () => {
  it('remember:true writes the password through credentialStore.save', async () => {
    const { call, metaproject, credentialStore } = setup();
    await call('metaproject:login', { username: USER, password: HOSTILE, remember: true });

    expect(metaproject.login).toHaveBeenCalledWith({
      baseUrl: BASE_URL_DEFAULT,
      username: USER,
      password: HOSTILE,
    });
    expect(credentialStore.save).toHaveBeenCalledWith(USER, HOSTILE);
    expect(credentialStore.entries.get(USER)).toBe(HOSTILE);
  });

  it('remember:false stores nothing, while remember:true in the same setup does store', async () => {
    const { call, credentialStore } = setup();
    await call('metaproject:login', { username: USER, password: HOSTILE, remember: false });
    expect(credentialStore.save).not.toHaveBeenCalled();

    await call('metaproject:login', { username: USER, password: HOSTILE, remember: true });
    expect(credentialStore.save).toHaveBeenCalledTimes(1);
  });

  it('a credential-store write failure does not fail the login', async () => {
    const { call, metaproject, credentialStore } = setup();
    (credentialStore.save as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('locked'));
    await expect(
      call('metaproject:login', { username: USER, password: 'x', remember: true }),
    ).resolves.toEqual({ userName: 'Alice' });
    expect(metaproject.connectSocket).toHaveBeenCalledTimes(1);
  });
});

describe('metaproject:credentials-load', () => {
  it.each([
    ['present password', HOSTILE, true],
    ['empty string', '', false],
    ['nothing stored', null, false],
  ])('%s -> hasPassword %s without throwing', async (_name, stored, expected) => {
    const { call, credentialStore } = setup();
    if (stored !== null) credentialStore.entries.set(USER, stored);
    await expect(call('metaproject:credentials-load')).resolves.toEqual({
      username: USER,
      hasPassword: expected,
    });
    expect(credentialStore.load).toHaveBeenCalledWith(USER);
  });

  it('no saved username reports no password without reading the store', async () => {
    const { call, credentialStore } = setup(null);
    await expect(call('metaproject:credentials-load')).resolves.toEqual({
      username: null,
      hasPassword: false,
    });
    expect(credentialStore.load).not.toHaveBeenCalled();
  });
});

describe('metaproject:auto-login', () => {
  it('passes the stored password to login', async () => {
    const { call, metaproject, credentialStore } = setup();
    credentialStore.entries.set(USER, HOSTILE);
    await expect(call('metaproject:auto-login')).resolves.toEqual({ ok: true, userName: 'Alice' });
    expect(metaproject.login).toHaveBeenCalledWith({
      baseUrl: BASE_URL_DEFAULT,
      username: USER,
      password: HOSTILE,
    });
  });

  it('a read failure returns keychain-error without calling login', async () => {
    const { call, metaproject, credentialStore } = setup();
    (credentialStore.load as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('locked'));
    const result = (await call('metaproject:auto-login')) as { ok: boolean; reason?: string };
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/^keychain-error: /);
    expect(metaproject.login).not.toHaveBeenCalled();
  });

  it('an empty stored password is treated as no saved password and does not log in', async () => {
    const { call, metaproject, credentialStore } = setup();
    credentialStore.entries.set(USER, '');
    await expect(call('metaproject:auto-login')).resolves.toEqual({
      ok: false,
      reason: 'no-saved-password',
    });
    expect(metaproject.login).not.toHaveBeenCalled();
  });

  it('nothing stored returns no-saved-password without calling login', async () => {
    const { call, metaproject } = setup();
    await expect(call('metaproject:auto-login')).resolves.toEqual({
      ok: false,
      reason: 'no-saved-password',
    });
    expect(metaproject.login).not.toHaveBeenCalled();
  });
});
