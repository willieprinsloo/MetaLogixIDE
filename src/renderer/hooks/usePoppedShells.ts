import { useCallback, useEffect, useState } from 'react';
import { api } from '@renderer/api';

interface Popped { projectId: number; shellIndex: number }

/**
 * Tracks which (projectId, shellIndex) pairs currently live in a pop-out
 * window. The main window uses this to hide its own Shell tab for that
 * project (replaced with a "Return to main" placeholder), so the shell
 * only renders in one place at a time.
 */
export function usePoppedShells(): { popped: Popped[]; isPopped: (projectId: number, shellIndex?: number) => boolean } {
  const [popped, setPopped] = useState<Popped[]>([]);

  const refresh = useCallback(async () => {
    try {
      const { popped } = await api.invoke('windows:list-popped', undefined as never);
      setPopped(popped);
    } catch { /* main not up yet */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const off = api.on('popout:changed', (ev) => setPopped(ev.popped));
    return () => { off(); };
  }, []);

  const isPopped = useCallback(
    (projectId: number, shellIndex = 0) => popped.some((p) => p.projectId === projectId && p.shellIndex === shellIndex),
    [popped],
  );

  return { popped, isPopped };
}
