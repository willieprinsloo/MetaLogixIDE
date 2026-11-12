/** Pure formatting helpers for the AI usage meter. */
import type { ProviderUsage, UsageProvider, UsageSnapshot, UsageWindow } from '@shared/usage-contract';

export const PROVIDERS: readonly UsageProvider[] = ['claude', 'codex'];

/** Time until `at`, e.g. "3d 4h", "2h 10m", "5m". */
export function formatResetIn(at: number, now: number): string {
  const mins = Math.max(0, Math.round((at - now) / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Weekly figure when known; null hides the provider's bar. */
export const weeklyOf = (p: ProviderUsage | undefined): UsageWindow | null => (p?.status === 'ok' ? p.weekly : null);

/** Highest weekly use across providers, for the compact label under the icon. */
export function peakWeekly(usage: UsageSnapshot | null): number | null {
  const values = PROVIDERS.map((p) => weeklyOf(usage?.[p])?.usedPercent).filter((v): v is number => v != null);
  return values.length ? Math.max(...values) : null;
}

