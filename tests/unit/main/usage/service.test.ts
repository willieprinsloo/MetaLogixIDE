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
    t = 30_000;
    await svc.get();
    expect(fetch).toHaveBeenCalledTimes(1);
    await svc.get(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
