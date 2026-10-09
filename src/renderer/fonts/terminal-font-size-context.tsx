import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';
import {
  createTerminalFontSizeStore,
  type TerminalFontSizePorts,
  type TerminalFontSizeStore,
} from '@renderer/fonts/terminal-font-size-store';
import { LEGACY_SHELL_FONT_SIZE_STORAGE_KEY, TERMINAL_FONT_SIZE_KEY } from '@shared/terminal-font-size';

export interface TerminalFontSizeState {
  /** Effective size in px; TERMINAL_FONT_SIZE.default until loaded. */
  readonly size: number;
  /** True once the stored (or migrated) size has been applied. */
  readonly ready: boolean;
  /** Clamps; no-op if unchanged; applies locally, then persists and broadcasts. */
  setSize(next: number): void;
}

const TerminalFontSizeContext = createContext<TerminalFontSizeState | null>(null);

function readLegacySize(): string | null {
  try {
    return window.localStorage.getItem(LEGACY_SHELL_FONT_SIZE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function createWindowPorts(): TerminalFontSizePorts {
  return {
    loadStored: async () => (await api.invoke('settings:get', { key: TERMINAL_FONT_SIZE_KEY })).value,
    save: (request) => api.invoke('settings:set-terminal-font-size', request),
    onSettingsChanged: (listener) => api.on('settings:changed', ({ key }) => listener(key)),
    readLegacy: readLegacySize,
    notifySaveFailed: (message) => {
      toast(message, { kind: 'error' });
    },
    reportError: (context, error) => console.error(context, error),
  };
}

/** One shared terminal font size per window, kept in sync with the main-process settings store; this provider is the window's composition root for the store's ports. */
export function TerminalFontSizeProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const [store] = useState<TerminalFontSizeStore>(() => createTerminalFontSizeStore(createWindowPorts()));
  useEffect(() => store.connect(), [store]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const value = useMemo<TerminalFontSizeState>(
    () => ({ size: snapshot.size, ready: snapshot.ready, setSize: store.setSize }),
    [snapshot, store],
  );
  return <TerminalFontSizeContext.Provider value={value}>{children}</TerminalFontSizeContext.Provider>;
}

/** Reads the shared terminal font size; throws outside TerminalFontSizeProvider. */
export function useTerminalFontSize(): TerminalFontSizeState {
  const state = useContext(TerminalFontSizeContext);
  if (state === null) throw new Error('useTerminalFontSize must be used inside TerminalFontSizeProvider');
  return state;
}
