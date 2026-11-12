/**
 * Reads each CLI's own sign-in (never refreshing or writing it) and asks the provider
 * for the account's rate-limit usage. Tokens stay in the main process; only
 * percentages and reset times reach the renderer.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { USAGE_CACHE_MS, type ProviderUsage, type UsageSnapshot } from '@shared/usage-contract';
import { parseClaudeUsage, parseCodexUsage } from './parse';

export interface UsageDeps {
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly readText: (path: string) => Promise<string | null>;
  /** macOS keychain generic password by service name; null when absent. */
  readonly keychain: (service: string) => Promise<string | null>;
  readonly fetch: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  readonly now: () => number;
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

async function getJson(d: UsageDeps, url: string, headers: Record<string, string>): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await d.fetch(url, { headers, signal: ctrl.signal });
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
    return { provider: 'claude', status: 'ok', ...parseClaudeUsage(body), fetchedAt: d.now() };
  } catch (err) {
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
    return { provider: 'codex', status: 'ok', ...parseCodexUsage(body, d.now()), fetchedAt: d.now() };
  } catch (err) {
    return failed('codex', err);
  }
}

/** Caches one snapshot for USAGE_CACHE_MS and shares an in-flight request between callers. */
export class UsageService {
  private cached: { at: number; snap: UsageSnapshot } | null = null;
  private inflight: Promise<UsageSnapshot> | null = null;

  constructor(private readonly deps: UsageDeps) {}

  get(force = false): Promise<UsageSnapshot> {
    if (this.cached && !force && this.deps.now() - this.cached.at < USAGE_CACHE_MS) return Promise.resolve(this.cached.snap);
    this.inflight ??= Promise.all([fetchClaudeUsage(this.deps), fetchCodexUsage(this.deps)])
      .then(([claude, codex]) => {
        const snap = { claude, codex };
        this.cached = { at: this.deps.now(), snap };
        return snap;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}

/** Production dependencies: fs, `security` for the keychain, and global fetch. */
export function nodeUsageDeps(homeDir: string): UsageDeps {
  return {
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
