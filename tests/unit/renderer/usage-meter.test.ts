import { describe, expect, it } from 'vitest';
import { formatResetIn, peakWeekly } from '@renderer/usage-format';

describe('UsageMeter helpers', () => {
  it('formats reset countdowns', () => {
    const m = 60_000;
    expect(formatResetIn(5 * m, 0)).toBe('5m');
    expect(formatResetIn(130 * m, 0)).toBe('2h 10m');
    expect(formatResetIn((3 * 1440 + 4 * 60) * m, 0)).toBe('3d 4h');
    expect(formatResetIn(-1, 0)).toBe('0m');
  });
  it('peak weekly ignores signed-out and errored providers', () => {
    expect(peakWeekly(null)).toBeNull();
    expect(peakWeekly({
      claude: { provider: 'claude', status: 'ok', weekly: { usedPercent: 40, resetsAt: null }, session: null, fetchedAt: 0 },
      codex: { provider: 'codex', status: 'error', message: 'x' },
    })).toBe(40);
  });
});

describe('usage level (lower is better)', () => {
  it('is ok below 70, amber from 70, red from 90', async () => {
    const { usageLevel, USAGE_LEVEL_FILL } = await import('@renderer/usage-format');
    expect([0, 69.9, 70, 89.9, 90, 100].map(usageLevel)).toEqual(['ok', 'ok', 'warn', 'warn', 'critical', 'critical']);
    expect(USAGE_LEVEL_FILL.ok).toContain('--hue-green');
    expect(USAGE_LEVEL_FILL.warn).toContain('--hue-orange');
    expect(USAGE_LEVEL_FILL.critical).toContain('--danger');
  });
});
