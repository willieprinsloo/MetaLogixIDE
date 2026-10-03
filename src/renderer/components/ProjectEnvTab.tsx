import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';
import type { EnvDrafts } from '@renderer/hooks/useEnvDrafts';
import { ENV_COPY, ENV_TESTIDS } from '@renderer/project-env-copy';
import {
  addRow,
  canSave,
  removeRow,
  rowProblems,
  rowsFromEnv,
  rowsToEnv,
  updateRow,
  type EnvRow,
  type EnvRowProblem,
} from '@renderer/project-env-rows';

interface Props {
  projectId: number;
  projectName: string;
  drafts: EnvDrafts;
}

type RowPatch = Partial<Omit<EnvRow, 'key'>>;

interface RowProps {
  row: EnvRow;
  index: number;
  problem: EnvRowProblem | null;
  onChange: (key: number, patch: RowPatch) => void;
  onRemove: (key: number) => void;
}

interface RowListProps {
  rows: EnvRow[];
  problems: Array<EnvRowProblem | null>;
  onChange: (key: number, patch: RowPatch) => void;
  onRemove: (key: number) => void;
}

interface FieldProps {
  label: string;
  value: string;
  bad: boolean;
  reasonId: string;
  className: string;
  testId: string;
  rowKey?: number;
  onChange: (value: string) => void;
}

interface ActionsProps {
  saveDisabled: boolean;
  onDiscard: () => void;
  onSave: () => void;
}

type LoadState = 'loading' | 'ready' | 'failed';
type PendingFocus = { kind: 'row'; key: number } | { kind: 'add' } | null;
type SetRows = (next: EnvRow[]) => void;

function focusTarget(row: EnvRow | undefined): PendingFocus {
  return row ? { kind: 'row', key: row.key } : { kind: 'add' };
}

const TITLE_ID = 'project-env-title';
const INPUT_CLASS =
  'w-full min-w-0 font-mono bg-[--panel] text-[--text] border rounded-md px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[--accent]/60';
const FOCUS_RING = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-[--accent]';

function errorDetail(e: unknown): string {
  return String(e).replace(/^Error:\s*/, '');
}

function EnvField({
  label,
  value,
  bad,
  reasonId,
  className,
  testId,
  rowKey,
  onChange,
}: FieldProps) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      aria-invalid={bad || undefined}
      aria-describedby={bad ? reasonId : undefined}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      data-row-key={rowKey}
      className={`${INPUT_CLASS} ${bad ? 'border-[--danger]' : 'border-[--border]'} ${className}`}
      data-testid={testId}
    />
  );
}

function EnvRowEditor({ row, index, problem, onChange, onRemove }: RowProps) {
  const n = index + 1;
  const reasonId = `project-env-reason-${row.key}`;
  const valueBad = problem === 'nul';
  const nameBad = problem !== null && !valueBad;
  return (
    <li className="space-y-1" data-testid={ENV_TESTIDS.row}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <EnvField
          label={ENV_COPY.nameLabel(n)}
          value={row.name}
          bad={nameBad}
          reasonId={reasonId}
          rowKey={row.key}
          className="sm:w-[38%] sm:flex-none"
          testId={ENV_TESTIDS.name}
          onChange={(name) => onChange(row.key, { name })}
        />
        <EnvField
          label={ENV_COPY.valueLabel(n)}
          value={row.value}
          bad={valueBad}
          reasonId={reasonId}
          className="sm:flex-1"
          testId={ENV_TESTIDS.value}
          onChange={(value) => onChange(row.key, { value })}
        />
        <button
          type="button"
          onClick={() => onRemove(row.key)}
          aria-label={ENV_COPY.removeLabel(n)}
          className="self-end sm:self-auto shrink-0 w-8 h-8 flex items-center justify-center rounded-md text-[--text-muted] hover:text-[--danger] hover:bg-[--panel] focus:outline-none focus-visible:ring-2 focus-visible:ring-[--accent]"
          data-testid={ENV_TESTIDS.remove}
        >
          <RemoveIcon />
        </button>
      </div>
      {problem && (
        <p id={reasonId} className="text-xs text-[--danger]" data-testid={ENV_TESTIDS.reason}>
          {ENV_COPY.reason[problem]}
        </p>
      )}
    </li>
  );
}

