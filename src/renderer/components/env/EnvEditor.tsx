/**
 * The editable env variables body shared by the project Env tab and Settings
 * → Environment: heading, notices, empty state, masked name/value rows, Add,
 * and Discard/Save, plus a slot below the actions. It owns the draft and
 * focus logic; loading, persisting, reveal state and copying are the
 * caller's, so it never talks to main.
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { toast } from '@renderer/hooks/useToasts';
import type { EnvDraftKey, EnvDrafts } from '@renderer/hooks/useEnvDrafts';
import type { RevealState } from '@renderer/hooks/useRevealState';
import { rowRevealKey } from '@renderer/env-reveal';
import { APP_ENV_COPY, APP_ENV_TESTIDS, ENV_COPY, ENV_TESTIDS } from '@renderer/project-env-copy';
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
import {
  ENV_FOCUS_RING,
  ENV_ICON_BUTTON,
  ENV_INPUT_CLASS,
  ENV_RAW_TEXT,
  EnvValueField,
  type EnvValueLabels,
} from './EnvValueField';

export type EnvLoad = 'loading' | 'ready' | 'failed';

/** Where an editor's rows come from and go: its draft slot, the stored map and its load state, and `persist`, which saves a map and adopts it as stored or rejects with a key-only reason. */
export interface EnvSource {
  draftKey: EnvDraftKey;
  drafts: EnvDrafts;
  stored: Record<string, string>;
  load: EnvLoad;
  persist: (env: Record<string, string>) => Promise<void>;
}

type RowPatch = Partial<Omit<EnvRow, 'key'>>;

/** Per-row callbacks: reveal state keyed `row:<key>`, copy of the raw value, edit and remove by row key. */
export interface EnvRowActions {
  reveal: RevealState;
  onCopy: (value: string) => void;
  onChange: (key: number, patch: RowPatch) => void;
  onRemove: (key: number) => void;
}

interface RowProps {
  row: EnvRow;
  n: number;
  problem: EnvRowProblem | null;
  reasonId: string;
  actions: EnvRowActions;
}

interface Props {
  source: EnvSource;
  scope: 'project' | 'app';
  subtitle: string;
  reveal: RevealState;
  onCopy: (value: string) => void;
  children?: ReactNode;
}

interface ActionsProps {
  saveDisabled: boolean;
  onDiscard: () => void;
  onSave: () => void;
}

type PendingFocus = { kind: 'row'; key: number } | { kind: 'add' } | null;
type SetRows = (next: EnvRow[]) => void;

const SCOPES = {
  project: {
    title: ENV_COPY.panelTitle,
    emptyState: ENV_COPY.emptyState,
    panelTestId: ENV_TESTIDS.panel,
    emptyTestId: ENV_TESTIDS.empty,
    section: 'flex-1 min-h-0 overflow-y-auto',
    body: 'max-w-3xl mx-auto p-5 space-y-4',
    heading: 'font-semibold text-[--text]',
    subtitle: 'text-xs text-[--text-muted] truncate mt-0.5',
  },
  app: {
    title: APP_ENV_COPY.panelTitle,
    emptyState: APP_ENV_COPY.emptyState,
    panelTestId: APP_ENV_TESTIDS.panel,
    emptyTestId: APP_ENV_TESTIDS.empty,
    section: '',
    body: 'space-y-4',
    heading: 'text-lg font-semibold',
    subtitle: 'text-sm text-[--text-muted] mt-1',
  },
} as const;

function focusTarget(row: EnvRow | undefined): PendingFocus {
  return row ? { kind: 'row', key: row.key } : { kind: 'add' };
}

/** An IPC error's message without the leading `Error: `, for a toast detail (main's messages name keys, never values). */
export function envErrorDetail(e: unknown): string {
  return String(e).replace(/^Error:\s*/, '');
}

function rowValueLabels(n: number): EnvValueLabels {
  return {
    value: ENV_COPY.valueLabel(n),
    reveal: ENV_COPY.revealLabel(n),
    hide: ENV_COPY.hideLabel(n),
    copy: ENV_COPY.copyLabel(n),
  };
}

/** One editable row: name, masked value with reveal and copy, then remove, and the row's reason under them. */
export function EnvRowEditor({ row, n, problem, reasonId, actions }: RowProps) {
  const valueBad = problem === 'nul';
  const nameBad = problem !== null && !valueBad;
  const revealKey = rowRevealKey(row.key);
  return (
    <li className="space-y-1" data-testid={ENV_TESTIDS.row}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          value={row.name}
          onChange={(e) => actions.onChange(row.key, { name: e.target.value })}
          aria-label={ENV_COPY.nameLabel(n)}
          aria-invalid={nameBad || undefined}
          aria-describedby={nameBad ? reasonId : undefined}
          {...ENV_RAW_TEXT}
          data-row-key={row.key}
          className={`${ENV_INPUT_CLASS} ${nameBad ? 'border-[--danger]' : 'border-[--border]'} sm:w-[38%] sm:flex-none`}
          data-testid={ENV_TESTIDS.name}
        />
        <div className="flex min-w-0 items-center gap-1 sm:flex-1">
          <EnvValueField
            value={row.value}
            labels={rowValueLabels(n)}
            revealed={actions.reveal.isRevealed(revealKey)}
            onToggle={() => actions.reveal.toggle(revealKey)}
            onCopy={() => actions.onCopy(row.value)}
            onChange={(value) => actions.onChange(row.key, { value })}
            reasonId={valueBad ? reasonId : undefined}
            testId={ENV_TESTIDS.value}
          />
          <button
            type="button"
            onClick={() => actions.onRemove(row.key)}
            aria-label={ENV_COPY.removeLabel(n)}
            className={`${ENV_ICON_BUTTON} hover:text-[--danger]`}
            data-testid={ENV_TESTIDS.remove}
          >
            <RemoveIcon />
          </button>
        </div>
      </div>
      {problem && (
        <p id={reasonId} className="text-xs text-[--danger]" data-testid={ENV_TESTIDS.reason}>
          {ENV_COPY.reason[problem]}
        </p>
      )}
    </li>
  );
}

