import { describe, expect, it, vi } from 'vitest';
import { UsageService, fetchClaudeUsage, fetchCodexUsage, type UsageDeps } from '@main/usage/service';

function deps(over: Partial<UsageDeps> = {}): UsageDeps {
  return {
    homeDir: '/home/u',
    platform: 'linux',
    readText: async () => null,
    keychain: async () => null,
    fetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
    now: () => 1000,
    ...over,
  };
}

describe('usage service', () => {
  it('reports signed-out without any network call when no CLI sign-in exists', async () => {
    const d = deps();
    expect(await fetchClaudeUsage(d)).toEqual({ provider: 'claude', status: 'signed-out' });
    expect(await fetchCodexUsage(d)).toEqual({ provider: 'codex', status: 'signed-out' });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('reads the Claude token from the macOS keychain and sends it with the OAuth beta header', async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ seven_day: { utilization: 20 } }) }));
    const d = deps({ platform: 'darwin', keychain: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }), fetch });
    const r = await fetchClaudeUsage(d);
    expect(r).toMatchObject({ status: 'ok', weekly: { usedPercent: 20 } });
    const [, init] = fetch.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.headers['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  it('reads Codex auth.json and sends the account id; a 401 becomes a sign-in message', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    const readText = async (p: string) => (p.endsWith('/.codex/auth.json') ? JSON.stringify({ tokens: { access_token: 'a', account_id: 'acc' } }) : null);
    const r = await fetchCodexUsage(deps({ readText, fetch }));
    expect(r).toMatchObject({ status: 'error', message: expect.stringContaining('Sign-in expired') });
    const [, init] = fetch.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(init.headers['ChatGPT-Account-Id']).toBe('acc');
  });

  it('caches a snapshot and shares in-flight requests', async () => {
    let t = 0;
    const readText = async () => JSON.stringify({ claudeAiOauth: { accessToken: 'x' } });
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const svc = new UsageService(deps({ readText, fetch, now: () => t }));
    await Promise.all([svc.get(), svc.get()]);
    expect(fetch).toHaveBeenCalledTimes(1);
    t = 5 * 60_000;
    await svc.get();
    expect(fetch).toHaveBeenCalledTimes(1);
    await svc.get(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('usage service rate limiting', () => {
  const okBody = { seven_day: { utilization: 20 } };
  const creds = async () => JSON.stringify({ claudeAiOauth: { accessToken: 'x' } });

  it('a 429 keeps the last figures with a note and backs off for Retry-After, even when forced', async () => {
    let t = 0;
    let status = 200;
    const fetch = vi.fn(async () => ({ ok: status === 200, status, headers: { get: (n: string) => (n === 'retry-after' ? '1200' : null) }, json: async () => okBody }));
    const svc = new UsageService(deps({ readText: creds, fetch, now: () => t }));
    expect((await svc.get()).claude).toMatchObject({ status: 'ok', weekly: { usedPercent: 20 } });
    status = 429;
    t = 11 * 60_000;
    const limited = (await svc.get()).claude;
    expect(limited).toMatchObject({ status: 'ok', weekly: { usedPercent: 20 }, note: expect.stringContaining('Rate limited'), retryAt: t + 1_200_000 });
    const calls = fetch.mock.calls.length;
    t += 5 * 60_000;
    await svc.get(true);
    expect(fetch.mock.calls.length, 'no request during the backoff').toBe(calls);
    status = 200;
    t += 16 * 60_000;
    expect((await svc.get(true)).claude).not.toHaveProperty('note');
  });

  it('a first-call 429 is an error with a retry time and the default 10 minute backoff', async () => {
    const t = 1000;
    const fetch = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    const svc = new UsageService(deps({ readText: creds, fetch, now: () => t }));
    expect((await svc.get()).claude).toEqual({ provider: 'claude', status: 'error', message: 'Rate limited by the provider', retryAt: t + 600_000 });
  });

  it('a click refresh within a minute reuses the cached figures', async () => {
    let t = 0;
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => okBody }));
    const svc = new UsageService(deps({ readText: creds, fetch, now: () => t }));
    await svc.get();
    t = 30_000;
    await svc.get(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('usage test-mode seam', () => {
  it('outside test mode uses the real dependencies', async () => {
    const { usageDepsFor } = await import('@main/usage/service');
    expect(usageDepsFor('/h', {}).platform).toBe(process.platform);
  });

  it('in test mode with no fixture both providers are signed out and nothing is fetched', async () => {
    const { usageDepsFor } = await import('@main/usage/service');
    const d = usageDepsFor('/h', { METAIDE_TEST_MODE: '1' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const snap = await new UsageService(d).get();
    expect(snap).toEqual({ claude: { provider: 'claude', status: 'signed-out' }, codex: { provider: 'codex', status: 'signed-out' } });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('serves canned responses, including a 429 with Retry-After', async () => {
    const { usageDepsFor } = await import('@main/usage/service');
    const fixture = { claude: { status: 200, body: { seven_day: { utilization: 42 } } }, codex: { status: 429, retryAfter: '900' } };
    const snap = await new UsageService(usageDepsFor('/h', { METAIDE_TEST_MODE: '1', METAIDE_USAGE_FIXTURE: JSON.stringify(fixture) })).get();
    expect(snap.claude).toMatchObject({ status: 'ok', weekly: { usedPercent: 42 } });
    expect(snap.codex).toMatchObject({ status: 'error', message: 'Rate limited by the provider' });
  });

  it('an invalid fixture falls back to signed out', async () => {
    const { usageDepsFor } = await import('@main/usage/service');
    const snap = await new UsageService(usageDepsFor('/h', { METAIDE_TEST_MODE: '1', METAIDE_USAGE_FIXTURE: '{nope' })).get();
    expect(snap.claude.status).toBe('signed-out');
  });
});
