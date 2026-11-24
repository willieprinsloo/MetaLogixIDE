/**
 * Pure routing for keys pressed while a terminal is focused, plus the xterm custom key handler built
 * on it. On other platforms the shell owns every unshifted Ctrl+letter and Ctrl+\ except Ctrl+F
 * (terminal find) and Ctrl+K (command palette); an explicit allow-list of Ctrl chords goes to the
 * app, and Ctrl+Shift+C/V copy and paste. On mac only ⌘F is taken; everything else keeps xterm's
 * default handling. The allow-list is explicit so chords xterm still maps (Ctrl+[, Ctrl+3–8,
 * Ctrl+Shift+- as ^_) stay with the shell.
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

const OTHER_ROUTES: ReadonlyMap<string, TerminalKeyRoute> = new Map<string, TerminalKeyRoute>([
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

const SHELL_CHORD = /^[a-z\\]$/;

function routeOther(e: ShortcutKeyLike): TerminalKeyRoute {
  if (!isPrimaryMod(e, 'other')) return 'default';
  const chord = chordKey(e);
  return OTHER_ROUTES.get(chord) ?? (SHELL_CHORD.test(chord) ? 'shell' : 'default');
}

function routeMac(e: ShortcutKeyLike): TerminalKeyRoute {
  return isPrimaryMod(e, 'mac') && chordKey(e) === 'f' ? 'app' : 'default';
}

/** Who handles a key pressed while a terminal is focused on `platform`. */
export const routeTerminalKey: RouteTerminalKeyFn = (e, platform) =>
  platform === 'mac' ? routeMac(e) : routeOther(e);

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
 */
export const createTerminalKeyHandler: CreateTerminalKeyHandlerFn = (deps) => (e) => {
  const route = routeTerminalKey(e, deps.platform);
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
