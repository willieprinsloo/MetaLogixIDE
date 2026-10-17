/**
 * Pure controller behind the terminal drop handlers (AC1, AC16, AC19, AC20). It works over minimal
 * drag-event and transfer interfaces, so it runs without a DOM: it accepts or ignores a drag by
 * `dropKindFor`, drives the overlay through the enter/leave depth counter, snapshots the transfer
 * synchronously on drop (it is unreadable once the event returns), plans the payload and pastes it
 * only when it is non-empty and the shell is still alive. `useTerminalDrop` is thin wiring over it.
 */
import { createDragHover, dropKindFor, type DropKind } from '@renderer/drag-hover';
import type { DropFile, DropSnapshot } from '@renderer/terminal-drop';
import { APP_FILE_DRAG_TYPE } from '@shared/terminal-drop-contract';

/** The part of a `DataTransfer` the controller reads. */
export interface DropTransferLike<F extends DropFile> {
  readonly types: readonly string[];
  readonly files: ArrayLike<F>;
  dropEffect: string;
  getData(type: string): string;
}

/** The part of a drag event the controller reads. */
export interface DropEventLike<F extends DropFile> {
  readonly dataTransfer: DropTransferLike<F>;
  preventDefault(): void;
}

/** Injected effects; `paste` must be `term.paste` and only ever receives a non-empty string. */
export interface TerminalDropControllerDeps<F extends DropFile> {
  plan(snapshot: DropSnapshot<F>): Promise<string | null>;
  paste(text: string): void;
  isExited(): boolean;
  setOverlay(kind: DropKind | null): void;
  onError(err: unknown): void;
}

/** Drag handlers plus `attach(window)`, which resets the overlay on any window dragend or drop. */
export interface TerminalDropController<F extends DropFile> {
  dragEnter(e: DropEventLike<F>): void;
  dragOver(e: DropEventLike<F>): void;
  dragLeave(): void;
  drop(e: DropEventLike<F>): Promise<void>;
  reset(): void;
  attach(target: EventTarget): () => void;
}

function snapshotOf<F extends DropFile>(dt: DropTransferLike<F>): DropSnapshot<F> {
  return {
    appFile: dt.getData(APP_FILE_DRAG_TYPE),
    files: Array.from(dt.files),
    text: dt.getData('text/plain'),
  };
}

/** Creates the drop controller; `drop` never rejects, failures go to `onError`. */
export function createTerminalDropController<F extends DropFile>(
  deps: TerminalDropControllerDeps<F>,
): TerminalDropController<F> {
  const hover = createDragHover();
  const reset = () => {
    hover.reset();
    deps.setOverlay(null);
  };
  const pastePlanned = async (snapshot: DropSnapshot<F>) => {
    try {
      const payload = await deps.plan(snapshot);
      if (payload && !deps.isExited()) deps.paste(payload);
    } catch (err) {
      deps.onError(err);
    }
  };
  return {
    dragEnter: (e) => {
      hover.enter();
      deps.setOverlay(dropKindFor(e.dataTransfer.types));
    },
    dragOver: (e) => {
      if (!dropKindFor(e.dataTransfer.types)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    dragLeave: () => {
      if (!hover.leave()) deps.setOverlay(null);
    },
    drop: async (e) => {
      reset();
      if (!dropKindFor(e.dataTransfer.types)) return;
      e.preventDefault();
      if (deps.isExited()) return;
      await pastePlanned(snapshotOf(e.dataTransfer));
    },
    reset,
    attach: (target) => {
      target.addEventListener('dragend', reset);
      target.addEventListener('drop', reset);
      return () => {
        target.removeEventListener('dragend', reset);
        target.removeEventListener('drop', reset);
      };
    },
  };
}
