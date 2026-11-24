import { describe, expect, it } from 'vitest';
import { parseClaudeUsage, parseCodexUsage } from '@main/usage/parse';

describe('parseClaudeUsage', () => {
  it('maps seven_day to weekly and five_hour to session', () => {
    const r = parseClaudeUsage({
      five_hour: { utilization: 12.5, resets_at: '2026-11-12T20:00:00Z' },
      seven_day: { utilization: 41, resets_at: '2026-11-16T08:00:00+00:00' },
      seven_day_opus: null,
    });
    expect(r.weekly).toEqual({ usedPercent: 41, resetsAt: Date.parse('2026-11-16T08:00:00Z') });
    expect(r.session).toEqual({ usedPercent: 12.5, resetsAt: Date.parse('2026-11-12T20:00:00Z') });
  });
  it('tolerates missing, null and malformed windows', () => {
    expect(parseClaudeUsage(null)).toEqual({ weekly: null, session: null, models: [] });
    expect(parseClaudeUsage({ seven_day: { utilization: 'x' }, five_hour: { utilization: 150, resets_at: 'nope' } })).toEqual({
      weekly: null,
      session: { usedPercent: 100, resetsAt: null },
      models: [],
    });
  });
});

describe('parseClaudeUsage per-model weekly windows', () => {
  it('reads seven_day_<model> windows with Fable first, skipping null ones and oauth_apps', () => {
    const r = parseClaudeUsage({
      seven_day: { utilization: 30 },
      seven_day_opus: { utilization: 10 },
      seven_day_fable: { utilization: 75, resets_at: '2026-11-16T08:00:00Z' },
      seven_day_sonnet: null,
      seven_day_oauth_apps: { utilization: 5 },
    });
    expect(r.models).toEqual([
      { id: 'fable', label: 'Fable', weekly: { usedPercent: 75, resetsAt: Date.parse('2026-11-16T08:00:00Z') } },
      { id: 'opus', label: 'Opus', weekly: { usedPercent: 10, resetsAt: null } },
    ]);
  });
});

describe('parseCodexUsage', () => {
  const now = 1_000_000;
  it('picks the week-long window as weekly by its length', () => {
    const r = parseCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 7, limit_window_seconds: 18000, reset_after_seconds: 600 },
        secondary_window: { used_percent: 33, limit_window_seconds: 604800, reset_at: 2_000 },
      },
    }, now);
    expect(r.weekly).toEqual({ usedPercent: 33, resetsAt: 2_000_000 });
    expect(r.session).toEqual({ usedPercent: 7, resetsAt: now + 600_000 });
  });
  it('falls back to secondary as weekly without window lengths, and handles a single window', () => {
    expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 1 }, secondary_window: { used_percent: 2 } } }, now).weekly?.usedPercent).toBe(2);
    expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 1 } } }, now)).toEqual({ weekly: null, session: { usedPercent: 1, resetsAt: null } });
    expect(parseCodexUsage({}, now)).toEqual({ weekly: null, session: null });
  });
});

describe('real response shapes (2026-11)', () => {
  it('Claude: weekly 12%, no 5-hour window, and Fable from limits[] weekly_scoped', async () => {
    const body = (await import('./fixtures/claude-usage-2026-11.json')).default;
    const r = parseClaudeUsage(body);
    expect(r.weekly).toEqual({ usedPercent: 12, resetsAt: Date.parse('2026-11-16T23:00:00.350558+00:00') });
    expect(r.session).toBeNull();
    expect(r.models).toEqual([{ id: 'fable', label: 'Fable', weekly: { usedPercent: 5, resetsAt: Date.parse('2026-11-16T23:00:00.350687+00:00') } }]);
  });

  it('Claude: weekly_all stands in when seven_day is missing; scoped limits without a model are ignored', () => {
    const r = parseClaudeUsage({
      seven_day: null,
      limits: [
        { kind: 'weekly_all', percent: 40, resets_at: '2026-11-16T23:00:00Z' },
        { kind: 'weekly_scoped', percent: 9, scope: { model: null, surface: 'cowork' } },
        { kind: 'weekly_scoped', percent: 'x', scope: { model: { display_name: 'Opus' } } },
      ],
    });
    expect(r.weekly).toEqual({ usedPercent: 40, resetsAt: Date.parse('2026-11-16T23:00:00Z') });
    expect(r.models).toEqual([]);
  });

  it('Codex: a single 7-day primary window is weekly, with no session window', () => {
    const r = parseCodexUsage({ rate_limit: { primary_window: { used_percent: 77, limit_window_seconds: 604800, reset_after_seconds: 310296, reset_at: 1794814364 }, secondary_window: null } }, 0);
    expect(r).toEqual({ weekly: { usedPercent: 77, resetsAt: 1794814364000 }, session: null });
  });
});
