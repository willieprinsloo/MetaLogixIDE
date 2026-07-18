import { useCallback, useEffect, useState } from 'react';
import type { Project } from '@shared/types';
import { api } from '@renderer/api';

export function useRecents(limit = 10): { recents: Project[]; refresh: () => Promise<void> } {
  const [recents, setRecents] = useState<Project[]>([]);

  const refresh = useCallback(async () => {
    const { projects } = await api.invoke('projects:recents', { limit });
    setRecents(projects);
  }, [limit]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const off = api.on('projects:changed', () => { void refresh(); });
    return () => { off(); };
  }, [refresh]);

  return { recents, refresh };
}
