/**
 * Command palette contract: the types, user-facing copy, test ids, group order and caps that the
 * palette component, App wiring, unit tests and e2e suite all agree on. Change a value here and
 * every consumer follows; never restate a string or test id in a consumer.
 */
import { AGGREGATE_STATE_LABEL } from '@shared/agent-state';
import type { Project } from '@shared/types';
import type { ShortcutPlatform } from './shortcut-contract';
import { SHORTCUT_COPY } from './shortcut-copy';

/** Search mode, chosen by the first character of the query. */
export type PaletteMode = 'all' | 'projects' | 'commands' | 'files';

/** Prefix the palette's query is seeded with when it opens (⌘K '', ⌘⇧P '>', ⌘P '@'). */
export type PaletteSeed = '' | '>' | '@';

/**
 * An open request from App. A new `seq` resets the query to `seed` and the highlight to the
 * first row, so ⌘⇧P / ⌘P re-seed a palette that is already open. `null` means closed.
 */
export interface PaletteRequest {
  readonly seq: number;
  readonly seed: PaletteSeed;
}

export type PaletteCategory = 'Go' | 'Project' | 'View' | 'Shell' | 'Theme' | 'App' | 'Settings';

export interface PaletteCommand {
  readonly id: string;
  readonly title: string;
  readonly category: PaletteCategory;
  /** Shortcut label such as "⌘P". */
  readonly hint?: string;
  /** Hidden when no project is selected (AC12). */
  readonly needsProject?: boolean;
  readonly run: () => void | Promise<void>;
}

/** `running` holds the projects with a live shell, `projects` the rest. */
export type PaletteGroupId = 'running' | 'projects' | PaletteCategory | 'files';

/** Fixed group order (AC6). Files mode has a single `files` group. */
export const GROUP_ORDER: readonly PaletteGroupId[] = ['running', 'projects', 'Go', 'Project', 'View', 'Shell', 'Theme', 'App', 'Settings'];

/** Most rows rendered in the all, projects and commands modes (AC13). */
export const PALETTE_ROW_CAP = 50;
/** Most rows rendered in files mode (AC34). */
export const PALETTE_FILE_CAP = 40;
/** File-list size requested from `files:list-all` (AC34). */
export const PALETTE_FILE_LIMIT = 5000;

export interface PaletteFileEntry {
  readonly relPath: string;
  readonly name: string;
}

/** The async file provider's state (AC34, AC36). */
export type PaletteFilesState =
  | { readonly status: 'idle' }
  | { readonly status: 'no-project' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly files: readonly PaletteFileEntry[]; readonly truncated: boolean }
  | { readonly status: 'error' };

export type PaletteRow =
  | { readonly kind: 'project'; readonly project: Project; readonly current: boolean }
  | { readonly kind: 'command'; readonly command: PaletteCommand }
  | { readonly kind: 'file'; readonly file: PaletteFileEntry };

export interface PaletteGroup {
  readonly id: PaletteGroupId;
  readonly title: string;
  readonly rows: readonly PaletteRow[];
}

/** Why the list is empty; the copy for each lives in `PALETTE_COPY.empty`. */
export type PaletteEmpty =
  | { readonly kind: 'no-results'; readonly query: string }
  | { readonly kind: 'no-projects-match'; readonly query: string }
  | { readonly kind: 'no-projects' }
  | { readonly kind: 'no-commands-match'; readonly query: string }
  | { readonly kind: 'no-files-match'; readonly query: string }
  | { readonly kind: 'files-no-project' }
  | { readonly kind: 'files-loading' }
  | { readonly kind: 'files-error' };

export interface PaletteView {
  readonly mode: PaletteMode;
  readonly groups: readonly PaletteGroup[];
  /** Every row in display order, without headings; the highlight indexes into this. */
  readonly rows: readonly PaletteRow[];
  readonly empty: PaletteEmpty | null;
  /** The file index hit `PALETTE_FILE_LIMIT` (AC34). */
  readonly truncatedFiles: boolean;
}

export interface ParsedPaletteQuery {
  readonly mode: PaletteMode;
  /** The query after the prefix, leading spaces removed. */
  readonly text: string;
}

/** Inputs to the search: every provider's current items. */
export interface PaletteSearchInput {
  readonly projects: readonly Project[];
  readonly currentProjectId: number | null;
  /** Projects with a live shell; they go in the `running` group. */
  readonly aliveIds: ReadonlySet<number>;
  /** Already filtered for project-dependent commands (AC12). */
  readonly commands: readonly PaletteCommand[];
  readonly files: PaletteFilesState;
}

