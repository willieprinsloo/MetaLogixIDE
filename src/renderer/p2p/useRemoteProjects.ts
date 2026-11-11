import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Project } from '../../shared/types';

export function useRemoteProjects(deviceId: string): { projects: Project[]; loading: boolean; error?: string } {
  const [state, setState] = useState<{ projects: Project[]; loading: boolean; error?: string }>(
    { projects: [], loading: true },
  );

  useEffect(() => {
    let cancelled = false;
    setState({ projects: [], loading: true });
    api.invoke('p2p:rpc-call', { deviceId, method: 'projects.list', params: {} }).then(
      (res) => {
        if (cancelled) return;
        setState({ projects: Array.isArray(res.result) ? (res.result as Project[]) : [], loading: false });
      },
      (e: unknown) => {
        if (cancelled) return;
        setState({ projects: [], loading: false, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => { cancelled = true; };
  }, [deviceId]);

  return state;
}
