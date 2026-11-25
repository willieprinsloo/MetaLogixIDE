/**
 * Thin React wiring for pasting into a terminal (AC12, AC12a, AC13, AC-I1..I5). It binds
 * `createPasteFromText` to the real IPC and toast effects and installs `installPasteInterceptor`
 * on the xterm host, so macOS Cmd+V and Edit > Paste take the same route as Ctrl+Shift+V and the
 * context menu, which call the returned `pasteFromText`. `paste` must be `term.paste`. With a
 * `remote` target a clipboard image is sent to that host instead of staged on this machine; the
 * local deps are untouched (AC-L1).
 */
import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { api } from '@renderer/api';
import {
  createPasteFromText,
  installPasteInterceptor,
  type ClipboardPasteDeps,
} from '@renderer/clipboard-paste';
import { toast } from '@renderer/hooks/useToasts';
import { createRemoteClipboardDeps } from '@renderer/remote-upload/remote-clipboard-deps';
import type { RemoteTarget } from '@renderer/remote-upload/useUploadProgress';
import { pathStyleFor } from '@shared/shell-escape';

const clipboardDeps: ClipboardPasteDeps = {
  style: pathStyleFor(api.platform),
  stageClipboardImage: () => api.invoke('drops:stage-clipboard-image', undefined),
  notify: (title, detail) => {
    toast(title, { kind: 'error', detail });
  },
};

const remoteEffects = {
  confirm: (message: string) => window.confirm(message),
  notify: clipboardDeps.notify,
};

const logPasteError = (err: unknown) => console.error('[metaide] terminal paste failed', err);

/**
 * Installs the paste interceptor on `hostRef` and returns a stable `pasteFromText(text)`; the
 * route (local or `remote`) is read from the latest render at paste time.
 */
export function useTerminalPaste(
  hostRef: RefObject<HTMLElement>,
  paste: (text: string) => void,
  remote?: RemoteTarget,
): (text: string) => Promise<void> {
  const pasteRef = useRef(paste);
  pasteRef.current = paste;
  const remoteRef = useRef(remote);
  remoteRef.current = remote;
  const pasteFromText = useMemo(() => {
    const sink = (text: string) => pasteRef.current(text);
    const local = createPasteFromText(clipboardDeps, sink);
    return (text: string) => {
      const target = remoteRef.current;
      if (!target) return local(text);
      return createPasteFromText(createRemoteClipboardDeps(target, remoteEffects), sink)(text);
    };
  }, []);
  useEffect(() => {
    const host = hostRef.current;
    return host ? installPasteInterceptor(host, pasteFromText, logPasteError) : undefined;
  }, [hostRef, pasteFromText]);
  return pasteFromText;
}
