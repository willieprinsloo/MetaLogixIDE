import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { PeerShells } from '../machine-dots';
import type { FleetProjectNames } from '../fleet-in-use';

const RETRY_MS = 5000;
const EMPTY: FleetProjectNames = new Map();

function parseNames(result: unknown): ReadonlyMap<number, string> {
  const rows: unknown[] = Array.isArray(result) ? result : [];
  const names = new Map<number, string>();
  for (const r of rows) {
    if (typeof r !== 'object' || r === null) continue;
    const { id, name } = r as { id?: unknown; name?: unknown };
    if (typeof id === 'number' && typeof name === 'string') names.set(id, name);
  }
  return names;
}

function sameNames(a: ReadonlyMap<number, string>, b: ReadonlyMap<number, string>): boolean {
  return a.size === b.size && [...a].every(([id, name]) => b.get(id) === name);
}

function withNames(prev: FleetProjectNames, deviceId: string, names: ReadonlyMap<number, string>): FleetProjectNames {
  const old = prev.get(deviceId);
  if (old && sameNames(old, names)) return prev;
  return new Map(prev).set(deviceId, names);
}

function keepOnly(prev: FleetProjectNames, shells: ReadonlyMap<string, PeerShells>): FleetProjectNames {
  if ([...prev.keys()].every((id) => shells.has(id))) return prev;
  return new Map([...prev].filter(([id]) => shells.has(id)));
}

function hasUnknown(entry: PeerShells, known: ReadonlyMap<number, string> | undefined): boolean {
  return [...entry.aliveProjectIds].some((id) => !known?.has(id));
}

/**
 * Project names of the paired machines with live shells, for the shared In use section
 * (docs/specs/machine-switcher-dots.md AC39). Takes the switcher's `shells.alive` map and calls a
 * machine's `projects.list` when its live set holds an id the cache does not know, with at most one
 * request per machine in flight. A failed call leaves that machine out and is retried 5 s later
 * while it still has unknown ids; a machine that leaves the map (offline or unpaired) is dropped and
 * its late reply ignored. Returns device id, then project id to name, keeping its reference while
 * nothing changes.
 */
export function useFleetInUse(shells: ReadonlyMap<string, PeerShells>): FleetProjectNames {
  const [names, setNames] = useState(EMPTY);
  const [retryTick, setRetryTick] = useState(0);
  const namesRef = useRef(names);
  const shellsRef = useRef(shells);
  const inFlight = useRef(new Set<string>());
  const retryTimer = useRef<number | null>(null);

  useEffect(() => { namesRef.current = names; }, [names]);

  useEffect(() => () => {
    shellsRef.current = new Map();
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    retryTimer.current = null;
  }, []);

  useEffect(() => {
    shellsRef.current = shells;
    setNames((prev) => keepOnly(prev, shells));
    const scheduleRetry = () => {
      if (retryTimer.current !== null || shellsRef.current.size === 0) return;
      retryTimer.current = window.setTimeout(() => { retryTimer.current = null; setRetryTick((n) => n + 1); }, RETRY_MS);
    };
    for (const [deviceId, entry] of shells) {
      if (inFlight.current.has(deviceId) || !hasUnknown(entry, namesRef.current.get(deviceId))) continue;
      inFlight.current.add(deviceId);
      api.invoke('p2p:rpc-call', { deviceId, method: 'projects.list', params: {} }).then(
        (res) => {
          inFlight.current.delete(deviceId);
          if (shellsRef.current.has(deviceId)) setNames((prev) => withNames(prev, deviceId, parseNames(res.result)));
        },
        () => { inFlight.current.delete(deviceId); scheduleRetry(); },
      );
    }
  }, [shells, retryTick]);

  return names;
}
