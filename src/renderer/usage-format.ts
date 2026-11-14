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

/** One thin bar in the activity bar: a provider's weekly window, or one of its models'. */
export interface GutterBar {
  readonly key: string;
  readonly label: string;
  readonly weekly: UsageWindow;
}

/** Bars in display order, one per provider (model windows such as Fable appear only in the popover). */
export function gutterBars(usage: UsageSnapshot | null): GutterBar[] {
  const bars: GutterBar[] = [];
  for (const p of PROVIDERS) {
    const u = usage?.[p];
    if (u?.status !== 'ok') continue;
    if (u.weekly) bars.push({ key: p, label: p, weekly: u.weekly });
  }
  return bars;
}

/** Highest provider weekly use, for the button's accessible label. */
export function peakWeekly(usage: UsageSnapshot | null): number | null {
  const values = gutterBars(usage).map((b) => b.weekly.usedPercent);
  return values.length ? Math.max(...values) : null;
}


/** Usage severity: lower is better. Amber from 70 %, red from 90 %. */
export type UsageLevel = 'ok' | 'warn' | 'critical';
export const USAGE_WARN_PERCENT = 70;
export const USAGE_CRITICAL_PERCENT = 90;

export function usageLevel(usedPercent: number): UsageLevel {
  if (usedPercent >= USAGE_CRITICAL_PERCENT) return 'critical';
  if (usedPercent >= USAGE_WARN_PERCENT) return 'warn';
  return 'ok';
}

/** Fill and text classes per level: green, amber, red. */
export const USAGE_LEVEL_FILL: Readonly<Record<UsageLevel, string>> = {
  ok: 'bg-[--hue-green]',
  warn: 'bg-[--hue-orange]',
  critical: 'bg-[--danger]',
};
export const USAGE_LEVEL_TEXT: Readonly<Record<UsageLevel, string>> = {
  ok: 'text-[--text]',
  warn: 'text-[--hue-orange]',
  critical: 'text-[--danger]',
};
