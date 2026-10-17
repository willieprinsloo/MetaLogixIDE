/**
 * Pure state for the terminal drop overlay (AC19, AC20). `createDragHover` counts `dragenter`
 * against `dragleave` so crossing child elements never toggles the overlay, and `dropKindFor`
 * decides from a drag's types whether the drop will paste a path, paste text, or is not accepted.
 */
import { APP_FILE_DRAG_TYPE } from '@shared/terminal-drop-contract';

export type DropKind = 'path' | 'text';

/** Enter/leave depth counter; `enter` and `leave` return whether the overlay should show. */
export interface DragHover {
  enter(): boolean;
  leave(): boolean;
  reset(): void;
}

/** Classifies drag types: `Files` or the Files-tree type → path, `text/plain` → text, else null. */
export function dropKindFor(types: readonly string[]): DropKind | null {
  if (types.includes('Files') || types.includes(APP_FILE_DRAG_TYPE)) return 'path';
  return types.includes('text/plain') ? 'text' : null;
}

/** Creates a depth counter that is visible while depth > 0; `reset` is for drop and dragend. */
export function createDragHover(): DragHover {
  let depth = 0;
  return {
    enter: () => {
      depth += 1;
      return true;
    },
    leave: () => {
      depth = Math.max(0, depth - 1);
      return depth > 0;
    },
    reset: () => {
      depth = 0;
    },
  };
}
