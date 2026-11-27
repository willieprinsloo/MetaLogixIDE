/**
 * Pure routing for keys pressed while a terminal is focused, plus the xterm custom key handler built
 * on it.
 *
 * On Linux the shell owns every unshifted Ctrl+letter and Ctrl+\ except Ctrl+F (terminal find) and
 * Ctrl+K (command palette); an explicit allow-list of Ctrl chords goes to the app, and
 * Ctrl+Shift+C/V copy and paste.
 *
 * On Windows users expect the Windows Terminal convention: plain Ctrl+V pastes, plain Ctrl+C copies
 * when there's a selection and otherwise sends ^C to the shell. Ctrl+Shift+C and Ctrl+Shift+V still
 * work too, for parity with Linux muscle memory.
 *
 * On mac only ⌘F is taken; everything else keeps xterm's default handling. The allow-list is
 * explicit so chords xterm still maps (Ctrl+[, Ctrl+3–8, Ctrl+Shift+- as ^_) stay with the shell.
 */
import { sanitizeTerminalCopy } from '@shared/sanitize-terminal-copy';
import type {
  CreateTerminalKeyHandlerFn,
  RouteTerminalKeyFn,
  ShortcutKeyLike,
  TerminalKeyHandlerDeps,
  TerminalKeyRoute,
  TerminalTabAction,
  TerminalTabActionFn,
} from './shortcut-contract';
import { chordKey, isPrimaryMod } from './shortcut-match';

const LINUX_ROUTES: ReadonlyMap<string, TerminalKeyRoute> = new Map<string, TerminalKeyRoute>([
  ['f', 'app'],
  ['j', 'app'],
  ['k', 'app'],
  ['shift+c', 'copy'],
  ['shift+v', 'paste'],
  ...['shift+p', 'shift+k', 'shift+o', 'shift+n', 'shift+t', 'shift+f', 'shift+a'].map(
    (c) => [c, 'app'] as const,
  ),
  ...[',', '/', '=', '+', 'shift++', '-', '0'].map((c) => [c, 'app'] as const),
]);

/** Windows extends the Linux map with the Windows Terminal convention for the
 *  two shared clipboard chords. Plain Ctrl+V pastes outright; plain Ctrl+C
 *  routes to the special `copy-or-shell` value that the handler resolves against
 *  the current selection (copy when something's selected, pass through to the
 *  shell so ^C still interrupts when the selection is empty). */
const WIN_ROUTES: ReadonlyMap<string, TerminalKeyRoute> = new Map<string, TerminalKeyRoute>([
  ...LINUX_ROUTES,
  ['c', 'copy-or-shell'],
  ['v', 'paste'],
]);

const SHELL_CHORD = /^[a-z\\]$/;

function routeByTable(
  e: ShortcutKeyLike,
  platform: 'win' | 'linux',
  table: ReadonlyMap<string, TerminalKeyRoute>,
): TerminalKeyRoute {
  if (!isPrimaryMod(e, platform)) return 'default';
  const chord = chordKey(e);
  return table.get(chord) ?? (SHELL_CHORD.test(chord) ? 'shell' : 'default');
}

function routeMac(e: ShortcutKeyLike): TerminalKeyRoute {
  return isPrimaryMod(e, 'mac') && chordKey(e) === 'f' ? 'app' : 'default';
}

/** Who handles a key pressed while a terminal is focused on `platform`. */
export const routeTerminalKey: RouteTerminalKeyFn = (e, platform) => {
  if (platform === 'mac') return routeMac(e);
  if (platform === 'win') return routeByTable(e, 'win', WIN_ROUTES);
  return routeByTable(e, 'linux', LINUX_ROUTES);
};

function copySelection(deps: TerminalKeyHandlerDeps): void {
  if (!deps.hasSelection()) return;
  deps.writeClipboard(sanitizeTerminalCopy(deps.getSelection())).catch((err: unknown) => {
    deps.onClipboardError('copy', err);
  });
}

function pasteClipboard(deps: TerminalKeyHandlerDeps): void {
  deps
    .readClipboard()
    .then((text) => deps.paste(text))
    .catch((err: unknown) => {
      deps.onClipboardError('paste', err);
    });
}

const CLIPBOARD_ACTIONS = { copy: copySelection, paste: pasteClipboard } as const;

/**
 * Builds the handler for `term.attachCustomKeyEventHandler`. Shell and default keys return true so
 * xterm processes them; app keys return false so xterm sends nothing and the event bubbles to the
 * DOM listeners. Copy and paste also call `preventDefault` (which stops Chromium's native paste) and
 * act on keydown only, so each happens exactly once per press.
 *
 * `copy-or-shell` resolves at handler time against the current selection: with one, it copies;
 * without, it falls through to the shell so plain Ctrl+C can still send ^C. This is the Windows
 * Terminal convention that the Windows router emits for plain Ctrl+C.
 */
export const createTerminalKeyHandler: CreateTerminalKeyHandlerFn = (deps) => (e) => {
  const raw = routeTerminalKey(e, deps.platform);
  const route = raw === 'copy-or-shell' ? (deps.hasSelection() ? 'copy' : 'shell') : raw;
  if (route !== 'copy' && route !== 'paste') return route !== 'app';
  e.preventDefault();
  if ((e.type ?? 'keydown') === 'keydown') CLIPBOARD_ACTIONS[route](deps);
  return false;
};

const TAB_ACTIONS: ReadonlyMap<string, TerminalTabAction> = new Map<string, TerminalTabAction>([
  ['f', 'find'],
  ['=', 'zoom-in'],
  ['+', 'zoom-in'],
  ['shift++', 'zoom-in'],
  ['-', 'zoom-out'],
  ['0', 'zoom-reset'],
]);

/** The ShellTab container action for a keydown (find, zoom), or null; primary modifier only. */
export const terminalTabAction: TerminalTabActionFn = (e, platform) =>
  isPrimaryMod(e, platform) ? (TAB_ACTIONS.get(chordKey(e)) ?? null) : null;