// useLayoutEffect runs before paint; the static-markup unit renders have no DOM, where it only warns.
const useBeforePaintEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

/** Moves focus to a row's name input or the Add button after the render that follows `request`. */
function usePendingFocus(panel: React.RefObject<HTMLElement>, add: React.RefObject<HTMLElement>) {
  const [pending, request] = useState<PendingFocus>(null);
  useBeforePaintEffect(() => {
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
        className={`text-sm px-3 py-1.5 rounded-md border border-[--border] hover:bg-[--panel] ${ENV_FOCUS_RING}`}
        data-testid={ENV_TESTIDS.discard}
      >
        {ENV_COPY.discard}
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={saveDisabled}
        className={`text-sm px-4 py-1.5 rounded-md font-medium pressable bg-[color:var(--accent)] text-[--accent-text] hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed ${ENV_FOCUS_RING} focus-visible:ring-offset-2 focus-visible:ring-offset-[--panel-strong]`}
        data-testid={ENV_TESTIDS.save}
      >
        {ENV_COPY.save}
      </button>
    </div>
  );
}

/** Saves `rows` through `source.persist`, then drops the draft and masks every value, since the rows re-key from the new stored map. A failure toasts the key-only reason and keeps the draft and reveal state. */
export async function saveEnvRows(
  rows: EnvRow[],
  source: EnvSource,
  reveal: RevealState,
): Promise<void> {
  try {
    await source.persist(rowsToEnv(rows));
  } catch (e) {
    toast(ENV_COPY.saveFailed, { kind: 'error', detail: envErrorDetail(e) });
    return;
  }
  source.drafts.clear(source.draftKey);
  reveal.clearAll();
}

/** `saveEnvRows`, ignoring a second Save while one is in flight. */
function useSaveEnv(source: EnvSource, reveal: RevealState) {
  const savingRef = useRef(false);
  return async (rows: EnvRow[]) => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      await saveEnvRows(rows, source, reveal);
    } finally {
      savingRef.current = false;
    }
  };
}

function sameEntries(a: Record<string, string>, b: Record<string, string>): boolean {
  const ea = Object.entries(a);
  const eb = Object.entries(b);
  return ea.length === eb.length && ea.every(([k, v], i) => eb[i]?.[0] === k && eb[i]?.[1] === v);
}

/** Masks every value when the rows on screen come from the stored map (`hasDraft` false) and `next` differs from `prev` in any entry or in order, since the rows then re-key. An equal map in a new object masks nothing. */
export function maskIfStoredRekeyed(
  prev: Record<string, string>,
  next: Record<string, string>,
  hasDraft: boolean,
  reveal: RevealState,
): void {
  if (!hasDraft && !sameEntries(prev, next)) reveal.clearAll();
}

/** Runs `maskIfStoredRekeyed` before paint whenever `stored` changes, so a re-keyed row is never painted revealed. */
export function useMaskOnStoredChange(
  stored: Record<string, string>,
  hasDraft: boolean,
  reveal: RevealState,
) {
  const prev = useRef(stored);
  useBeforePaintEffect(() => {
    maskIfStoredRekeyed(prev.current, stored, hasDraft, reveal);
    prev.current = stored;
  }, [stored, hasDraft, reveal]);
}

/** Drops the draft and masks every value, since the stored rows it falls back to reuse the draft's row keys. */
export function discardEnvDraft(source: EnvSource, reveal: RevealState): void {
  source.drafts.clear(source.draftKey);
  reveal.clearAll();
}

/** Add and remove, moving focus to the new row, the next row, or Add; a removed row's reveal is dropped so a later row reusing its key starts masked. */
export function rowActions(
  rows: EnvRow[],
  setRows: SetRows,
  requestFocus: (f: PendingFocus) => void,
  reveal: RevealState,
) {
  return {
    onAdd: () => {
      const next = addRow(rows);
      setRows(next);
      requestFocus(focusTarget(next.at(-1)));
    },
    onRemove: (key: number) => {
      const at = rows.findIndex((r) => r.key === key);
      const next = removeRow(rows, key);
      reveal.hide(rowRevealKey(key));
      setRows(next);
      requestFocus(focusTarget(next[Math.min(at, next.length - 1)]));
    },
  };
}

