/**
 * The ⌘K command palette: projects, commands, Settings sections and (with "@") files in one
 * searchable list, rendered through `ModalFrame` on the palette tier with no motion. `request`
 * opens it (null = closed); every new `request.seq` resets the query to `request.seed` with the
 * caret at the end and the highlight on the first row. It records the focused element on open and,
 * on close, restores it as `restoresOpenerOnClose` decides (AC2). Picks go to `onPickProject`,
 * `onPickCurrent` or `onPickFile`; commands run after `onClose`, with an error toast if they fail (AC16).
 */
import { useEffect, useId, useMemo, useRef, useState, type MutableRefObject } from 'react';
import {
  PALETTE_COPY,
  PALETTE_TESTIDS,
  type CommandPaletteProps,
  type PaletteMode,
  type PaletteRequest,
  type PaletteRow,
} from '@renderer/command-palette-contract';
import { useAliveShellIds } from '@renderer/hooks/useAliveShellIds';
import { usePaletteFiles } from '@renderer/hooks/usePaletteFiles';
import { useProjects } from '@renderer/hooks/useProjects';
import { useRoots } from '@renderer/hooks/useRoots';
import { toast } from '@renderer/hooks/useToasts';
import { parsePaletteQuery } from '@renderer/palette-query';
import { restoresOpenerOnClose, runPaletteRow } from '@renderer/palette-run';
import { searchPalette, stepHighlight } from '@renderer/palette-search';
import { ModalFrame } from './ModalFrame';
import { SearchIcon } from './palette/category-icons';
import { PaletteFooter } from './palette/PaletteFooter';
import { PaletteList, listboxId, optionId } from './palette/PaletteList';
import { restoreFocus } from './settings/dialog-focus';

function reportCommandError(error: unknown): void {
  toast(PALETTE_COPY.commandFailed, { kind: 'error', detail: String(error).replace(/^Error:\s*/, '') });
}

type PickedRef = MutableRefObject<PaletteRow['kind'] | null>;

/**
 * Remembers the focused element when `open` turns true; when it turns false, gives focus back if
 * `restoresOpenerOnClose` says so. Returns the ref a pick records its row kind in before closing.
 */
function useRestoreFocus(open: boolean): PickedRef {
  const opener = useRef<HTMLElement | null>(null);
  const picked: PickedRef = useRef(null);
  useEffect(() => {
    if (open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      picked.current = null;
      return;
    }
    const active = document.activeElement;
    if (restoresOpenerOnClose(picked.current, active === null || active === document.body)) restoreFocus(opener.current);
    opener.current = null;
  }, [open]);
  return picked;
}

