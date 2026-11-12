/** Shared shapes for the subscription usage meters (Claude and Codex/OpenAI) shown in the activity bar. */

export type UsageProvider = 'claude' | 'codex';

/** One rate-limit window as a used percentage (0–100) and its reset time (epoch ms) when known. */
export interface UsageWindow {
  readonly usedPercent: number;
  readonly resetsAt: number | null;
}

/**
 * One provider's usage. `signed-out` means no CLI sign-in was found (nothing to show);
 * `error` means the sign-in exists but the request failed (expired token, network, etc.).
 */
export type ProviderUsage =
  | {
      readonly provider: UsageProvider; readonly status: 'ok';
      readonly weekly: UsageWindow | null; readonly session: UsageWindow | null; readonly fetchedAt: number;
      /** Set when these are older figures kept because a refresh was rate limited. */
      readonly note?: string; readonly retryAt?: number;
    }
  | { readonly provider: UsageProvider; readonly status: 'signed-out' }
  | { readonly provider: UsageProvider; readonly status: 'error'; readonly message: string; readonly retryAt?: number };

export interface UsageSnapshot {
  readonly claude: ProviderUsage;
  readonly codex: ProviderUsage;
}

export const USAGE_PROVIDER_LABEL: Readonly<Record<UsageProvider, string>> = {
  claude: 'Claude',
  codex: 'OpenAI Codex',
};

/** Renderer poll interval; main caches each provider for USAGE_CACHE_MS. The Claude endpoint rate-limits hard. */
export const USAGE_POLL_MS = 10 * 60_000;
export const USAGE_CACHE_MS = 10 * 60_000;
/** A click-to-refresh fetches at most this often per provider. */
export const USAGE_MIN_FORCE_MS = 60_000;
/** Backoff after HTTP 429 when the provider sends no (or a shorter) Retry-After. */
export const USAGE_RATE_LIMIT_BACKOFF_MS = 10 * 60_000;

export const USAGE_TESTIDS = {
  button: 'ab-usage',
  popover: 'usage-popover',
  meter: (p: UsageProvider) => `usage-meter-${p}`,
} as const;

/**
 * E2E seam, honoured only when `METAIDE_TEST_MODE=1`: JSON keyed by provider. A provider
 * entry stands in for its usage endpoint's HTTP response; an absent or null entry means
 * that CLI is signed out. In test mode without this variable both providers are signed
 * out, so no test ever reads real credentials or calls a real endpoint.
 */
export const USAGE_FIXTURE_ENV = 'METAIDE_USAGE_FIXTURE';

export interface UsageFixtureResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly retryAfter?: string;
}
export type UsageFixture = Partial<Record<UsageProvider, UsageFixtureResponse | null>>;
