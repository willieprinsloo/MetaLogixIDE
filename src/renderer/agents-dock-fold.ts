/**
 * Decides whether a change to the Agents dock's visibility slides or switches in one step
 * (docs/specs/agents-dock-slide.md AC1, AC2, AC9–AC11, AC16–AC22). Pure: the hook
 * `useAgentsDockFold` runs it once per render and owns the terminal hold.
 */
import type { FoldCustom } from './pane-fold';

/** Which input flipped the dock setting; only a pointer toggle slides. */
export type DockToggleSource = 'pointer' | 'shortcut' | 'migration';

/** One render's inputs: the persisted open setting, whether the dock can be shown here, and what flipped the setting last. */
export interface DockFoldInput {
  setting: boolean;
  context: boolean;
  source: DockToggleSource;
}

/** Last seen inputs, whether the current change slides (`animate`), and whether a slide holds the terminal (`folding`). */
export interface DockFoldState {
  setting: boolean;
  context: boolean;
  animate: boolean;
  folding: boolean;
}

/** The state on first render: nothing slides, so a dock left open is already open (AC17). */
export function initialDockFold(input: Pick<DockFoldInput, 'setting' | 'context'>): DockFoldState {
  return { ...input, animate: false, folding: false };
}

/**
 * One render's step: a context change switches in one step and drops any fold in flight; a
 * non-pointer source arriving mid-fold (⇧⌘A during a pointer open, or ⌘J) ends that fold in one
 * step (AC11) but keeps holding until `completeDockFold`, so the terminal refits once, at the end
 * state (AC13); otherwise a setting flip slides only when a pointer made it while the dock can be
 * seen. Returns `prev` itself when nothing changed.
 */
export function stepDockFold(prev: DockFoldState, next: DockFoldInput): DockFoldState {
  const { setting, context } = next;
  if (context !== prev.context) return { setting, context, animate: false, folding: false };
  if (setting === prev.setting) return prev.folding && prev.animate && next.source !== 'pointer' ? { ...prev, animate: false } : prev;
  const animate = next.source === 'pointer' && context;
  return { setting, context, animate, folding: animate || prev.folding };
}

/** The fold finished (or was given up on): stop holding. Returns `prev` itself when nothing was folding. */
export function completeDockFold(prev: DockFoldState): DockFoldState {
  return prev.folding ? { ...prev, folding: false } : prev;
}

/** The `custom` the dock's fold resolves with: a slide only when the last step animates. */
export function dockFoldCustom(state: DockFoldState, reduced: boolean): FoldCustom {
  return { instant: !state.animate, reduced };
}
