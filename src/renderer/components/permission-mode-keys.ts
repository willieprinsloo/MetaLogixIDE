/**
 * Pure keyboard routing for the blocking permission-mode dialog: decides what
 * a keydown does while the dialog is open, and where Tab moves focus inside
 * its focus trap. Kept DOM-free so it is unit-testable in a node environment.
 */

export type DialogKeyAction = 'cycle-focus' | 'confirm' | 'swallow' | 'isolate' | 'pass';

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Classifies a keydown seen while the dialog is open: `cycle-focus` for Tab,
 * `confirm` for plain Enter, `swallow` for Escape, `isolate` for any
 * Cmd/Ctrl chord (kept from app listeners, default left to native menu roles),
 * and `pass` for everything the radios and button handle natively.
 */
export function classifyDialogKey(e: KeyLike): DialogKeyAction {
  if (e.metaKey || e.ctrlKey) return 'isolate';
  if (e.key === 'Tab') return 'cycle-focus';
  if (e.key === 'Escape') return 'swallow';
  if (e.key === 'Enter') return 'confirm';
  return 'pass';
}

/**
 * Index of the next focusable element in a trap of `count` elements, wrapping
 * at both ends; `current` of -1 means focus is outside the trap. Returns -1
 * when there is nothing to focus.
 */
export function nextFocusIndex(current: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  return (current + (backwards ? count - 1 : 1)) % count;
}
