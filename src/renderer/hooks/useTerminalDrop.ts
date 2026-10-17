/**
 * Thin React wiring for dropping onto a terminal (AC1, AC16, AC19, AC20). It builds one
 * `createTerminalDropController` with the real IPC, path, toast and overlay effects, attaches its
 * window dragend/drop reset for the component's lifetime, and exposes its handlers for the
 * terminal container. `paste` must be `term.paste`; behaviour lives in `terminal-drop-controller.ts`.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { api } from '@renderer/api';
import type { DropKind } from '@renderer/drag-hover';
import { toast } from '@renderer/hooks/useToasts';
import { planDrop, type DropDeps } from '@renderer/terminal-drop';
import { createTerminalDropController } from '@renderer/terminal-drop-controller';
import { pathStyleFor } from '@shared/shell-escape';

export interface TerminalDropOptions {
  /** Inserts the payload; called only with a non-empty string. */
  paste(text: string): void;
  /** True while the shell has exited, so drops insert nothing (AC16). */
  isExited(): boolean;
}

export interface TerminalDropHandlers {
  onDragEnter(e: DragEvent<HTMLElement>): void;
  onDragOver(e: DragEvent<HTMLElement>): void;
  onDragLeave(e: DragEvent<HTMLElement>): void;
  onDrop(e: DragEvent<HTMLElement>): void;
}

const dropDeps: DropDeps<File> = {
  style: pathStyleFor(api.platform),
  pathForFile: (file) => api.pathForFile(file),
  resolveAppFile: (payload) => api.invoke('drops:resolve-app-file', payload),
  stageFile: (request) => api.invoke('drops:stage-file', request),
  notify: (title, detail) => {
    toast(title, { kind: 'error', detail });
  },
};

/** Returns the overlay kind to render (null hides it) and the drag handlers for the terminal container. */
export function useTerminalDrop(options: TerminalDropOptions): {
  overlay: DropKind | null;
  handlers: TerminalDropHandlers;
} {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [overlay, setOverlay] = useState<DropKind | null>(null);
  const controller = useMemo(
    () =>
      createTerminalDropController<File>({
        plan: (snapshot) => planDrop(snapshot, dropDeps),
        paste: (text) => optionsRef.current.paste(text),
        isExited: () => optionsRef.current.isExited(),
        setOverlay,
        onError: (err) => console.error('[metaide] terminal drop failed', err),
      }),
    [],
  );
  useEffect(() => controller.attach(window), [controller]);
  const handlers = useMemo<TerminalDropHandlers>(
    () => ({
      onDragEnter: (e) => controller.dragEnter(e),
      onDragOver: (e) => controller.dragOver(e),
      onDragLeave: () => controller.dragLeave(),
      onDrop: (e) => void controller.drop(e),
    }),
    [controller],
  );
  return { overlay, handlers };
}
