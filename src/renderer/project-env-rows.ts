/**
 * Pure row model behind the project environment variables editor: turns a
 * saved env map into editable rows (insertion order kept), edits rows
 * immutably, reports one problem per row using the shared name/value rules
 * plus case-sensitive duplicates, and maps rows back to the env map to save.
 * An all-blank row is never a problem, is dropped on save and never makes a
 * draft dirty. No React here.
 */
import {
  envNameProblem,
  envValueProblem,
  type EnvNameProblem,
  type EnvValueProblem,
} from '@shared/project-env';

export interface EnvRow {
  key: number;
  name: string;
  value: string;
}

export type EnvRowProblem = EnvNameProblem | EnvValueProblem | 'duplicate';

function isBlank(row: EnvRow): boolean {
  return row.name === '' && row.value === '';
}

/** Rows for a saved env map, in its insertion order; keys are unique within the result. */
export function rowsFromEnv(env: Readonly<Record<string, string>> | undefined): EnvRow[] {
  return Object.entries(env ?? {}).map(([name, value], key) => ({ key, name, value }));
}

/** `rows` with a blank row appended under a key no existing row uses. */
export function addRow(rows: readonly EnvRow[]): EnvRow[] {
  const key = rows.reduce((max, r) => Math.max(max, r.key), -1) + 1;
  return [...rows, { key, name: '', value: '' }];
}

/** `rows` with the row under `key` patched; other rows are returned as is. */
export function updateRow(
  rows: readonly EnvRow[],
  key: number,
  patch: Partial<Omit<EnvRow, 'key'>>,
): EnvRow[] {
  return rows.map((r) => (r.key === key ? { ...r, ...patch } : r));
}

/** `rows` without the row under `key`. */
export function removeRow(rows: readonly EnvRow[], key: number): EnvRow[] {
  return rows.filter((r) => r.key !== key);
}

/** One entry per row, in row order: why that row cannot be saved, or null. */
export function rowProblems(rows: readonly EnvRow[]): Array<EnvRowProblem | null> {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
  return rows.map((r) => {
    if (isBlank(r)) return null;
    const nameProblem = envNameProblem(r.name);
    if (nameProblem) return nameProblem;
    if ((counts.get(r.name) ?? 0) > 1) return 'duplicate';
    return envValueProblem(r.value);
  });
}

/** True when no row has a problem. */
export function canSave(rows: readonly EnvRow[]): boolean {
  return rowProblems(rows).every((p) => p === null);
}

/** The env map to persist: rows in order, all-blank rows dropped. */
export function rowsToEnv(rows: readonly EnvRow[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const r of rows) if (!isBlank(r)) env[r.name] = r.value;
  return env;
}

/**
 * True when the non-blank rows, in order and including invalid ones, differ
 * from the stored map's entries; all-blank rows are not a change.
 */
export function isDraftDirty(
  rows: readonly EnvRow[],
  stored: Readonly<Record<string, string>>,
): boolean {
  const edited = rows.filter((r) => !isBlank(r));
  const saved = Object.entries(stored);
  if (edited.length !== saved.length) return true;
  return edited.some((r, i) => r.name !== saved[i]?.[0] || r.value !== saved[i]?.[1]);
}
