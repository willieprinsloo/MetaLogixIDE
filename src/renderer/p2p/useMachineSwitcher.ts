import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFleet } from './useFleet';
import { useSelfDeviceName } from './useSelfDeviceName';
import { buildMachineList, resolveActiveId } from '../machine-dots';
import { LOCAL_MACHINE_ID, type MachineDot } from '../machine-switcher-contract';

/** The switcher's state: ordered dots, the active id and its dot, and `select`. */
export interface MachineSwitcher {
  machines: MachineDot[];
  activeId: string;
  active: MachineDot;
  select: (deviceId: string) => void;
}

/**
 * Sidebar machine-switcher state (docs/specs/machine-switcher-dots.md AC10–AC12, AC15). Always
 * starts on this machine and is never persisted. When a successful fleet poll drops the selected
 * peer, the selection resets to this machine, so the peer coming back does not re-select itself; a
 * failed poll keeps the last list (useFleet leaves `machines` untouched on error), so nothing moves.
 */
export function useMachineSwitcher(): MachineSwitcher {
  const { machines: fleet } = useFleet();
  const selfName = useSelfDeviceName();
  const machines = useMemo(() => buildMachineList(selfName, fleet), [selfName, fleet]);
  const [selected, setSelected] = useState<string>(LOCAL_MACHINE_ID);
  const activeId = resolveActiveId(selected, machines);

  useEffect(() => {
    if (activeId !== selected) setSelected(LOCAL_MACHINE_ID);
  }, [activeId, selected]);

  const select = useCallback((deviceId: string) => {
    if (deviceId !== activeId) setSelected(deviceId);
  }, [activeId]);

  const active = machines.find((m) => m.deviceId === activeId) ?? machines[0]!;
  return { machines, activeId, active, select };
}
