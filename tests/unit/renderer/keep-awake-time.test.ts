import { describe, it, expect } from 'vitest';
import { formatEndTime, formatRemaining, keepAwakeSupported, parseUntil } from '@renderer/keep-awake-time';

const at = (h: number, m: number, s = 0, day = 19): number => new Date(2026, 9, day, h, m, s).getTime();
const MIN = 60_000;

describe('parseUntil', () => {
  it('reports blank input as empty', () => {
    expect(parseUntil('', at(10, 0))).toEqual({ kind: 'empty' });
    expect(parseUntil('   ', at(10, 0))).toEqual({ kind: 'empty' });
  });

  it.each(['7:3', '24:00', 'ab:cd', '12:60', '1830', '18:30:00', '-1:30'])('rejects %s as malformed', (text) => {
    expect(parseUntil(text, at(10, 0))).toEqual({ kind: 'malformed' });
  });

  it('resolves a later time to today', () => {
    expect(parseUntil('18:30', at(10, 0))).toEqual({ kind: 'ok', endsAt: at(18, 30) });
  });

  it('accepts a one-digit hour and surrounding whitespace', () => {
    expect(parseUntil(' 7:05 ', at(6, 0))).toEqual({ kind: 'ok', endsAt: at(7, 5) });
  });

  it('resolves an earlier time to tomorrow', () => {
    expect(parseUntil('07:00', at(22, 0))).toEqual({ kind: 'ok', endsAt: at(7, 0, 0, 20) });
  });

  it('resolves a time equal to now to tomorrow, not now', () => {
    expect(parseUntil('10:00', at(10, 0))).toEqual({ kind: 'ok', endsAt: at(10, 0, 0, 20) });
  });

  it('resolves a time earlier in the same minute to tomorrow', () => {
    expect(parseUntil('10:00', at(10, 0, 30))).toEqual({ kind: 'ok', endsAt: at(10, 0, 0, 20) });
  });

  it('keeps the result within 24 hours of now', () => {
    const now = at(10, 0, 1);
    const r = parseUntil('10:00', now);
    expect(r.kind === 'ok' && r.endsAt - now).toBeLessThanOrEqual(24 * 60 * MIN);
  });
});

describe('formatRemaining', () => {
  const now = at(10, 0);
  it.each([
    [102 * MIN, '1h 42m'],
    [120 * MIN, '2h'],
    [42 * MIN, '42m'],
    [60 * MIN, '1h'],
    [1, '1m'],
    [30_000, '1m'],
    [41 * MIN + 1, '42m'],
    [0, '<1m'],
    [-5 * MIN, '<1m'],
  ])('%i ms left -> %s', (ms, text) => {
    expect(formatRemaining(now + ms, now)).toBe(text);
  });
});

describe('formatEndTime', () => {
  it('marks a same-day end as today', () => {
    expect(formatEndTime(at(18, 30), at(10, 0))).toBe('18:30 today');
  });
  it('marks a next-day end as tomorrow', () => {
    expect(formatEndTime(at(7, 0, 0, 20), at(22, 0))).toBe('07:00 tomorrow');
  });
  it('zero-pads hour and minute', () => {
    expect(formatEndTime(at(7, 5), at(6, 0))).toBe('07:05 today');
  });
});

describe('keepAwakeSupported', () => {
  it('is true only on darwin', () => {
    expect(keepAwakeSupported('darwin')).toBe(true);
    expect(keepAwakeSupported('linux')).toBe(false);
    expect(keepAwakeSupported('win32')).toBe(false);
    expect(keepAwakeSupported(undefined)).toBe(false);
  });
});
