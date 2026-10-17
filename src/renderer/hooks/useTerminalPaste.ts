/**
 * Thin React wiring for pasting into a terminal (AC12, AC12a, AC13). It binds
 * `createPasteFromText` to the real IPC and toast effects and installs `installPasteInterceptor`
 * on the xterm host, so macOS Cmd+V and Edit > Paste take the same route as Ctrl+Shift+V and the
 * context menu, which call the returned `pasteFromText`. `paste` must be `term.paste`.
 */
import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { api } from '@renderer/api';
import {
  createPasteFromText,
  installPasteInterceptor,
  type ClipboardPasteDeps,
} from '@renderer/clipboard-paste';
import { toast } from '@renderer/hooks/useToasts';
import { pathStyleFor } from '@shared/shell-escape';

const clipboardDeps: ClipboardPasteDeps = {
  style: pathStyleFor(api.platform),
  stageClipboardImage: () => api.invoke('drops:stage-clipboard-image', undefined),
  notify: (title, detail) => {
    toast(title, { kind: 'error', detail });
  },
};

const logPasteError = (err: unknown) => console.error('[metaide] terminal paste failed', err);

/** Installs the paste interceptor on `hostRef` and returns a stable `pasteFromText(text)`. */
export function useTerminalPaste(
  hostRef: RefObject<HTMLElement>,
  paste: (text: string) => void,
): (text: string) => Promise<void> {
  const pasteRef = useRef(paste);
  pasteRef.current = paste;
  const pasteFromText = useMemo(
    () => createPasteFromText(clipboardDeps, (text) => pasteRef.current(text)),
    [],
  );
  useEffect(() => {
    const host = hostRef.current;
    return host ? installPasteInterceptor(host, pasteFromText, logPasteError) : undefined;
  }, [hostRef, pasteFromText]);
  return pasteFromText;
}
