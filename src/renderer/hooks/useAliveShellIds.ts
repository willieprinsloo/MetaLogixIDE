import { useCallback, useEffect, useState } from 'react';
import { api } from '@renderer/api';

/**
 * Subscribes to all live project shells while separately exposing projects with a live primary.
 * Recents/In use use `aliveIds`; unload affordances require `primaryIds`.
 */
export function useAliveShellIds(): { aliveIds: Set<number>; primaryIds: Set<number>; refresh: () => Promise<void> } {
  const [ids, setIds] = useState({ aliveIds: new Set<number>(), primaryIds: new Set<number>() });

  const refresh = useCallback(async () => {
    const { shells } = await api.invoke('shells:alive-list', undefined as never);
    const aliveIds = new Set<number>();
    const primaryIds = new Set<number>();
    for (const shell of shells) {
      aliveIds.add(shell.projectId);
      if (shell.shellIndex === 0) primaryIds.add(shell.projectId);
    }
    setIds({ aliveIds, primaryIds });
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const offChanged = api.on('alive-shells:changed', () => { void refresh(); });
    const offExit = api.on('pty:exit', () => { void refresh(); });
    return () => { offChanged(); offExit(); };
  }, [refresh]);

  return { ...ids, refresh };
}