/** Query and highlight state, reset from the seed whenever a new request arrives (AC37, AC43). */
function useSeededQuery(request: PaletteRequest | null) {
  const [query, setQuery] = useState<string>(request?.seed ?? '');
  const [active, setActive] = useState(0);
  const [seededSeq, setSeededSeq] = useState(request?.seq);
  const inputRef = useRef<HTMLInputElement>(null);
  if (request && request.seq !== seededSeq) {
    setSeededSeq(request.seq);
    setQuery(request.seed);
    setActive(0);
  }
  const seq = request?.seq;
  useEffect(() => {
    const el = inputRef.current;
    if (seq === undefined || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [seq]);
  return { query, setQuery, active, setActive, inputRef };
}

interface PaletteViewDeps {
  readonly open: boolean;
  readonly query: string;
  readonly commands: CommandPaletteProps['commands'];
  readonly currentProjectId: number | null;
}

/** Every provider (projects refreshed on open, alive shells, roots, lazily loaded files) searched into a view. */
function usePaletteView({ open, query, commands, currentProjectId }: PaletteViewDeps) {
  const { projects, refresh } = useProjects();
  const { aliveIds } = useAliveShellIds();
  const { roots } = useRoots();
  const rootsById = useMemo(() => new Map(roots.map((r) => [r.id, r])), [roots]);
  const parsed = useMemo(() => parsePaletteQuery(query), [query]);
  const files = usePaletteFiles(open, parsed.mode === 'files', currentProjectId);
  const view = useMemo(
    () => searchPalette(parsed, { projects, currentProjectId, aliveIds, commands, files }),
    [parsed, projects, currentProjectId, aliveIds, commands, files],
  );
  useEffect(() => {
    if (open) refresh().catch((e: unknown) => console.error('[palette] projects:list failed', e));
  }, [open, refresh]);
  return { view, aliveIds, rootsById };
}

interface PaletteActionsDeps extends Pick<CommandPaletteProps, 'onClose' | 'onPickProject' | 'onPickCurrent' | 'onPickFile'> {
  readonly rows: readonly PaletteRow[];
  readonly activeIndex: number;
  readonly setActive: (index: number) => void;
  readonly picked: PickedRef;
}

/** `pick(index)` runs a row, recording its kind for the close-time focus decision; `onKeyDown` drives the highlight (AC3, AC14). */
function usePaletteActions({ rows, activeIndex, setActive, picked, ...handlers }: PaletteActionsDeps) {
  const pick = (index: number): void => {
    const row = rows[index];
    if (!row) return;
    picked.current = row.kind;
    void runPaletteRow(row, { ...handlers, onCommandError: reportCommandError });
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    const step = e.nativeEvent.isComposing ? null : stepHighlight(e.key, activeIndex, rows.length);
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    if (step.kind === 'move') setActive(step.index);
    else if (step.kind === 'close') handlers.onClose();
    else pick(activeIndex);
  };
  return { pick, onKeyDown };
}

interface SearchFieldProps {
  readonly inputRef: React.RefObject<HTMLInputElement>;
  readonly query: string;
  readonly listboxId: string;
  readonly activeId: string | undefined;
  readonly truncatedFiles: boolean;
  readonly mode: PaletteMode;
  readonly onQuery: (query: string) => void;
  readonly onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

function SearchField({ inputRef, query, listboxId, activeId, truncatedFiles, mode, onQuery, onKeyDown }: SearchFieldProps): React.JSX.Element {
  return (
    <div className="flex h-[54px] shrink-0 items-center gap-3 pl-4 pr-3">
      <SearchIcon />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={activeId !== undefined}
        aria-controls={listboxId}
        aria-activedescendant={activeId}
        aria-autocomplete="list"
        aria-label={PALETTE_COPY.inputLabel}
        placeholder={PALETTE_COPY.placeholder}
        autoComplete="off"
        spellCheck={false}
        data-testid={PALETTE_TESTIDS.input}
        className="min-w-0 flex-1 bg-transparent text-[16px] tracking-[-0.01em] outline-none focus-visible:outline-none placeholder:text-[--modal-text-muted]"
      />
      {truncatedFiles && (
        <span data-testid={PALETTE_TESTIDS.capped} className="shrink-0 text-[12px] text-[--modal-text-muted]">
          {PALETTE_COPY.cappedTitle}
        </span>
      )}
      {mode !== 'all' && (
        <span
          data-testid={PALETTE_TESTIDS.modeChip}
          className="shrink-0 rounded-md bg-[--modal-row-active] px-2 py-1 text-[12px] font-medium text-[--accent]"
        >
          {PALETTE_COPY.modeChip[mode]}
        </span>
      )}
    </div>
  );
}

export function CommandPalette({ request, commands, currentProject, onClose, ...picks }: CommandPaletteProps): React.JSX.Element | null {
  const open = request != null;
  const idPrefix = useId();
  const picked = useRestoreFocus(open);
  const { query, setQuery, active, setActive, inputRef } = useSeededQuery(request);
  const { view, aliveIds, rootsById } = usePaletteView({ open, query, commands, currentProjectId: currentProject?.id ?? null });
  const activeIndex = Math.min(active, Math.max(view.rows.length - 1, 0));
  const activeId = view.rows.length > 0 ? optionId(idPrefix, activeIndex) : undefined;
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);
  const { pick, onKeyDown } = usePaletteActions({ rows: view.rows, activeIndex, setActive, picked, onClose, ...picks });

  if (!open) return null;

  return (
    <ModalFrame
      testId={PALETTE_TESTIDS.root}
      tier="palette"
      motion="none"
      layerClassName="flex items-start justify-center pt-[18vh] [@media(max-height:700px)]:pt-[10vh]"
      onDismiss={onClose}
    >
      <div
        data-testid={PALETTE_TESTIDS.panel}
        className="modal-sheet modal-sheet--compact flex w-[min(640px,calc(100vw-32px))] flex-col overflow-hidden text-[--text]"
      >
        <SearchField
          inputRef={inputRef}
          query={query}
          listboxId={listboxId(idPrefix)}
          activeId={activeId}
          truncatedFiles={view.truncatedFiles}
          mode={view.mode}
          onQuery={(q) => { setQuery(q); setActive(0); }}
          onKeyDown={onKeyDown}
        />
        <PaletteList view={view} activeIndex={activeIndex} idPrefix={idPrefix} aliveIds={aliveIds} rootsById={rootsById} onHover={setActive} onPick={pick} />
        <PaletteFooter />
      </div>
    </ModalFrame>
  );
}
