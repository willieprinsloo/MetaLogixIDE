import { useEffect, useState } from 'react';
import { api } from '../api';

/** Polled every 5s like useFleet; returns the set of projectIds with at least one alive shell. */
export function useRemoteAliveShells(deviceId: string): { aliveProjectIds: Set<number>; shellCount: number } {
  const [state, setState] = useState<{ aliveProjectIds: Set<number>; shellCount: number }>(
    { aliveProjectIds: new Set(), shellCount: 0 },
  );

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      api.invoke('p2p:rpc-call', { deviceId, method: 'shells.alive', params: {} }).then(
        (res) => {
          if (cancelled) return;
          const shells = Array.isArray(res.result) ? (res.result as Array<{ projectId: number }>) : [];
          const ids = new Set(shells.map((r) => r.projectId));
          setState({ aliveProjectIds: ids, shellCount: shells.length });
        },
        () => { /* keep whatever we had; retry on next tick */ },
      );
    };
    tick();
    const id = window.setInterval(tick, 5000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [deviceId]);

  return state;
}
