/** Pure parsers for the Claude and Codex usage endpoints; unknown or malformed fields become null. */
import type { ModelUsage, UsageWindow } from '@shared/usage-contract';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clampPct = (v: number): number => Math.max(0, Math.min(100, v));

/** `seven_day_*` keys that are not model windows. */
const NON_MODEL_WEEKLY = new Set(['oauth_apps', 'cowork', 'omelette', 'breakdown']);

const slug = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const titleCase = (id: string): string => id.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const parseReset = (v: unknown): number | null => {
  const at = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(at) ? at : null;
};

/**
 * Claude `GET /api/oauth/usage`. Overall windows are `seven_day` / `five_hour`
 * (`{ utilization, resets_at }`, null when the plan has none). Per-model weekly limits
 * (Fable, …) come from `limits[]` entries of kind `weekly_scoped` with
 * `scope.model.display_name` and `percent`; older `seven_day_<model>` windows are read too.
 */
export function parseClaudeUsage(body: unknown): { weekly: UsageWindow | null; session: UsageWindow | null; models: ModelUsage[] } {
  const root = obj(body);
  const win = (key: string): UsageWindow | null => {
    const w = obj(root?.[key]);
    const used = num(w?.utilization);
    if (used === null) return null;
    return { usedPercent: clampPct(used), resetsAt: parseReset(w?.resets_at) };
  };
  const limits = Array.isArray(root?.limits) ? root.limits.map(obj).filter((l): l is Json => l !== null) : [];

  const byId = new Map<string, ModelUsage>();
  for (const l of limits) {
    if (l.kind !== 'weekly_scoped') continue;
    const name = obj(obj(l.scope)?.model)?.display_name;
    const used = num(l.percent);
    if (typeof name !== 'string' || !name.trim() || used === null) continue;
    const id = slug(name);
    if (!byId.has(id)) byId.set(id, { id, label: name.trim(), weekly: { usedPercent: clampPct(used), resetsAt: parseReset(l.resets_at) } });
  }
  for (const key of Object.keys(root ?? {})) {
    const id = /^seven_day_([a-z0-9_]+)$/.exec(key)?.[1];
    if (!id || NON_MODEL_WEEKLY.has(id) || byId.has(id)) continue;
    const weekly = win(key);
    if (weekly) byId.set(id, { id, label: titleCase(id), weekly });
  }
  // Fable first (the one users ask about), then the rest alphabetically.
  const models = [...byId.values()].sort((a, b) => (a.id === 'fable' ? -1 : b.id === 'fable' ? 1 : a.id.localeCompare(b.id)));

  // Fall back to the `weekly_all` limit when `seven_day` is absent.
  const all = limits.find((l) => l.kind === 'weekly_all' && num(l.percent) !== null);
  const weekly = win('seven_day') ?? (all ? { usedPercent: clampPct(num(all.percent) ?? 0), resetsAt: parseReset(all.resets_at) } : null);
  return { weekly, session: win('five_hour'), models };
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
