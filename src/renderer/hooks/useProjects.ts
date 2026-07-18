import { useEffect, useState, useCallback } from 'react';
import type { Project } from '@shared/types';
import { api } from '@renderer/api';

export function useProjects(): { projects: Project[]; refresh: () => Promise<void> } {
  const [projects, setProjects] = useState<Project[]>([]);
  const refresh = useCallback(async () => {
    const { projects } = await api.invoke('projects:list', undefined as never);
    setProjects(projects);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { projects, refresh };
}
