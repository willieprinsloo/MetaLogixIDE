/**
 * Pure app-level shortcut routing for App's global keydown, FilesTab save and GitPanel commit. Every
 * chord requires the platform modifier (`isPrimaryMod`) and is looked up by `chordKey`, so Alt
 * chords and the other platform's modifier never match. The palette chords (mod+K, mod+P,
 * mod+Shift+P) are routed by `palette-keys` first and are deliberately absent here.
 */
import type {
  AppShortcutAction,
  AppShortcutActionFn,
  ShortcutPredicateFn,
} from './shortcut-contract';
import { chordKey, isPrimaryMod } from './shortcut-match';

const APP_CHORDS: ReadonlyMap<string, AppShortcutAction> = new Map<string, AppShortcutAction>([
  ['b', 'toggle-sidebar'],
  ['\\', 'toggle-sidebar'],
  [',', 'open-settings'],
  ['shift+n', 'new-project'],
  ['shift+f', 'project-search'],
  ['shift+k', 'prompts'],
  ['shift+o', 'scrollback-search'],
  ['/', 'toggle-help'],
  ['t', 'new-terminal'],
  ['shift+t', 'new-terminal-window'],
  ['j', 'toggle-agents-dock'],
]);

/** The app action for a keydown, or null when the chord is not an app shortcut on `platform`. */
export const appShortcutAction: AppShortcutActionFn = (e, platform) =>
  isPrimaryMod(e, platform) ? (APP_CHORDS.get(chordKey(e)) ?? null) : null;

/** mod+S: save the active file in FilesTab. */
export const isSaveShortcut: ShortcutPredicateFn = (e, platform) =>
  isPrimaryMod(e, platform) && chordKey(e) === 's';

/** mod+Enter: commit from GitPanel's message box. */
export const isCommitShortcut: ShortcutPredicateFn = (e, platform) =>
  isPrimaryMod(e, platform) && chordKey(e) === 'enter';
