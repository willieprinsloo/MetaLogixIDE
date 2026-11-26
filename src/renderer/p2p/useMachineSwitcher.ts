import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFleet } from './useFleet';
import { useFleetShells } from './useFleetShells';
import { useMachineAgentState } from '../hooks/useAgentStates';
import { useSelfDeviceName } from './useSelfDeviceName';
import { buildMachineList, resolveActiveId, withAgentStates, type PeerShells } from '../machine-dots';
import type { AgentState } from '@shared/agent-state';
import { LOCAL_MACHINE_ID, type MachineDot } from '../machine-switcher-contract';

/** The switcher's state: ordered dots with agent state, the active id and its dot, `select`, the shared `shells.alive` map, and a peer's live project ids and per-project states. */
export interface MachineSwitcher {
  machines: MachineDot[];
  activeId: string;
  active: MachineDot;
  select: (deviceId: string) => void;
  shells: ReadonlyMap<string, PeerShells>;
  shellsFor: (deviceId: string) => ReadonlySet<number>;
  statesFor: (deviceId: string) => ReadonlyMap<number, AgentState>;
}

const NO_SHELLS: ReadonlySet<number> = new Set();
const NO_STATES: ReadonlyMap<number, AgentState> = new Map();

/**
 * Sidebar machine-switcher state (docs/specs/machine-switcher-dots.md AC10–AC12, AC15). Always
 * starts on this machine and is never persisted. When a successful fleet poll drops the selected
 * peer, the selection resets to this machine, so the peer coming back does not re-select itself; a
 * failed poll keeps the last list (useFleet leaves `machines` untouched on error), so nothing moves.
 * Each dot carries its agent state (AC34): this machine's from the local store's aggregate selector
 * (a delta that leaves the worst state unchanged re-renders nothing), a peer's
 * from the shared `shells.alive` poll, which also feeds `shells`, `shellsFor` and `statesFor` so the
 * remote list and the shared In use section need no poll of their own. `machines` keeps its reference across polls that change nothing.
 */
export function useMachineSwitcher(): MachineSwitcher {
  const { machines: fleet } = useFleet();
  const selfName = useSelfDeviceName();
  const base = useMemo(() => buildMachineList(selfName, fleet), [selfName, fleet]);
  const shells = useFleetShells(base);
  const localState = useMachineAgentState();
  const machines = useMemo(() => withAgentStates(base, localState, shells), [base, localState, shells]);
  const [selected, setSelected] = useState<string>(LOCAL_MACHINE_ID);
  const activeId = resolveActiveId(selected, machines);

  useEffect(() => {
    if (activeId !== selected) setSelected(LOCAL_MACHINE_ID);
  }, [activeId, selected]);

  const select = useCallback((deviceId: string) => {
    if (deviceId !== activeId) setSelected(deviceId);
  }, [activeId]);

  const shellsFor = useCallback((deviceId: string) => shells.get(deviceId)?.aliveProjectIds ?? NO_SHELLS, [shells]);
  const statesFor = useCallback((deviceId: string) => shells.get(deviceId)?.projectStates ?? NO_STATES, [shells]);
  const active = machines.find((m) => m.deviceId === activeId) ?? machines[0]!;
  return { machines, activeId, active, select, shells, shellsFor, statesFor };
}
