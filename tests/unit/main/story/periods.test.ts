import { describe, it, expect } from 'vitest';
import type { ActivityEntry } from '@shared/activity';
import type { IntentUpdate } from '@shared/intent';
import {
  DEFAULT_GAP_THRESHOLD_MS,
  MAX_PERIODS,
  formatDuration,
  formatGap,
  splitIntoPeriods,
} from '@main/story/periods';

function ev(ts: string, tool = 'Edit', target = 'a.ts'): ActivityEntry {
  return { id: ts, ts, agent: 'claude', shellIndex: 0, kind: 'tool', tool, target };
}

function intent(ts: string, text: string): IntentUpdate {
  return { agent: 'claude', shell: 0, text, ts };
}

describe('splitIntoPeriods', () => {
  it('returns an empty list for an empty input', () => {
    expect(splitIntoPeriods([], [])).toEqual([]);
  });

  it('wraps a single event in one period with duration 0 and no gap', () => {
    const periods = splitIntoPeriods([ev('2026-11-24T14:00:00.000Z')], []);
    expect(periods).toHaveLength(1);
    expect(periods[0]!.durationMs).toBe(0);
    expect(periods[0]!.gapBeforeMs).toBe(0);
    expect(periods[0]!.events).toHaveLength(1);
  });

  it('keeps events inside the gap threshold in one period', () => {
    const periods = splitIntoPeriods(
      [
        ev('2026-11-24T14:00:00.000Z'),
        ev('2026-11-24T14:10:00.000Z'),
        ev('2026-11-24T14:25:00.000Z'),
      ],
      [],
    );
    expect(periods).toHaveLength(1);
    expect(periods[0]!.durationMs).toBe(25 * 60_000);
    expect(periods[0]!.events).toHaveLength(3);
  });

  it('starts a new period after an idle gap larger than the threshold', () => {
    const periods = splitIntoPeriods(
      [
        ev('2026-11-24T14:00:00.000Z'),
        ev('2026-11-24T14:05:00.000Z'),
        // gap = 2h, above the 30-min default
        ev('2026-11-24T16:05:00.000Z'),
        ev('2026-11-24T16:12:00.000Z'),
      ],
      [],
    );
    expect(periods).toHaveLength(2);
    expect(periods[0]!.events).toHaveLength(2);
    expect(periods[1]!.events).toHaveLength(2);
    expect(periods[1]!.gapBeforeMs).toBe(2 * 60 * 60_000);
  });

  it('respects a custom gap threshold', () => {
    const periods = splitIntoPeriods(
      [
        ev('2026-11-24T14:00:00.000Z'),
        ev('2026-11-24T14:03:00.000Z'),
        ev('2026-11-24T14:10:00.000Z'),
      ],
      [],
      // 5 min threshold — the 7-minute gap between events 2 and 3 splits them.
      5 * 60_000,
    );
    expect(periods).toHaveLength(2);
    expect(periods[0]!.events).toHaveLength(2);
    expect(periods[1]!.events).toHaveLength(1);
  });

  it('assigns each intent to the period whose time range contains its ts', () => {
    const periods = splitIntoPeriods(
      [
        ev('2026-11-24T14:00:00.000Z'),
        ev('2026-11-24T14:20:00.000Z'),
        // gap
        ev('2026-11-24T18:00:00.000Z'),
        ev('2026-11-24T18:15:00.000Z'),
      ],
      [
        intent('2026-11-24T14:10:00.000Z', 'first period intent'),
        intent('2026-11-24T18:05:00.000Z', 'second period intent'),
        // An intent BEFORE the first event — belongs to no period.
        intent('2026-11-24T13:00:00.000Z', 'orphan'),
      ],
    );
    expect(periods).toHaveLength(2);
    expect(periods[0]!.intents.map((i) => i.text)).toEqual(['first period intent']);
    expect(periods[1]!.intents.map((i) => i.text)).toEqual(['second period intent']);
  });

  it('drops the oldest periods when the count exceeds MAX_PERIODS', () => {
    // Build MAX_PERIODS + 3 distinct periods, each a single event one hour
    // apart (gap > 30 min so each is its own period).
    const events: ActivityEntry[] = [];
    for (let i = 0; i < MAX_PERIODS + 3; i++) {
      events.push(ev(new Date(2026, 10, 24, 10 + i, 0, 0).toISOString()));
    }
    const periods = splitIntoPeriods(events, []);
    expect(periods).toHaveLength(MAX_PERIODS);
    // The first kept period's first event is event index 3 (0..MAX_PERIODS+2
    // → kept MAX_PERIODS tail).
    expect(periods[0]!.events[0]!.id).toBe(events[3]!.id);
  });

  it('matches the documented default threshold', () => {
    expect(DEFAULT_GAP_THRESHOLD_MS).toBe(30 * 60_000);
  });
});

describe('formatGap', () => {
  it('returns null for gaps below the min-show threshold', () => {
    expect(formatGap(60_000)).toBeNull();
    expect(formatGap(4 * 60_000)).toBeNull();
  });
  it('formats sub-hour gaps in minutes', () => {
    expect(formatGap(10 * 60_000)).toBe('10 min gap');
    expect(formatGap(59 * 60_000)).toBe('59 min gap');
  });
  it('formats sub-day gaps in hours and minutes', () => {
    expect(formatGap(60 * 60_000)).toBe('1h gap');
    expect(formatGap(2 * 60 * 60_000 + 17 * 60_000)).toBe('2h 17m gap');
  });
  it('formats multi-day gaps in days and hours', () => {
    expect(formatGap(24 * 60 * 60_000)).toBe('1d gap');
    expect(formatGap(3 * 24 * 60 * 60_000 + 4 * 60 * 60_000)).toBe('3d 4h gap');
  });
});

describe('formatDuration', () => {
  it('returns "< 1 min" for sub-minute spans', () => {
    expect(formatDuration(30_000)).toBe('< 1 min');
    expect(formatDuration(0)).toBe('< 1 min');
  });
  it('formats sub-hour spans in minutes', () => {
    expect(formatDuration(35 * 60_000)).toBe('35 min');
  });
  it('formats sub-day spans in hours (+ minutes)', () => {
    expect(formatDuration(60 * 60_000)).toBe('1h');
    expect(formatDuration(2 * 60 * 60_000 + 10 * 60_000)).toBe('2h 10m');
  });
  it('formats multi-day spans in days (+ hours)', () => {
    expect(formatDuration(25 * 60 * 60_000)).toBe('1d 1h');
    expect(formatDuration(3 * 24 * 60 * 60_000)).toBe('3d');
  });
});
