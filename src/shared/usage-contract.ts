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
  | { readonly provider: UsageProvider; readonly status: 'ok'; readonly weekly: UsageWindow | null; readonly session: UsageWindow | null; readonly fetchedAt: number }
  | { readonly provider: UsageProvider; readonly status: 'signed-out' }
  | { readonly provider: UsageProvider; readonly status: 'error'; readonly message: string };

export interface UsageSnapshot {
  readonly claude: ProviderUsage;
  readonly codex: ProviderUsage;
}

export const USAGE_PROVIDER_LABEL: Readonly<Record<UsageProvider, string>> = {
  claude: 'Claude',
  codex: 'OpenAI Codex',
};

/** Renderer poll interval; main also caches responses for USAGE_CACHE_MS. */
export const USAGE_POLL_MS = 5 * 60_000;
export const USAGE_CACHE_MS = 60_000;

export const USAGE_TESTIDS = {
  button: 'ab-usage',
  popover: 'usage-popover',
  meter: (p: UsageProvider) => `usage-meter-${p}`,
} as const;
