/**
 * Reads each CLI's own sign-in (never refreshing or writing it) and asks the provider
 * for the account's rate-limit usage. Tokens stay in the main process; only
 * percentages and reset times reach the renderer.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { USAGE_FIXTURE_ENV, type UsageFixture, USAGE_CACHE_MS, USAGE_MIN_FORCE_MS, USAGE_RATE_LIMIT_BACKOFF_MS, type ProviderUsage, type UsageProvider, type UsageSnapshot } from '@shared/usage-contract';
import { parseClaudeUsage, parseCodexUsage } from './parse';

export interface UsageDeps {
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly readText: (path: string) => Promise<string | null>;
  /** macOS keychain generic password by service name; null when absent. */
  readonly keychain: (service: string) => Promise<string | null>;
  readonly fetch: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; headers?: { get(name: string): string | null }; json(): Promise<unknown> }>;
  readonly now: () => number;
  /** Keeps the last raw response body per provider for troubleshooting (usage figures only, never tokens). */
  readonly recordResponse?: (provider: UsageProvider, body: unknown) => void;
}

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const TIMEOUT_MS = 10_000;

const safeJson = (text: string | null): Record<string, unknown> | null => {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** Claude Code keeps its OAuth sign-in in the macOS keychain, or `~/.claude/.credentials.json` elsewhere. */
async function claudeToken(d: UsageDeps): Promise<string | null> {
  const raw = d.platform === 'darwin'
    ? (await d.keychain('Claude Code-credentials')) ?? (await d.readText(join(d.homeDir, '.claude', '.credentials.json')))
    : await d.readText(join(d.homeDir, '.claude', '.credentials.json'));
  const oauth = safeJson(raw)?.claudeAiOauth as Record<string, unknown> | undefined;
  return typeof oauth?.accessToken === 'string' ? oauth.accessToken : null;
}

/** Codex keeps a ChatGPT sign-in in `~/.codex/auth.json` (`$CODEX_HOME` overrides the dir). */
async function codexAuth(d: UsageDeps): Promise<{ token: string; accountId: string | null } | null> {
  const dir = process.env.CODEX_HOME || join(d.homeDir, '.codex');
  const tokens = safeJson(await d.readText(join(dir, 'auth.json')))?.tokens as Record<string, unknown> | undefined;
  if (typeof tokens?.access_token !== 'string') return null;
  return { token: tokens.access_token, accountId: typeof tokens.account_id === 'string' ? tokens.account_id : null };
}

/** HTTP 429: the provider asks us to slow down; `retryAfterMs` comes from Retry-After when sent. */
export class RateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('Rate limited by the provider');
  }
}

/** Retry-After as delta-seconds or an HTTP date; falls back to the default backoff. */
function retryAfterMs(value: string | null | undefined, now: number): number {
  if (value) {
    const secs = Number(value);
    if (Number.isFinite(secs) && secs >= 0) return Math.max(USAGE_RATE_LIMIT_BACKOFF_MS, secs * 1000);
    const at = Date.parse(value);
    if (Number.isFinite(at)) return Math.max(USAGE_RATE_LIMIT_BACKOFF_MS, at - now);
  }
  return USAGE_RATE_LIMIT_BACKOFF_MS;
}

