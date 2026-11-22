import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '@renderer/api';
import { isTerminalPaddingValue, TERMINAL_PADDING_KEYS, type TerminalPaddingAxis, type TerminalPaddingKey, type TerminalPaddingValue } from '@shared/terminal-padding';

type TerminalPadding = Readonly<Record<TerminalPaddingAxis, TerminalPaddingValue>>;
const TerminalPaddingContext = createContext<TerminalPadding>({ horizontal: null, vertical: null });

function useStoredPadding(key: TerminalPaddingKey): TerminalPaddingValue {
  const [padding, setPadding] = useState<TerminalPaddingValue>(null);
  useEffect(() => {
    let generation = 0;
    async function refresh() {
      const current = ++generation;
      try {
        const { value } = await api.invoke('settings:get', { key });
        if (current === generation && isTerminalPaddingValue(value)) setPadding(value);
      } catch (error) {
        if (current === generation) console.warn(`Could not load ${key}`, error);
      }
    }
    const off = api.on('settings:changed', event => { if (event.key === key) void refresh(); });
    void refresh();
    return () => { generation++; off(); };
  }, [key]);
  return padding;
}

/** Shares the committed desktop terminal insets across the views in one window. */
export function TerminalPaddingProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const horizontal = useStoredPadding(TERMINAL_PADDING_KEYS.horizontal);
  const vertical = useStoredPadding(TERMINAL_PADDING_KEYS.vertical);
  const padding = useMemo(() => ({ horizontal, vertical }), [horizontal, vertical]);
  return <TerminalPaddingContext.Provider value={padding}>{children}</TerminalPaddingContext.Provider>;
}

/** Reads the current window's committed overrides, or the built-in spacing outside the provider. */
export function useTerminalPadding(): TerminalPadding {
  return useContext(TerminalPaddingContext);
}
