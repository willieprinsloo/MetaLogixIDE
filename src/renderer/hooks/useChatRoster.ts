import { useEffect, useState } from 'react';
import { api } from '@renderer/api';
import type { IpcResponse } from '@shared/ipc-contract';

export type RosterRow = IpcResponse<'chat:roster'>['rows'][number];

/**
 * Live roster of every agent-running shell (local + paired peers) the
 * Agents pane can @-mention. Rebuilt from the main-process view on mount
 * and whenever `alive-shells:changed` or `agent-state:changed` fires —
 * so a freshly-spawned Claude appears in the sidebar without the user
 * having to wait for their first chat message.
 *
 * `selfDevice` is the canonical device name the main process tags local
 * rows with — use it instead of the P2P hook when deciding "is this
 * row local?", since P2P returns '' when it's off and local pills then
 * show a bogus "·device" suffix.
 */
export function useChatRoster(): { rows: RosterRow[]; selfDevice: string } {
  const [state, setState] = useState<{ rows: RosterRow[]; selfDevice: string }>({ rows: [], selfDevice: '' });
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const res = await api.invoke('chat:roster', {});
        if (!cancelled) setState({ rows: res.rows, selfDevice: res.selfDevice });
      } catch { /* main not ready yet — next event will retry */ }
    };
    void refresh();
    const offAlive = api.on('alive-shells:changed', () => { void refresh(); });
    const offState = api.on('agent-state:changed', () => { void refresh(); });
    return () => { cancelled = true; offAlive(); offState(); };
  }, []);
  return state;
}