export type ParsePaletteQuery = (raw: string) => ParsedPaletteQuery;
export type SearchPalette = (parsed: ParsedPaletteQuery, input: PaletteSearchInput) => PaletteView;
export type RunSafely = (run: () => void | Promise<void>, onError: (error: unknown) => void) => Promise<void>;

/** What App's global keydown does with a key while the palette is open or closed. */
export type PaletteKeyAction =
  | { readonly kind: 'toggle' }
  | { readonly kind: 'open'; readonly seed: '>' | '@' }
  | { readonly kind: 'swallow' }
  | { readonly kind: 'pass' };

export interface PaletteKeyEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

export type PaletteKeyActionFn = (e: PaletteKeyEvent, isOpen: boolean, platform?: ShortcutPlatform) => PaletteKeyAction;

export interface CommandPaletteProps {
  /** `null` = closed. */
  readonly request: PaletteRequest | null;
  readonly commands: readonly PaletteCommand[];
  readonly currentProject: Project | null;
  readonly onPickProject: (project: Project) => void;
  /** The already-current project was picked: focus its terminal once the palette has closed (AC8, R13). */
  readonly onPickCurrent: (project: Project) => void;
  readonly onPickFile: (relPath: string) => void;
  readonly onClose: () => void;
}

export const PALETTE_COPY = {
  placeholder: 'Search projects, commands and settings…',
  inputLabel: 'Search projects, commands and settings',
  groupTitles: {
    running: 'Running',
    projects: 'Projects',
    Go: 'Go',
    Project: 'Project',
    View: 'View',
    Shell: 'Shell',
    Theme: 'Theme',
    App: 'App',
    Settings: 'Settings',
    files: 'Files',
  } satisfies Record<PaletteGroupId, string>,
  current: 'Current',
  /** Generic severity for a running project, irrespective of its agents. */
  projectStatus: AGGREGATE_STATE_LABEL,
  /** Label of the open hint on the highlighted project row. */
  openHint: 'Open',
  /** The chip in the search row naming the prefix mode; the normal mode has none. */
  modeChip: { projects: 'Projects', commands: 'Commands', files: 'Files' },
  /** Accessible-name suffix on the current project's row. */
  currentLabel: 'current project',
  settingsPrefix: 'Settings: ',
  newTerminal: 'New terminal',
  newTerminalWindow: 'New terminal in a new window',
  empty: {
    noResults: (q: string) => `No results for “${q}”`,
    noProjectsMatch: (q: string) => `No projects match “${q}”`,
    noProjects: 'No projects yet.',
    noCommandsMatch: (q: string) => `No commands match “${q}”`,
    noFilesMatch: (q: string) => `No files match “${q}”`,
    filesNoProject: 'Open a project to search its files.',
    filesLoading: 'Indexing…',
    filesError: 'Could not list files.',
  },
  cappedTitle: `Index capped at ${PALETTE_FILE_LIMIT} files.`,
  keyHints: { navigate: 'Navigate', open: 'Open', close: 'Close' },
  legend: [
    { prefix: '@', label: 'Files' },
    { prefix: '#', label: 'Projects' },
    { prefix: '>', label: 'Commands' },
  ],
  /** Mac value, kept for existing callers; components use `SHORTCUT_COPY.statusHintKey(platform)`. */
  statusHintKey: SHORTCUT_COPY.statusHintKey('mac'),
  statusHintText: 'command palette',
  /** Mac value, kept for existing callers; components use `SHORTCUT_COPY.statusHintLabel(platform)`. */
  statusHintLabel: SHORTCUT_COPY.statusHintLabel('mac'),
  commandFailed: 'Command failed',
} as const;

export const PALETTE_TESTIDS = {
  root: 'command-palette',
  scrim: 'command-palette-scrim',
  panel: 'command-palette-panel',
  input: 'command-palette-input',
  listbox: 'command-palette-listbox',
  group: 'command-palette-group',
  option: 'command-palette-option',
  current: 'command-palette-current',
  projectStatus: 'command-palette-project-status',
  modeChip: 'command-palette-mode-chip',
  projectRoot: 'command-palette-project-root',
  empty: 'command-palette-empty',
  legend: 'command-palette-legend',
  capped: 'command-palette-capped',
  statusHint: 'status-bar-palette-hint',
} as const;
