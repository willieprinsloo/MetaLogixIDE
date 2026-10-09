import { describe, expect, it } from 'vitest';
import { APP_ENV_COPY, APP_ENV_TESTIDS, ENV_COPY, ENV_TESTIDS } from '@renderer/project-env-copy';

/** Resolves every value in a copy module to a comparable string: functions (row-label builders) are evaluated with row 1. */
function flatten(copy: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(copy)) {
    if (typeof value === 'function') {
      out[key] = String((value as (n: number) => string)(1));
    } else if (typeof value === 'object' && value !== null) {
      for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
        out[`${key}.${subKey}`] = String(subValue);
      }
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

describe('env copy module (AC35)', () => {
  it('no string value is duplicated between ENV_COPY and APP_ENV_COPY', () => {
    const envValues = Object.values(flatten(ENV_COPY));
    const appEnvValues = Object.values(flatten(APP_ENV_COPY));
    const seen = new Map<string, number>();
    for (const v of [...envValues, ...appEnvValues]) seen.set(v, (seen.get(v) ?? 0) + 1);
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([v]) => v);
    expect(duplicates).toEqual([]);
  });

  it('no test id is duplicated between ENV_TESTIDS and APP_ENV_TESTIDS', () => {
    const ids = [...Object.values(ENV_TESTIDS), ...Object.values(APP_ENV_TESTIDS)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('inherited row labels differ from editable row labels for the same row number (finding 1)', () => {
    expect(ENV_COPY.revealLabel(1)).not.toBe(ENV_COPY.inheritedRevealLabel(1));
    expect(ENV_COPY.hideLabel(1)).not.toBe(ENV_COPY.inheritedHideLabel(1));
    expect(ENV_COPY.copyLabel(1)).not.toBe(ENV_COPY.inheritedCopyLabel(1));
  });

  it('the reveal toggle label switches Show/Hide and both differ from each other', () => {
    expect(ENV_COPY.revealLabel(3)).toBe('Show value, row 3');
    expect(ENV_COPY.hideLabel(3)).toBe('Hide value, row 3');
    expect(ENV_COPY.revealLabel(3)).not.toBe(ENV_COPY.hideLabel(3));
  });

  it('the nav unsaved accessible name is exact (D19)', () => {
    expect(APP_ENV_COPY.navUnsavedLabel).toBe('Environment, unsaved changes');
  });
});
