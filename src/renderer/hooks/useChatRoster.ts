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
 */
export function useChatRoster(): RosterRow[] {
  const [rows, setRows] = useState<RosterRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const res = await api.invoke('chat:roster', {});
        if (!cancelled) setRows(res.rows);
      } catch { /* main not ready yet — next event will retry */ }
    };
    void refresh();
    const offAlive = api.on('alive-shells:changed', () => { void refresh(); });
    const offState = api.on('agent-state:changed', () => { void refresh(); });
    return () => { cancelled = true; offAlive(); offState(); };
  }, []);
  return rows;
}
