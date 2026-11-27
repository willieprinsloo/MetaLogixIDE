/**
 * Decides whether a change to the Agents dock's visibility slides or switches in one step
 * (docs/specs/agents-dock-slide.md AC1, AC2, AC9–AC11, AC16–AC22). Pure: the hook
 * `useAgentsDockFold` runs it once per render and owns the terminal hold.
 */

/** Which input flipped the dock setting; only a pointer toggle slides. */
export type DockToggleSource = 'pointer' | 'shortcut' | 'migration';

export interface DockFoldInput {
  setting: boolean;
  context: boolean;
  source: DockToggleSource;
}

export interface DockFoldState {
  setting: boolean;
  context: boolean;
  animate: boolean;
  folding: boolean;
}

export function initialDockFold(input: Pick<DockFoldInput, 'setting' | 'context'>): DockFoldState {
  return { ...input, animate: false, folding: false };
}

/** STUB: not implemented yet. */
export function stepDockFold(prev: DockFoldState, next: DockFoldInput): DockFoldState {
  void next;
  return prev;
}

/** STUB: not implemented yet. */
export function completeDockFold(prev: DockFoldState): DockFoldState {
  return prev;
}
