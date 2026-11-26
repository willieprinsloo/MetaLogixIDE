import { useSyncExternalStore } from 'react';
import type { FleetState, Machine } from '../core/fleet';
import { fleet } from '../platform';

export function useFleet(): FleetState {
  return useSyncExternalStore(fleet.subscribe, fleet.getSnapshot);
}

export function useMachine(deviceId: string): Machine | undefined {
  return useFleet().machines.find((m) => m.device.id === deviceId);
}
