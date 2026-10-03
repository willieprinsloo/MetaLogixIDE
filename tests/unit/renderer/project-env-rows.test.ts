import { describe, it, expect } from 'vitest';
import {
  addRow,
  canSave,
  isDraftDirty,
  removeRow,
  rowProblems,
  rowsFromEnv,
  rowsToEnv,
  updateRow,
  type EnvRow,
} from '@renderer/project-env-rows';

function nth(list: EnvRow[], i: number): EnvRow {
  const row = list[i];
  if (!row) throw new Error(`no row ${i}`);
  return row;
}

function rows(...pairs: Array<[string, string]>): EnvRow[] {
  return pairs.map(([name, value], key) => ({ key, name, value }));
}

describe('rowsFromEnv', () => {
  it('keeps the saved insertion order', () => {
    const r = rowsFromEnv({ ZED: '1', API_URL: 'http://x', alpha: '' });
    expect(r.map((x) => [x.name, x.value])).toEqual([
      ['ZED', '1'],
      ['API_URL', 'http://x'],
      ['alpha', ''],
    ]);
  });

  it('gives every row a distinct key', () => {
    const r = rowsFromEnv({ A: '1', B: '2', C: '3' });
    expect(new Set(r.map((x) => x.key)).size).toBe(3);
  });

  it('returns no rows for a missing or empty env', () => {
    expect(rowsFromEnv(undefined)).toEqual([]);
    expect(rowsFromEnv({})).toEqual([]);
  });
});

describe('addRow / updateRow / removeRow', () => {
  it('appends a blank row with a key no other row has', () => {
    const before = rowsFromEnv({ A: '1', B: '2' });
    const after = addRow(removeRow(before, nth(before, 0).key));
    expect(after).toHaveLength(2);
    expect(nth(after, 1)).toMatchObject({ name: '', value: '' });
    expect(nth(after, 1).key).not.toBe(nth(after, 0).key);
    expect(addRow([])).toHaveLength(1);
  });

  it('updates only the targeted row', () => {
    const before = rowsFromEnv({ A: '1', B: '2' });
    const after = updateRow(before, nth(before, 1).key, { value: 'two' });
    expect(after.map((x) => [x.name, x.value])).toEqual([
      ['A', '1'],
      ['B', 'two'],
    ]);
    expect(nth(before, 1).value).toBe('2');
  });

  it('removes only the targeted row', () => {
    const before = rowsFromEnv({ A: '1', B: '2', C: '3' });
    expect(removeRow(before, nth(before, 1).key).map((x) => x.name)).toEqual(['A', 'C']);
  });
});

describe('rowProblems', () => {
  it('accepts valid names and an empty value', () => {
    expect(rowProblems(rows(['API_URL', 'x'], ['_a1', ''], ['a'.repeat(255), 'v']))).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('flags names the shared rule rejects', () => {
    expect(rowProblems(rows(['MY-VAR', 'x'], ['1FOO', 'x'], ['a'.repeat(256), 'x']))).toEqual([
      'invalid',
      'invalid',
      'too-long',
    ]);
  });

  it('flags __proto__ as reserved', () => {
    expect(rowProblems(rows(['__proto__', 'x'], ['__PROTO__', 'y']))).toEqual(['reserved', null]);
  });

  it('flags the reserved METAIDE_ prefix in any case', () => {
    expect(rowProblems(rows(['METAIDE_HOOK_TOKEN', 'x'], ['metaide_x', 'x']))).toEqual([
      'reserved',
      'reserved',
    ]);
  });

  it('flags every row of a case-sensitive duplicate, not differently-cased names', () => {
    expect(rowProblems(rows(['FOO', '1'], ['foo', '2'], ['FOO', '3'], ['BAR', '4']))).toEqual([
      'duplicate',
      null,
      'duplicate',
      null,
    ]);
  });

  it('flags a NUL character in the value', () => {
    expect(rowProblems(rows(['A', 'x\0y'], ['B', 'xy']))).toEqual(['nul', null]);
  });

  it('treats an empty name with a value as invalid', () => {
    expect(rowProblems(rows(['', 'orphan']))).toEqual(['invalid']);
  });

  it('ignores an all-blank row, including for duplicates', () => {
    expect(rowProblems(rows(['', ''], ['', ''], ['A', '1']))).toEqual([null, null, null]);
  });
});

describe('canSave', () => {
  it('is true when no row has a problem', () => {
    expect(canSave(rows(['A', '1'], ['', '']))).toBe(true);
    expect(canSave([])).toBe(true);
  });

  it('is false when any row has a problem', () => {
    expect(canSave(rows(['A', '1'], ['B-C', '2']))).toBe(false);
    expect(canSave(rows(['A', '1'], ['A', '2']))).toBe(false);
    expect(canSave(rows(['A', '\0']))).toBe(false);
  });
});

describe('rowsToEnv', () => {
  it('maps rows to an env in row order', () => {
    const env = rowsToEnv(rows(['Z', '1'], ['A', ''], ['M', '3']));
    expect(Object.entries(env)).toEqual([
      ['Z', '1'],
      ['A', ''],
      ['M', '3'],
    ]);
  });

  it('drops all-blank rows', () => {
    expect(rowsToEnv(rows(['', ''], ['A', '1'], ['', '']))).toEqual({ A: '1' });
  });

  it('omits rows the user removed', () => {
    const before = rowsFromEnv({ A: '1', B: '2' });
    expect(rowsToEnv(removeRow(before, nth(before, 0).key))).toEqual({ B: '2' });
  });
});

describe('isDraftDirty', () => {
  const stored = { A: '1', B: '2' };

  it('is clean for rows identical to the stored map', () => {
    expect(isDraftDirty(rowsFromEnv(stored), stored)).toBe(false);
    expect(isDraftDirty([], {})).toBe(false);
  });

  it('is clean when only a blank row was added', () => {
    expect(isDraftDirty(addRow(rowsFromEnv(stored)), stored)).toBe(false);
  });

  it('is dirty when a value was edited', () => {
    const r = rowsFromEnv(stored);
    expect(isDraftDirty(updateRow(r, nth(r, 1).key, { value: '3' }), stored)).toBe(true);
  });

  it('is dirty when a name was edited', () => {
    const r = rowsFromEnv(stored);
    expect(isDraftDirty(updateRow(r, nth(r, 0).key, { name: 'C' }), stored)).toBe(true);
  });

  it('is dirty when a row was removed', () => {
    const r = rowsFromEnv(stored);
    expect(isDraftDirty(removeRow(r, nth(r, 1).key), stored)).toBe(true);
  });

  it('is dirty when a row was added, even with an invalid name', () => {
    expect(isDraftDirty(rows(['A', '1'], ['B', '2'], ['MY-VAR', 'x']), stored)).toBe(true);
    expect(isDraftDirty(rows(['A', '1'], ['B', '2'], ['', 'orphan']), stored)).toBe(true);
  });

  it('is dirty when rows were reordered', () => {
    expect(isDraftDirty(rows(['B', '2'], ['A', '1']), stored)).toBe(true);
  });

  it('is dirty when a duplicate row repeats a stored entry', () => {
    expect(isDraftDirty(rows(['A', '1'], ['B', '2'], ['B', '2']), stored)).toBe(true);
  });
});
