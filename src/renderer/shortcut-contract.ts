/**
 * Keyboard shortcut contract: the platform model, key-event shape, decision-function signatures
 * and the platform-neutral SHORTCUTS registry that key routing, label formatting, components and
 * unit tests all agree on. `mod` is the platform modifier (⌘ on mac, Ctrl elsewhere); `ctrl` is
 * the physical Control key regardless of platform.
 */
export type ShortcutPlatform = 'mac' | 'win' | 'linux';

export interface ShortcutKeyLike {
  readonly key: string;
  readonly type?: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** Platform-neutral shortcut. `mod` = the platform modifier (⌘ on mac, Ctrl elsewhere); `ctrl` = physical Control. */
export interface ShortcutDef {
  readonly key: string;
  readonly mod?: boolean;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
}

export type FormatShortcutFn = (def: ShortcutDef, platform: ShortcutPlatform) => string;
export type IsPrimaryModFn = (e: ShortcutKeyLike, platform: ShortcutPlatform) => boolean;

export type AppShortcutAction =
  | 'toggle-sidebar'
  | 'open-settings'
  | 'new-project'
  | 'project-search'
  | 'prompts'
  | 'scrollback-search'
  | 'toggle-help'
  | 'new-terminal'
  | 'new-terminal-window'
  | 'toggle-agents-dock'
  | 'focus-agents-composer';
export type AppShortcutActionFn = (e: ShortcutKeyLike, platform: ShortcutPlatform) => AppShortcutAction | null;
export type ShortcutPredicateFn = (e: ShortcutKeyLike, platform: ShortcutPlatform) => boolean;

/** Who handles a key pressed while a terminal is focused. */
export type TerminalKeyRoute = 'shell' | 'app' | 'copy' | 'paste' | 'default' | 'copy-or-shell';
export type RouteTerminalKeyFn = (e: ShortcutKeyLike, platform: ShortcutPlatform) => TerminalKeyRoute;

export type TerminalTabAction = 'find' | 'zoom-in' | 'zoom-out' | 'zoom-reset';
export type TerminalTabActionFn = (e: ShortcutKeyLike, platform: ShortcutPlatform) => TerminalTabAction | null;

export interface TerminalKeyEvent extends ShortcutKeyLike {
  preventDefault(): void;
}

export interface TerminalKeyHandlerDeps {
  readonly platform: ShortcutPlatform;
  hasSelection(): boolean;
  getSelection(): string;
  writeClipboard(text: string): Promise<void>;
  readClipboard(): Promise<string>;
  paste(text: string): void;
  onClipboardError(op: 'copy' | 'paste', err: unknown): void;
}

/** xterm custom key-event handler: returning `false` makes xterm skip the key. */
export type TerminalKeyHandler = (e: TerminalKeyEvent) => boolean;
export type CreateTerminalKeyHandlerFn = (deps: TerminalKeyHandlerDeps) => TerminalKeyHandler;

export const SHORTCUTS = {
  palette: { mod: true, key: 'K' },
  paletteCommands: { mod: true, shift: true, key: 'P' },
  findFile: { mod: true, key: 'P' },
  findInProject: { mod: true, shift: true, key: 'F' },
  sidebar: { mod: true, key: 'B' },
  sidebarAlt: { mod: true, key: '\\' },
  settings: { mod: true, key: ',' },
  help: { mod: true, key: '/' },
  newProject: { mod: true, shift: true, key: 'N' },
  newTerminal: { mod: true, key: 'T' },
  newTerminalWindow: { mod: true, shift: true, key: 'T' },
  findInTerminal: { mod: true, key: 'F' },
  scrollbackSearch: { mod: true, shift: true, key: 'O' },
  prompts: { mod: true, shift: true, key: 'K' },
  zoomIn: { mod: true, key: '=' },
  zoomOut: { mod: true, key: '-' },
  zoomReset: { mod: true, key: '0' },
  save: { mod: true, key: 'S' },
  commit: { mod: true, key: 'Enter' },
  findNext: { key: 'Enter' },
  findPrev: { shift: true, key: 'Enter' },
  terminalCopy: { ctrl: true, shift: true, key: 'C' },
  terminalPaste: { ctrl: true, shift: true, key: 'V' },
  agentsDock: { mod: true, key: 'J' },
  agentsComposer: { mod: true, shift: true, key: 'A' },
} as const satisfies Record<string, ShortcutDef>;
