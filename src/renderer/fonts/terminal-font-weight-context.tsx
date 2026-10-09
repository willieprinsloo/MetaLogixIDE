import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';
import {
  createTerminalFontWeightStore,
  type TerminalFontWeightPorts,
  type TerminalFontWeightStore,
} from '@renderer/fonts/terminal-font-weight-store';
import { TERMINAL_BOLD_WEIGHT_KEY, TERMINAL_FONT_WEIGHT_KEY, type TerminalFontWeight } from '@shared/terminal-font-weight';

export interface TerminalFontWeightState {
  /** Effective weight for normal text; 400 until loaded. */
  readonly weight: TerminalFontWeight;
  /** Effective weight for bold text; 700 until loaded. */
  readonly boldWeight: TerminalFontWeight;
  /** True once the stored weight (or the default) has been applied. */
  readonly ready: boolean;
  /** No-op if unchanged; applies the weight and its derived bold locally, then persists and broadcasts. */
  setWeight(next: TerminalFontWeight): void;
  /** No-op if unchanged or not heavier than the weight; applies locally, then persists and broadcasts. */
  setBoldWeight(next: TerminalFontWeight): void;
}

const TerminalFontWeightContext = createContext<TerminalFontWeightState | null>(null);

function createWindowPorts(): TerminalFontWeightPorts {
  return {
    loadStored: async () => {
      const [weight, boldWeight] = await Promise.all([
        api.invoke('settings:get', { key: TERMINAL_FONT_WEIGHT_KEY }),
        api.invoke('settings:get', { key: TERMINAL_BOLD_WEIGHT_KEY }),
      ]);
      return { weight: weight.value, boldWeight: boldWeight.value };
    },
    saveWeight: (value) => api.invoke('settings:set-terminal-font-weight', { value }),
    saveBoldWeight: (value) => api.invoke('settings:set-terminal-bold-weight', { value }),
    onSettingsChanged: (listener) => api.on('settings:changed', ({ key }) => listener(key)),
    notifySaveFailed: (message) => {
      toast(message, { kind: 'error' });
    },
    reportError: (context, error) => console.error(context, error),
  };
}

/** One shared terminal weight pair (normal and bold) per window, kept in sync with the main-process settings store; this provider is the window's composition root for the store's ports. */
export function TerminalFontWeightProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const [store] = useState<TerminalFontWeightStore>(() => createTerminalFontWeightStore(createWindowPorts()));
  useEffect(() => store.connect(), [store]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const value = useMemo<TerminalFontWeightState>(
    () => ({
      weight: snapshot.weight,
      boldWeight: snapshot.boldWeight,
      ready: snapshot.ready,
      setWeight: store.setWeight,
      setBoldWeight: store.setBoldWeight,
    }),
    [snapshot, store],
  );
  return <TerminalFontWeightContext.Provider value={value}>{children}</TerminalFontWeightContext.Provider>;
}

/** Reads the shared terminal weight pair; throws outside TerminalFontWeightProvider. */
export function useTerminalFontWeight(): TerminalFontWeightState {
  const state = useContext(TerminalFontWeightContext);
  if (state === null) throw new Error('useTerminalFontWeight must be used inside TerminalFontWeightProvider');
  return state;
}
