/**
 * Split a merged (activity + chat) event stream into **periods** separated
 * by idle gaps. A period is a run of events with no gap larger than
 * `gapThresholdMs`; between periods, the gap is shown explicitly so a
 * reader can see when nothing happened.
 *
 * Each period is small enough to be summarised by one Claude call: a short
 * headline (the latest intent, if any) and a 2-3 sentence paragraph.
 *
 * The splitter is pure — no clocks, no I/O. Events must already be sorted
 * by ts ascending. Intents are indexed into the periods they overlap with
 * so a per-period prompt can name the badge the agent was actually
 * advertising at the time.
 */

import type { ActivityEntry } from '@shared/activity';
import type { IntentUpdate } from '@shared/intent';

/** 30 minutes of silence starts a new period. Matches how humans
 *  perceive "I stopped working for a bit, then came back". */
export const DEFAULT_GAP_THRESHOLD_MS = 30 * 60_000;

/** Hard cap so a seven-day window with evenly-spaced events can't
 *  demand 500 LLM calls. Older periods are dropped from the head. */
export const MAX_PERIODS = 20;

export interface StoryPeriod {
  /** ISO ts of the first event in this period. */
  startTs: string;
  /** ISO ts of the last event in this period. */
  endTs: string;
  /** Wall-clock duration from startTs to endTs. 0 for a single-event period. */
  durationMs: number;
  /** Idle time between the previous period's endTs and this period's
   *  startTs. 0 for the first period. */
  gapBeforeMs: number;
  /** Events that fell in this period, in original (ascending) order. */
  events: ActivityEntry[];
  /** Intents that were set during this period — later ones win when the
   *  renderer picks the "headline hint". Empty when nobody set a badge
   *  inside the period. */
  intents: IntentUpdate[];
}

/**
 * Walk the (ts-sorted) event stream and cut a new period whenever two
 * adjacent events are more than `gapThresholdMs` apart.
 *
 * - An empty stream returns [].
 * - A stream with one event yields one period of durationMs 0.
 * - When the result would hold more than `MAX_PERIODS` entries, the
 *   oldest ones are dropped: a reader catching up cares about recent
 *   work, not three days ago.
 */
export function splitIntoPeriods(
  events: ActivityEntry[],
  intents: IntentUpdate[],
  gapThresholdMs: number = DEFAULT_GAP_THRESHOLD_MS,
): StoryPeriod[] {
  if (events.length === 0) return [];

  // Group into contiguous runs separated by gaps > threshold.
  const groups: ActivityEntry[][] = [];
  let current: ActivityEntry[] = [events[0]!];
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1]!;
    const cur = events[i]!;
    const gap = tsDiffMs(prev.ts, cur.ts);
    if (gap > gapThresholdMs) {
      groups.push(current);
      current = [cur];
    } else {
      current.push(cur);
    }
  }
  groups.push(current);

  // Convert groups to StoryPeriod.
  const periods: StoryPeriod[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    const startTs = g[0]!.ts;
    const endTs = g[g.length - 1]!.ts;
    const durationMs = Math.max(0, tsDiffMs(startTs, endTs));
    const gapBeforeMs = i === 0 ? 0 : tsDiffMs(groups[i - 1]![groups[i - 1]!.length - 1]!.ts, startTs);
    const periodIntents = intents
      .filter((intent) => intent.ts >= startTs && intent.ts <= endTs)
      .sort((a, b) => a.ts.localeCompare(b.ts));
    periods.push({ startTs, endTs, durationMs, gapBeforeMs, events: g, intents: periodIntents });
  }

  // Cap at MAX_PERIODS by dropping from the HEAD (oldest). The first
  // kept period's gapBeforeMs stays — a long gap at the top tells the
  // reader "nothing happened for a while before this".
  if (periods.length > MAX_PERIODS) {
    return periods.slice(periods.length - MAX_PERIODS);
  }
  return periods;
}

/**
 * ISO-ts diff in ms, non-negative.
 *
 * We parse via Date — ISO 8601 round-trips the same way on every
 * platform Node runs on. A malformed ts (NaN) collapses to 0 so a bad
 * row never explodes the splitter.
 */
function tsDiffMs(aTs: string, bTs: string): number {
  const a = Date.parse(aTs);
  const b = Date.parse(bTs);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return b - a;
}

/**
 * Human-friendly gap label for the strip between cards:
 * "2h 17m gap", "45 min gap", "3d 4h gap".
 *
 * Returns null when the gap is below a threshold worth showing
 * (default 5 min) — small gaps between adjacent tool calls are noise.
 */
export function formatGap(ms: number, minShowMs: number = 5 * 60_000): string | null {
  if (ms < minShowMs) return null;
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} min gap`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) {
    return minutes === 0 ? `${hours}h gap` : `${hours}h ${minutes}m gap`;
  }
  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return remainderHours === 0 ? `${days}d gap` : `${days}d ${remainderHours}h gap`;
}

/**
 * Human-friendly duration label for a period's strip:
 * "35 min", "2h 10m", "1d 3h".
 *
 * Unlike `formatGap`, this always returns a string even for very short
 * windows — a card with no duration label looks broken. A period made
 * of a single event collapses to `< 1 min`.
 */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return '< 1 min';
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) {
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return remainderHours === 0 ? `${days}d` : `${days}d ${remainderHours}h`;
}
