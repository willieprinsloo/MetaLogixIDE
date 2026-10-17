/**
 * Window-level external-drag guard (AC22), installed by every window: the main window and each
 * popout. Chromium's default on a drop is to load the dropped file or URL, which main turns into
 * `shell.openExternal`. A drag counts as in-app from `dragstart` in this window until `dragend`,
 * `drop`, a `pointerdown` or a button-free `mousemove` (neither can happen mid-drag, so a drag
 * whose `dragend` never reaches the window self-heals). Only drags that did not start here are
 * cancelled, so in-app drags keep their native default; ShellTab handles its own drops first.
 */
import { useEffect } from 'react';

/** Guard state; `dragOver` and `drop` return whether to `preventDefault`. */
export interface ExternalDragGuard {
  dragStart(): void;
  dragEnd(): void;
  pointerDown(): void;
  pointerMove(buttons: number): void;
  dragOver(): boolean;
  drop(): boolean;
}

/** Creates the pure in-app/external drag state behind the window guard. */
export function createExternalDragGuard(): ExternalDragGuard {
  let inApp = false;
  const clear = () => {
    inApp = false;
  };
  return {
    dragStart: () => {
      inApp = true;
    },
    dragEnd: clear,
    pointerDown: clear,
    pointerMove: (buttons) => {
      if (buttons === 0) clear();
    },
    dragOver: () => !inApp,
    drop: () => {
      const swallow = !inApp;
      clear();
      return swallow;
    },
  };
}

const CAPTURE = { capture: true } as const;

const buttonsOf = (e: Event): number => ('buttons' in e ? Number(e.buttons) : 0);

/** Wires the guard to `target` (a window); returns a disposer that removes every listener. */
export function installExternalDragGuard(target: EventTarget): () => void {
  const guard = createExternalDragGuard();
  const onDragOver = (e: Event) => {
    if (guard.dragOver()) e.preventDefault();
  };
  const onDrop = (e: Event) => {
    if (guard.drop()) e.preventDefault();
  };
  const capture: readonly [string, (e: Event) => void][] = [
    ['dragstart', () => guard.dragStart()],
    ['dragend', () => guard.dragEnd()],
    ['pointerdown', () => guard.pointerDown()],
    ['mousemove', (e) => guard.pointerMove(buttonsOf(e))],
  ];
  for (const [type, fn] of capture) target.addEventListener(type, fn, CAPTURE);
  target.addEventListener('dragover', onDragOver);
  target.addEventListener('drop', onDrop);
  return () => {
    for (const [type, fn] of capture) target.removeEventListener(type, fn, CAPTURE);
    target.removeEventListener('dragover', onDragOver);
    target.removeEventListener('drop', onDrop);
  };
}

/** Installs the external-drag guard on this window for the component's lifetime. */
export function useExternalDragGuard(): void {
  useEffect(() => installExternalDragGuard(window), []);
}