function EnvRowList({ rows, problems, onChange, onRemove }: RowListProps) {
  if (rows.length === 0) return null;
  return (
    <ul className="space-y-2">
      {rows.map((row, i) => (
        <EnvRowEditor
          key={row.key}
          row={row}
          index={i}
          problem={problems[i] ?? null}
          onChange={onChange}
          onRemove={onRemove}
        />
      ))}
    </ul>
  );
}

/** Loads the project's stored env map fresh from main on mount; `load` reports progress and failure. */
function useStoredEnv(projectId: number): {
  stored: Record<string, string>;
  setStored: (env: Record<string, string>) => void;
  load: LoadState;
} {
  const [stored, setStored] = useState<Record<string, string>>({});
  const [load, setLoad] = useState<LoadState>('loading');
  useEffect(() => {
    let live = true;
    api
      .invoke('projects:list', undefined as never)
      .then(({ projects }) => {
        const project = projects.find((p) => p.id === projectId);
        if (!live) return;
        if (!project) throw new Error(`project ${projectId} not found`);
        setStored(project.config.env ?? {});
        setLoad('ready');
      })
      .catch((e: unknown) => {
        if (!live) return;
        setLoad('failed');
        toast(ENV_COPY.loadFailed, { kind: 'error', detail: errorDetail(e) });
      });
    return () => {
      live = false;
    };
  }, [projectId]);
  return { stored, setStored, load };
}

/** Moves focus to a row's name input or the Add button after the render that follows `request`. */
function usePendingFocus(panel: React.RefObject<HTMLElement>, add: React.RefObject<HTMLElement>) {
  const [pending, request] = useState<PendingFocus>(null);
  useLayoutEffect(() => {
    if (!pending) return;
    if (pending.kind === 'add') add.current?.focus();
    else
      panel.current
        ?.querySelector<HTMLInputElement>(`input[data-row-key="${pending.key}"]`)
        ?.focus();
    request(null);
  }, [pending, panel, add]);
  return request;
}

function EnvHeading({ projectName }: { projectName: string }) {
  return (
    <div className="min-w-0">
      <h2 id={TITLE_ID} className="font-semibold text-[--text]">
        {ENV_COPY.panelTitle}
      </h2>
      <p className="text-xs text-[--text-muted] truncate mt-0.5">{projectName}</p>
    </div>
  );
}

function EnvNotices() {
  return (
    <div className="space-y-1 text-xs leading-relaxed text-[--text-muted]">
      <p>{ENV_COPY.noticeNewShells}</p>
      <p className="text-[--text]">{ENV_COPY.noticeUnencrypted}</p>
      <p>{ENV_COPY.noticeLaunchArgs}</p>
      <p className="font-mono break-words">{ENV_COPY.tokensHint}</p>
    </div>
  );
}

function EnvActions({ saveDisabled, onDiscard, onSave }: ActionsProps) {
  return (
    <div className="flex items-center justify-end gap-2 border-t border-[--border] pt-4">
      <button
        type="button"
        onClick={onDiscard}
        className={`text-sm px-3 py-1.5 rounded-md border border-[--border] hover:bg-[--panel] ${FOCUS_RING}`}
        data-testid={ENV_TESTIDS.discard}
      >
        {ENV_COPY.discard}
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={saveDisabled}
        className={`text-sm px-4 py-1.5 rounded-md font-medium pressable bg-[color:var(--accent)] text-white hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS_RING} focus-visible:ring-offset-2 focus-visible:ring-offset-[--panel-strong]`}
        data-testid={ENV_TESTIDS.save}
      >
        {ENV_COPY.save}
      </button>
    </div>
  );
}

/**
 * Save for the Env tab: persists `{ env }` alone, then adopts it as stored
 * and drops the draft. A failure toasts (key names only) and keeps the draft.
 */
function useSaveEnv(
  projectId: number,
  drafts: EnvDrafts,
  adopt: (env: Record<string, string>) => void,
) {
  const savingRef = useRef(false);
  return async (rows: EnvRow[]) => {
    if (savingRef.current) return;
    savingRef.current = true;
    const env = rowsToEnv(rows);
    try {
      await api.invoke('projects:update-config', { id: projectId, config: { env } });
      adopt(env);
      drafts.clear(projectId);
    } catch (e) {
      toast(ENV_COPY.saveFailed, { kind: 'error', detail: errorDetail(e) });
    } finally {
      savingRef.current = false;
    }
  };
}