async function getJson(d: UsageDeps, url: string, headers: Record<string, string>): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await d.fetch(url, { headers, signal: ctrl.signal });
    if (res.status === 429) throw new RateLimitedError(retryAfterMs(res.headers?.get('retry-after'), d.now()));
    if (res.status === 401 || res.status === 403) throw new Error('Sign-in expired — run the CLI once to refresh it');
    if (!res.ok) throw new Error(`Usage request failed (HTTP ${res.status})`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const failed = (provider: ProviderUsage['provider'], err: unknown): ProviderUsage => ({
  provider,
  status: 'error',
  message: err instanceof Error && err.name !== 'AbortError' ? err.message : 'Usage request timed out',
});

export async function fetchClaudeUsage(d: UsageDeps): Promise<ProviderUsage> {
  const token = await claudeToken(d).catch(() => null);
  if (!token) return { provider: 'claude', status: 'signed-out' };
  try {
    const body = await getJson(d, CLAUDE_USAGE_URL, { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' });
    d.recordResponse?.('claude', body);
    return { provider: 'claude', status: 'ok', ...parseClaudeUsage(body), fetchedAt: d.now() };
  } catch (err) {
    if (err instanceof RateLimitedError) throw err;
    return failed('claude', err);
  }
}

export async function fetchCodexUsage(d: UsageDeps): Promise<ProviderUsage> {
  const auth = await codexAuth(d).catch(() => null);
  if (!auth) return { provider: 'codex', status: 'signed-out' };
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${auth.token}`, Accept: 'application/json', 'User-Agent': 'codex_cli_rs' };
    if (auth.accountId) headers['ChatGPT-Account-Id'] = auth.accountId;
    const body = await getJson(d, CODEX_USAGE_URL, headers);
    d.recordResponse?.('codex', body);
    return { provider: 'codex', status: 'ok', ...parseCodexUsage(body, d.now()), fetchedAt: d.now() };
  } catch (err) {
    if (err instanceof RateLimitedError) throw err;
    return failed('codex', err);
  }
}

interface ProviderState {
  value: ProviderUsage | null;
  fetchedAt: number;
  /** No request before this time (rate-limit backoff). */
  blockedUntil: number;
  inflight: Promise<ProviderUsage> | null;
}

/**
 * Per-provider cache (USAGE_CACHE_MS) with in-flight sharing. A 429 starts a backoff that
 * even a forced refresh respects, and the last good figures stay on show with a note.
 */
export class UsageService {
  private readonly state: Record<UsageProvider, ProviderState> = {
    claude: { value: null, fetchedAt: -Infinity, blockedUntil: -Infinity, inflight: null },
    codex: { value: null, fetchedAt: -Infinity, blockedUntil: -Infinity, inflight: null },
  };

  constructor(
    private readonly deps: UsageDeps,
    private readonly fetchers: Record<UsageProvider, (d: UsageDeps) => Promise<ProviderUsage>> = { claude: fetchClaudeUsage, codex: fetchCodexUsage },
  ) {}

  async get(force = false): Promise<UsageSnapshot> {
    const [claude, codex] = await Promise.all([this.one('claude', force), this.one('codex', force)]);
    return { claude, codex };
  }

  private one(provider: UsageProvider, force: boolean): Promise<ProviderUsage> {
    const st = this.state[provider];
    const now = this.deps.now();
    const age = now - st.fetchedAt;
    if (st.value && (now < st.blockedUntil || age < (force ? USAGE_MIN_FORCE_MS : USAGE_CACHE_MS))) return Promise.resolve(st.value);
    st.inflight ??= this.fetchers[provider](this.deps)
      .catch((err: unknown): ProviderUsage => {
        if (!(err instanceof RateLimitedError)) throw err;
        st.blockedUntil = this.deps.now() + err.retryAfterMs;
        const retryAt = st.blockedUntil;
        const last = st.value;
        if (last?.status === 'ok') return { ...last, note: 'Rate limited — showing the last figures', retryAt };
        return { provider, status: 'error', message: 'Rate limited by the provider', retryAt };
      })
      .then((value) => {
        st.value = value;
        st.fetchedAt = this.deps.now();
        return value;
      })
      .finally(() => {
        st.inflight = null;
      });
    return st.inflight;
  }
}

/** Production dependencies: fs, `security` for the keychain, and global fetch. */
export function nodeUsageDeps(homeDir: string, debugDir?: string): UsageDeps {
  return {
    recordResponse: debugDir
      ? (provider, body) => {
          void mkdir(debugDir, { recursive: true })
            .then(() => writeFile(join(debugDir, `${provider}.json`), JSON.stringify(body, null, 2)))
            .catch(() => {});
        }
      : undefined,
    homeDir,
    platform: process.platform,
    readText: (path) => readFile(path, 'utf8').catch(() => null),
    keychain: (service) =>
      new Promise((resolve) => {
        execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], { timeout: 5_000 }, (err, stdout) => {
          resolve(err ? null : stdout.trim() || null);
        });
      }),
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
  };
}

/** Test-mode dependencies: fake sign-ins and canned HTTP responses from the fixture; never the keychain or network. */
export function fixtureUsageDeps(homeDir: string, fixture: UsageFixture): UsageDeps {
  const claudeCreds = join(homeDir, '.claude', '.credentials.json');
  const codexAuthPath = join(process.env.CODEX_HOME || join(homeDir, '.codex'), 'auth.json');
  return {
    homeDir,
    platform: 'linux',
    keychain: async () => null,
    readText: async (path) => {
      if (path === claudeCreds && fixture.claude) return JSON.stringify({ claudeAiOauth: { accessToken: 'fixture' } });
      if (path === codexAuthPath && fixture.codex) return JSON.stringify({ tokens: { access_token: 'fixture', account_id: 'fixture' } });
      return null;
    },
    fetch: async (url) => {
      const res = url === CLAUDE_USAGE_URL ? fixture.claude : url === CODEX_USAGE_URL ? fixture.codex : null;
      if (!res) throw new Error(`no usage fixture for ${url}`);
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? res.retryAfter ?? null : null) },
        json: async () => res.body ?? {},
      };
    },
    now: () => Date.now(),
  };
}

/** Picks real dependencies, or the fixture seam under `METAIDE_TEST_MODE=1` (signed out when unset or invalid). */
export function usageDepsFor(homeDir: string, env: NodeJS.ProcessEnv = process.env, debugDir?: string): UsageDeps {
  if (env.METAIDE_TEST_MODE !== '1') return nodeUsageDeps(homeDir, debugDir);
  let fixture: UsageFixture = {};
  try {
    const parsed: unknown = JSON.parse(env[USAGE_FIXTURE_ENV] ?? '{}');
    if (parsed && typeof parsed === 'object') fixture = parsed as UsageFixture;
  } catch {
    console.warn(`[usage] ignoring invalid ${USAGE_FIXTURE_ENV}`);
  }
  return fixtureUsageDeps(homeDir, fixture);
}
