import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Root } from '../../shared/types';

export function useRemoteRoots(deviceId: string): { roots: Root[]; loading: boolean; error?: string } {
  const [state, setState] = useState<{ roots: Root[]; loading: boolean; error?: string }>(
    { roots: [], loading: true },
  );

  useEffect(() => {
    let cancelled = false;
    setState({ roots: [], loading: true });
    api.invoke('p2p:rpc-call', { deviceId, method: 'roots.list', params: {} }).then(
      (res) => {
        if (cancelled) return;
        setState({ roots: Array.isArray(res.result) ? (res.result as Root[]) : [], loading: false });
      },
      (e: unknown) => {
        if (cancelled) return;
        setState({ roots: [], loading: false, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => { cancelled = true; };
  }, [deviceId]);

  return state;
}
