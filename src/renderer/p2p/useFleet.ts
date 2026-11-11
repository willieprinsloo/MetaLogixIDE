import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { FleetEntry } from '../../shared/p2p-contract';

// TODO: replace polling with a push channel once main emits `p2p:fleet-changed`
// (not present in IpcEvents yet).
const POLL_MS = 5000;

export function useFleet(): { machines: FleetEntry[]; loading: boolean; error?: string; refresh: () => void } {
  const [machines, setMachines] = useState<FleetEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const alive = useRef(true);

  const load = useCallback(() => {
    api.invoke('p2p:fleet-list', undefined).then(
      (res) => {
        if (!alive.current) return;
        setMachines(res.fleet);
        setError(undefined);
        setLoading(false);
      },
      (e: unknown) => {
        if (!alive.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
  }, []);

  useEffect(() => {
    alive.current = true;
    load();
    const t = setInterval(load, POLL_MS);
    return () => { alive.current = false; clearInterval(t); };
  }, [load]);

  return { machines, loading, error, refresh: load };
}
