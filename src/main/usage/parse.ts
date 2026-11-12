/** Pure parsers for the Claude and Codex usage endpoints; unknown or malformed fields become null. */
import type { ModelUsage, UsageWindow } from '@shared/usage-contract';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clampPct = (v: number): number => Math.max(0, Math.min(100, v));

/** `seven_day_*` keys that are not model windows. */
const NON_MODEL_WEEKLY = new Set(['oauth_apps']);

/**
 * Claude `GET /api/oauth/usage`: `{ five_hour: { utilization, resets_at }, seven_day: {...},
 * seven_day_<model>: {...} }`. Every `seven_day_<model>` with a utilization (Fable, Opus,
 * Sonnet, …) becomes a per-model weekly window; null ones are skipped.
 */
export function parseClaudeUsage(body: unknown): { weekly: UsageWindow | null; session: UsageWindow | null; models: ModelUsage[] } {
  const root = obj(body);
  const win = (key: string): UsageWindow | null => {
    const w = obj(root?.[key]);
    const used = num(w?.utilization);
    if (used === null) return null;
    const reset = typeof w?.resets_at === 'string' ? Date.parse(w.resets_at) : NaN;
    return { usedPercent: clampPct(used), resetsAt: Number.isFinite(reset) ? reset : null };
  };
  const models: ModelUsage[] = [];
  for (const key of Object.keys(root ?? {})) {
    const id = /^seven_day_([a-z0-9_]+)$/.exec(key)?.[1];
    if (!id || NON_MODEL_WEEKLY.has(id)) continue;
    const weekly = win(key);
    if (weekly) models.push({ id, label: id.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '), weekly });
  }
  // Fable first (the one users ask about), then the rest alphabetically.
  models.sort((a, b) => (a.id === 'fable' ? -1 : b.id === 'fable' ? 1 : a.id.localeCompare(b.id)));
  return { weekly: win('seven_day'), session: win('five_hour'), models };
}

/**
 * Codex `GET /backend-api/wham/usage`: `{ rate_limit: { primary_window, secondary_window } }`,
 * each `{ used_percent, limit_window_seconds, reset_at (epoch s) | reset_after_seconds }`.
 * The window lengths decide which is weekly; without them primary is the session window.
 */
export function parseCodexUsage(body: unknown, now: number): { weekly: UsageWindow | null; session: UsageWindow | null } {
  const limits = obj(obj(body)?.rate_limit);
  const read = (key: string): { win: UsageWindow; seconds: number | null } | null => {
    const w = obj(limits?.[key]);
    const used = num(w?.used_percent);
    if (used === null) return null;
    const at = num(w?.reset_at);
    const after = num(w?.reset_after_seconds);
    const resetsAt = at !== null ? at * 1000 : after !== null ? now + after * 1000 : null;
    return { win: { usedPercent: clampPct(used), resetsAt }, seconds: num(w?.limit_window_seconds) };
  };
  const windows = [read('primary_window'), read('secondary_window')].filter((w) => w !== null);
  const WEEK = 7 * 24 * 3600;
  const weekly = windows.find((w) => w.seconds !== null && w.seconds >= WEEK - 3600) ?? (windows.length > 1 ? windows[1] : null);
  const session = windows.find((w) => w !== weekly) ?? null;
  return { weekly: weekly?.win ?? null, session: session?.win ?? null };
}
