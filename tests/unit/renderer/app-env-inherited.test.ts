import { describe, expect, it } from 'vitest';
import { inheritedRows } from '@renderer/app-env-inherited';

describe('inheritedRows', () => {
  it('returns rows in the app map insertion order', () => {
    const rows = inheritedRows({ B: '2', A: '1' }, undefined);
    expect(rows.map((r) => r.name)).toEqual(['B', 'A']);
    expect(rows.map((r) => r.value)).toEqual(['2', '1']);
  });

  it('marks a row overridden only when the project saved map has that name', () => {
    const rows = inheritedRows({ X: 'app', Y: 'app' }, { X: 'proj' });
    expect(rows.find((r) => r.name === 'X')?.overridden).toBe(true);
    expect(rows.find((r) => r.name === 'Y')?.overridden).toBe(false);
  });

  it('a name only present in a draft (not the saved map) is not overridden', () => {
    // projectSaved represents the *saved* map only (A8); a draft-only name must not appear here.
    const rows = inheritedRows({ X: 'app' }, {});
    expect(rows[0]?.overridden).toBe(false);
  });

  it('an undefined project map marks nothing overridden', () => {
    const rows = inheritedRows({ X: 'app', Y: 'app' }, undefined);
    expect(rows.every((r) => r.overridden === false)).toBe(true);
  });

  it('an empty app map returns no rows', () => {
    expect(inheritedRows({}, { X: '1' })).toEqual([]);
  });
});
