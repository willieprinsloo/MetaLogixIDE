/**
 * Pure time helpers for the keep-awake UI. `parseUntil` resolves a typed "HH:MM" (24-hour, local time)
 * to the next such wall-clock instant strictly after `now` (a time at or before now means tomorrow, so
 * the result is always within 24 hours). `formatRemaining` rounds up to whole minutes; `formatEndTime`
 * renders "HH:MM today|tomorrow". `keepAwakeSupported` gates the whole feature to macOS.
 */

export type ParsedUntil =
  | { readonly kind: 'ok'; readonly endsAt: number }
  | { readonly kind: 'empty' }
  | { readonly kind: 'malformed' };

const HH_MM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const MINUTE_MS = 60_000;

export function keepAwakeSupported(platform: string | undefined): boolean {
  return platform === 'darwin';
}

export function parseUntil(text: string, now: number): ParsedUntil {
  const trimmed = text.trim();
  if (trimmed === '') return { kind: 'empty' };
  const m = HH_MM.exec(trimmed);
  if (!m) return { kind: 'malformed' };
  const target = new Date(now);
  target.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (target.getTime() <= now) target.setDate(target.getDate() + 1);
  return { kind: 'ok', endsAt: target.getTime() };
}

export function formatRemaining(endsAt: number, now: number): string {
  const total = Math.ceil((endsAt - now) / MINUTE_MS);
  if (total <= 0) return '<1m';
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

const pad = (n: number): string => String(n).padStart(2, '0');

export function formatEndTime(endsAt: number, now: number): string {
  const end = new Date(endsAt);
  const time = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
  const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(end) - startOfDay(new Date(now))) / 86_400_000);
  if (days === 0) return `${time} today`;
  return days === 1 ? `${time} tomorrow` : time;
}
