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
export function useFleet(): { machines: FleetEntry[]; devices: FleetEntry[]; loading: boolean; error?: string; refresh: () => Promise<void> } {
  const [devices, setDevices] = useState<FleetEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const alive = useRef(true);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const request = ++latest.current;
    const isCurrent = () => alive.current && request === latest.current;
    try {
      const { fleet } = await api.invoke('p2p:fleet-list', undefined);
      if (!isCurrent()) return;
      setDevices((prev) => sameDevices(prev, fleet) ? prev : fleet);
      setError(undefined);
    } catch (e) {
      if (isCurrent()) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (isCurrent()) setLoading(false);
    }
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

function sameDevices(prior: FleetEntry[], next: FleetEntry[]): boolean {
  return sameMachines(prior, next) && prior.every((device, i) => {
    const update = next[i];
    return update !== undefined && Boolean(device.viewer) === Boolean(update.viewer)
      && device.workspaceAccess === update.workspaceAccess;
  });
}
