import { useCallback, useEffect, useState } from 'react';
import { api } from '@renderer/api';

/**
 * Returns a Set of projectIds that currently have an alive PTY.
 * Refetches on mount, whenever the main process emits `alive-shells:changed`,
 * and also on `pty:exit` for extra safety.
 */
export function useAliveShellIds(): { aliveIds: Set<number>; refresh: () => Promise<void> } {
  const [aliveIds, setAliveIds] = useState<Set<number>>(new Set());

  const refresh = useCallback(async () => {
    const { shells } = await api.invoke('shells:alive-list', undefined as never);
    setAliveIds(new Set(shells.map((s) => s.projectId)));
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const offChanged = api.on('alive-shells:changed', () => { void refresh(); });
    const offExit = api.on('pty:exit', () => { void refresh(); });
    return () => { offChanged(); offExit(); };
  }, [refresh]);

  return { aliveIds, refresh };
}