/**
 * State behind an editor: the rows shown (the draft, else the stored rows)
 * and the edit, save and discard actions. An edit records the draft against
 * the stored map; while that load is pending or has failed it keeps the
 * draft's earlier baseline, so the unsaved marker never compares against an
 * empty map.
 */
function useEnvEditor(source: EnvSource, reveal: RevealState) {
  const { draftKey, drafts, stored, load } = source;
  const storedRows = useMemo(() => rowsFromEnv(stored), [stored]);
  const panelRef = useRef<HTMLElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const requestFocus = usePendingFocus(panelRef, addRef);
  const draft = drafts.get(draftKey);
  useMaskOnStoredChange(stored, draft !== undefined, reveal);
  const rows = draft?.rows ?? storedRows;
  const baseline = load === 'ready' ? stored : (draft?.stored ?? stored);
  const setRows: SetRows = (next) => drafts.set(draftKey, { stored: baseline, rows: next });
  const save = useSaveEnv(source, reveal);
  return {
    rows,
    problems: rowProblems(rows),
    panelRef,
    addRef,
    saveDisabled: load !== 'ready' || !canSave(rows),
    onChange: (key: number, patch: RowPatch) => setRows(updateRow(rows, key, patch)),
    ...rowActions(rows, setRows, requestFocus, reveal),
    onSave: () => void save(rows),
    onDiscard: () => discardEnvDraft(source, reveal),
  };
}

type Look = (typeof SCOPES)[keyof typeof SCOPES];

function EnvHeading({
  titleId,
  look,
  subtitle,
}: {
  titleId: string;
  look: Look;
  subtitle: string;
}) {
  return (
    <div className="min-w-0">
      <h2 id={titleId} className={look.heading}>
        {look.title}
      </h2>
      <p className={look.subtitle}>{subtitle}</p>
    </div>
  );
}

interface RowsListProps {
  rows: EnvRow[];
  problems: Array<EnvRowProblem | null>;
  idPrefix: string;
  actions: EnvRowActions;
}

function EnvRowsList({ rows, problems, idPrefix, actions }: RowsListProps) {
  if (rows.length === 0) return null;
  return (
    <ul className="space-y-2">
      {rows.map((row, i) => (
        <EnvRowEditor
          key={row.key}
          row={row}
          n={i + 1}
          problem={problems[i] ?? null}
          reasonId={`${idPrefix}reason-${row.key}`}
          actions={actions}
        />
      ))}
    </ul>
  );
}

interface AddButtonProps {
  buttonRef: React.RefObject<HTMLButtonElement>;
  disabled: boolean;
  onAdd: () => void;
}

function EnvAddButton({ buttonRef, disabled, onAdd }: AddButtonProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onAdd}
      disabled={disabled}
      className={`text-sm px-3 py-1.5 rounded-md border border-[--border] text-[--text] hover:bg-[--panel] disabled:opacity-50 ${ENV_FOCUS_RING}`}
      data-testid={ENV_TESTIDS.add}
    >
      <span aria-hidden>+ </span>
      {ENV_COPY.addRow}
    </button>
  );
}

function onPanelKeyDown(e: React.KeyboardEvent) {
  if (e.key === 'Enter' && e.target instanceof HTMLInputElement) e.preventDefault();
}

/**
 * An env variables editor for `scope` ('project' tab or 'app' Settings
 * section), which picks its title, empty state, test ids and layout.
 * `subtitle` sits under the title. Edits live in `source.drafts` until Save
 * (through `source.persist`) or Discard. Values are masked unless `reveal`
 * says otherwise; `onCopy` receives a row's raw value. `children` render
 * below Save/Discard. Enter in an input does nothing.
 */
export function EnvEditor({ source, scope, subtitle, reveal, onCopy, children }: Props) {
  const editor = useEnvEditor(source, reveal);
  const id = useId();
  const look = SCOPES[scope];
  const actions: EnvRowActions = {
    reveal,
    onCopy,
    onChange: editor.onChange,
    onRemove: editor.onRemove,
  };
  return (
    <section
      ref={editor.panelRef}
      aria-labelledby={`${id}title`}
      onKeyDown={onPanelKeyDown}
      className={look.section}
      data-testid={look.panelTestId}
    >
      <div className={look.body}>
        <EnvHeading titleId={`${id}title`} look={look} subtitle={subtitle} />
        <EnvNotices />
        {source.load === 'ready' && editor.rows.length === 0 && (
          <p className="text-sm text-[--text-muted]" data-testid={look.emptyTestId}>
            {look.emptyState}
          </p>
        )}
        <EnvRowsList
          rows={editor.rows}
          problems={editor.problems}
          idPrefix={id}
          actions={actions}
        />
        <EnvAddButton
          buttonRef={editor.addRef}
          disabled={source.load !== 'ready'}
          onAdd={editor.onAdd}
        />
        <EnvActions
          saveDisabled={editor.saveDisabled}
          onDiscard={editor.onDiscard}
          onSave={editor.onSave}
        />
        {children}
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
