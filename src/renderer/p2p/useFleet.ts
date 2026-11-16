import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { FleetEntry } from '../../shared/p2p-contract';
import { sameMachines } from '../machine-dots';

// TODO: replace polling with a push channel once main emits `p2p:fleet-changed`
// (not present in IpcEvents yet).
const POLL_MS = 5000;

/**
 * `machines` are the fleet: paired machines this one can open. `devices` is every paired device, including
 * viewer-only ones such as the mobile app, which Settings lists so they can be revoked.
 */
export function useFleet(): { machines: FleetEntry[]; devices: FleetEntry[]; loading: boolean; error?: string; refresh: () => void } {
  const [devices, setDevices] = useState<FleetEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const alive = useRef(true);

  const load = useCallback(() => {
    api.invoke('p2p:fleet-list', undefined).then(
      (res) => {
        if (!alive.current) return;
        setDevices((prev) => (sameMachines(prev, res.fleet) && prev.every((d, i) => !d.viewer === !res.fleet[i]!.viewer) ? prev : res.fleet));
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

  const machines = useMemo(() => devices.filter((d) => !d.viewer), [devices]);

  return { machines, devices, loading, error, refresh: load };
}
