import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { machineAgentState, readAgentState } from '../agent-state';
import type { MachineDot } from '../machine-switcher-contract';
import type { PeerShells } from '../machine-dots';

const POLL_MS = 5000;
const EMPTY: ReadonlyMap<string, PeerShells> = new Map();

function parseShells(result: unknown): PeerShells {
  const rows = Array.isArray(result) ? result : [];
  const live = rows.filter((r): r is { projectId: number; agentState?: unknown } => (
    typeof r === 'object' && r !== null && typeof (r as { projectId?: unknown }).projectId === 'number'
  ));
  return {
    aliveProjectIds: new Set(live.map((r) => r.projectId)),
    agentState: machineAgentState(live.map((r) => readAgentState(r.agentState))),
  };
}

function sameShells(a: PeerShells, b: PeerShells): boolean {
  return a.agentState === b.agentState
    && a.aliveProjectIds.size === b.aliveProjectIds.size
    && [...a.aliveProjectIds].every((id) => b.aliveProjectIds.has(id));
}

function withEntry(prev: ReadonlyMap<string, PeerShells>, deviceId: string, entry: PeerShells): ReadonlyMap<string, PeerShells> {
  const old = prev.get(deviceId);
  if (old && sameShells(old, entry)) return prev;
  return new Map(prev).set(deviceId, entry);
}

function keepOnly(prev: ReadonlyMap<string, PeerShells>, ids: readonly string[]): ReadonlyMap<string, PeerShells> {
  if ([...prev.keys()].every((id) => ids.includes(id))) return prev;
  return new Map([...prev].filter(([id]) => ids.includes(id)));
}

/**
 * Live shells per online paired machine (docs/specs/machine-switcher-dots.md AC34): one
 * `shells.alive` call per online peer every 5 s, polled at once when the online set changes. Each
 * entry holds the live project ids and the worst agent state, with untrusted values guarded to the
 * three literals (an old host's missing field reads as null). A failed poll keeps that peer's last
 * entry; going offline or unpaired drops it. The Map keeps its reference while nothing changes.
 */
export function useFleetShells(peers: readonly MachineDot[]): ReadonlyMap<string, PeerShells> {
  const onlineKey = peers.filter((p) => p.online && !p.self).map((p) => p.deviceId).sort().join('\n');
  const ids = useMemo(() => (onlineKey ? onlineKey.split('\n') : []), [onlineKey]);
  const [shells, setShells] = useState(EMPTY);

  useEffect(() => {
    setShells((prev) => keepOnly(prev, ids));
    if (ids.length === 0) return;
    let cancelled = false;
    const poll = (deviceId: string) => {
      api.invoke('p2p:rpc-call', { deviceId, method: 'shells.alive', params: {} }).then(
        (res) => { if (!cancelled) setShells((prev) => withEntry(prev, deviceId, parseShells(res.result))); },
        () => { /* keep the last entry until a successful reply or the peer goes offline (AC34) */ },
      );
    };
    const tick = () => ids.forEach(poll);
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [ids]);

  return shells;
}