/** Add and remove for the Env tab, moving focus to the new row, the next row, or Add. */
function rowActions(rows: EnvRow[], setRows: SetRows, requestFocus: (f: PendingFocus) => void) {
  return {
    onAdd: () => {
      const next = addRow(rows);
      setRows(next);
      requestFocus(focusTarget(next.at(-1)));
    },
    onRemove: (key: number) => {
      const at = rows.findIndex((r) => r.key === key);
      const next = removeRow(rows, key);
      setRows(next);
      requestFocus(focusTarget(next[Math.min(at, next.length - 1)]));
    },
  };
}

/**
 * State behind the Env tab: the stored map (loaded fresh), the rows shown
 * (the project's draft, else the stored rows) and the edit, save and discard
 * actions. An edit records the draft against the freshly loaded stored map;
 * while that load is pending or has failed it keeps the draft's earlier
 * baseline, so the unsaved marker never compares against an empty map.
 */
function useEnvEditor(projectId: number, drafts: EnvDrafts) {
  const { stored, setStored, load } = useStoredEnv(projectId);
  const storedRows = useMemo(() => rowsFromEnv(stored), [stored]);
  const panelRef = useRef<HTMLElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const requestFocus = usePendingFocus(panelRef, addRef);
  const draft = drafts.get(projectId);
  const rows = draft?.rows ?? storedRows;
  const baseline = load === 'ready' ? stored : (draft?.stored ?? stored);
  const setRows: SetRows = (next) => drafts.set(projectId, { stored: baseline, rows: next });
  const save = useSaveEnv(projectId, drafts, setStored);
  return {
    load,
    rows,
    problems: rowProblems(rows),
    panelRef,
    addRef,
    saveDisabled: load !== 'ready' || !canSave(rows),
    onChange: (key: number, patch: RowPatch) => setRows(updateRow(rows, key, patch)),
    ...rowActions(rows, setRows, requestFocus),
    onSave: () => void save(rows),
    onDiscard: () => drafts.clear(projectId),
  };
}

function onPanelKeyDown(e: React.KeyboardEvent) {
  if (e.key === 'Enter' && e.target instanceof HTMLInputElement) e.preventDefault();
}

/**
 * The project's Env tab: edits its environment variables as name/value rows.
 * Stored values load fresh via `projects:list` on mount; edits live in the
 * project's entry in `drafts` (kept across tab and project switches) until
 * Save, which persists `{ env }` alone through `projects:update-config`, or
 * Discard, which drops the draft. A failed save toasts the main-process
 * reason (key names only, never values) and keeps the draft. Enter in an
 * input does nothing.
 */
export function ProjectEnvTab({ projectId, projectName, drafts }: Props) {
  const editor = useEnvEditor(projectId, drafts);
  return (
    <section
      ref={editor.panelRef}
      aria-labelledby={TITLE_ID}
      onKeyDown={onPanelKeyDown}
      className="flex-1 min-h-0 overflow-y-auto"
      data-testid={ENV_TESTIDS.panel}
    >
      <div className="max-w-3xl mx-auto p-5 space-y-4">
        <EnvHeading projectName={projectName} />
        <EnvNotices />
        {editor.load === 'ready' && editor.rows.length === 0 && (
          <p className="text-sm text-[--text-muted]" data-testid={ENV_TESTIDS.empty}>
            {ENV_COPY.emptyState}
          </p>
        )}
        <EnvRowList
          rows={editor.rows}
          problems={editor.problems}
          onChange={editor.onChange}
          onRemove={editor.onRemove}
        />
        <button
          ref={editor.addRef}
          type="button"
          onClick={editor.onAdd}
          disabled={editor.load !== 'ready'}
          className={`text-sm px-3 py-1.5 rounded-md border border-[--border] text-[--text] hover:bg-[--panel] disabled:opacity-50 ${FOCUS_RING}`}
          data-testid={ENV_TESTIDS.add}
        >
          <span aria-hidden>+ </span>
          {ENV_COPY.addRow}
        </button>
        <EnvActions
          saveDisabled={editor.saveDisabled}
          onDiscard={editor.onDiscard}
          onSave={editor.onSave}
        />
      </div>
    </section>
  );
}

function RemoveIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
