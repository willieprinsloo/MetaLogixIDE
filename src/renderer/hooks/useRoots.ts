import { useEffect, useState, useCallback } from 'react';
import type { Root } from '@shared/types';
import { api } from '@renderer/api';

export function useRoots(): { roots: Root[]; refresh: () => Promise<void> } {
  const [roots, setRoots] = useState<Root[]>([]);
  const refresh = useCallback(async () => {
    const { roots } = await api.invoke('roots:list', undefined as never);
    setRoots(roots);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { roots, refresh };
}
