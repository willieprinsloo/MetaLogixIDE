/**
 * Wiring tests for the Metaproject password stored through keytar: `metaproject:login` must
 * write the encoded form, and `credentials-load` / `auto-login` must decode it. Keytar is mocked
 * with an in-memory map, so the real keyring is never touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcMain } from 'electron';
import { registerIpc } from '@main/ipc/register';

const keytarMock = vi.hoisted(() => ({
  store: new Map<string, string>(),
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
}));

vi.mock('keytar', () => {
  const api = {
    getPassword: keytarMock.getPassword,
    setPassword: keytarMock.setPassword,
    deletePassword: keytarMock.deletePassword,
  };
  return { ...api, default: api };
});

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const SERVICE = 'metaIDE.metaproject';
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
  const ipc = fakeIpcMain();
  registerIpc(
    ipc as unknown as IpcMain,
    { metaproject, settings } as unknown as Parameters<typeof registerIpc>[1],
    () => {},
  );
  const call = (channel: string, req?: unknown) => ipc.handlers.get(channel)!({}, req);
  return { metaproject, call };
}

const b64 = (s: string) => `b64v1:${Buffer.from(s, 'utf8').toString('base64')}`;

beforeEach(() => {
  keytarMock.store.clear();
  keytarMock.getPassword
    .mockReset()
    .mockImplementation(async (s: string, a: string) => keytarMock.store.get(`${s}|${a}`) ?? null);
  keytarMock.setPassword.mockReset().mockImplementation(async (s: string, a: string, p: string) => {
    keytarMock.store.set(`${s}|${a}`, p);
  });
  keytarMock.deletePassword.mockReset().mockResolvedValue(true);
});

describe('metaproject:login credential storage', () => {
  it('remember:true stores an encoded value that decodes to the original password', async () => {
    const { call, metaproject } = setup();
    await call('metaproject:login', { username: USER, password: HOSTILE, remember: true });

    expect(metaproject.login).toHaveBeenCalledWith({
      baseUrl: BASE_URL_DEFAULT,
      username: USER,
      password: HOSTILE,
    });
    expect(keytarMock.setPassword).toHaveBeenCalledTimes(1);
    const [service, account, stored] = keytarMock.setPassword.mock.calls[0] as [
      string,
      string,
      string,
    ];
    expect([service, account]).toEqual([SERVICE, USER]);
    expect(stored).toMatch(/^b64v1:[A-Za-z0-9+/=]+$/);
    expect(Buffer.from(stored.slice('b64v1:'.length), 'base64').toString('utf8')).toBe(HOSTILE);
  });

  it('remember:false stores nothing, while remember:true in the same setup does store', async () => {
    const { call } = setup();
    await call('metaproject:login', { username: USER, password: HOSTILE, remember: false });
    expect(keytarMock.setPassword).not.toHaveBeenCalled();

    await call('metaproject:login', { username: USER, password: HOSTILE, remember: true });
    expect(keytarMock.setPassword).toHaveBeenCalledTimes(1);
  });

  it('a keychain write failure does not fail the login', async () => {
    keytarMock.setPassword.mockRejectedValueOnce(new Error('locked'));
    const { call, metaproject } = setup();
    await expect(
      call('metaproject:login', { username: USER, password: 'x', remember: true }),
    ).resolves.toEqual({ userName: 'Alice' });
    expect(metaproject.connectSocket).toHaveBeenCalledTimes(1);
  });
});

describe('metaproject:credentials-load', () => {
  it.each([
    ['encoded', b64(HOSTILE), true],
    ['legacy plain', 'plain-secret', true],
    ['null (nothing stored)', null, false],
    ['encoded empty string', 'b64v1:', false],
    ['malformed base64 payload', 'b64v1:@@@', false],
  ])('%s -> hasPassword %s without throwing', async (_name, stored, expected) => {
    if (stored !== null) keytarMock.store.set(`${SERVICE}|${USER}`, stored);
    const { call } = setup();
    await expect(call('metaproject:credentials-load')).resolves.toEqual({
      username: USER,
      hasPassword: expected,
    });
    expect(keytarMock.getPassword).toHaveBeenCalledWith(SERVICE, USER);
  });

  it('no saved username reports no password without reading the keychain', async () => {
    const { call } = setup(null);
    await expect(call('metaproject:credentials-load')).resolves.toEqual({
      username: null,
      hasPassword: false,
    });
    expect(keytarMock.getPassword).not.toHaveBeenCalled();
  });
});

describe('metaproject:auto-login', () => {
  it('passes the decoded password to login for an encoded value', async () => {
    keytarMock.store.set(`${SERVICE}|${USER}`, b64(HOSTILE));
    const { call, metaproject } = setup();
    await expect(call('metaproject:auto-login')).resolves.toEqual({ ok: true, userName: 'Alice' });
    expect(metaproject.login).toHaveBeenCalledWith({
      baseUrl: BASE_URL_DEFAULT,
      username: USER,
      password: HOSTILE,
    });
  });

  it('passes a legacy plain value through unchanged', async () => {
    keytarMock.store.set(`${SERVICE}|${USER}`, 'legacy\\plain');
    const { call, metaproject } = setup();
    await expect(call('metaproject:auto-login')).resolves.toEqual({ ok: true, userName: 'Alice' });
    expect(metaproject.login).toHaveBeenCalledWith({
      baseUrl: BASE_URL_DEFAULT,
      username: USER,
      password: 'legacy\\plain',
    });
  });

  it('a malformed value returns keychain-error without calling login or echoing the payload', async () => {
    const payload = 'SECRET@@@PAYLOAD';
    keytarMock.store.set(`${SERVICE}|${USER}`, `b64v1:${payload}`);
    const { call, metaproject } = setup();
    const result = (await call('metaproject:auto-login')) as { ok: boolean; reason?: string };

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/^keychain-error: /);
    expect(result.reason).not.toContain(payload);
    expect(metaproject.login).not.toHaveBeenCalled();
  });

  it('an encoded empty string is treated as no saved password and does not log in', async () => {
    keytarMock.store.set(`${SERVICE}|${USER}`, 'b64v1:');
    const { call, metaproject } = setup();
    await expect(call('metaproject:auto-login')).resolves.toEqual({
      ok: false,
      reason: 'no-saved-password',
    });
    expect(metaproject.login).not.toHaveBeenCalled();
  });
});
