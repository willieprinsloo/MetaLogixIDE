import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { AgentKind, AgentState } from '@shared/agent-state';
import { HARNESS_LABEL } from '@shared/agent-harness';
import { shellTabName } from '@shared/shell-launch-name';

export interface RemoteProjectShell {
  shellIndex: number;
  /** Tab label, derived as for local tabs. */
  launchName: string;
  /** The agent the host sees running in the shell; null for none or an older host that does not say. */
  agent: AgentKind | null;
  agentState: AgentState | null;
}

const POLL_MS = 3000;
const sameShells = (a: readonly RemoteProjectShell[], b: readonly RemoteProjectShell[]): boolean =>
  a.length === b.length && a.every((s, i) => {
    const o = b[i]!;
    return s.shellIndex === o.shellIndex && s.launchName === o.launchName && s.agent === o.agent && s.agentState === o.agentState;
  });

/**
 * The live shells (tabs) of one project on a paired machine, in tab order. Polled, because the host
 * pushes no shell-list events over P2P; `refresh` polls at once (after opening or closing a tab). A
 * failed poll keeps the last list.
 */
export function useRemoteProjectShells(deviceId: string, projectId: number, active = true): { shells: RemoteProjectShell[]; refresh: () => void } {
  const [state, setState] = useState<{ key: string; shells: RemoteProjectShell[] }>({ key: '', shells: [] });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const key = `${deviceId}:${projectId}`;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let pending = false;
    const tick = () => {
      if (pending) return;
      pending = true;
      api.invoke('p2p:rpc-call', { deviceId, method: 'shells.alive', params: {} }).then(
        (res) => {
          if (cancelled) return;
          const rows = Array.isArray(res.result) ? (res.result as Array<{ projectId: number; shellIndex: number; launchArgv?: string[]; agent?: string | null; agentState?: AgentState | null }>) : [];
          const shells = rows
            .filter((r) => r.projectId === projectId && typeof r.shellIndex === 'number')
            .sort((a, b) => a.shellIndex - b.shellIndex)
            .map((r) => {
              const agent = typeof r.agent === 'string' && Object.prototype.hasOwnProperty.call(HARNESS_LABEL, r.agent) ? (r.agent as AgentKind) : null;
              return { shellIndex: r.shellIndex, launchName: shellTabName(Array.isArray(r.launchArgv) ? r.launchArgv : [], r.shellIndex, agent), agent, agentState: r.agentState ?? null };
            });
          setState((prev) => (prev.key === key && sameShells(prev.shells, shells) ? prev : { key, shells }));
        },
        () => { /* keep the last list; the next tick retries */ },
      ).finally(() => { pending = false; });
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [active, deviceId, projectId, key, tick]);

  // A list fetched for a previous (device, project) never shows against the new one.
  return { shells: state.key === key ? state.shells : EMPTY, refresh };
}

const EMPTY: RemoteProjectShell[] = [];
