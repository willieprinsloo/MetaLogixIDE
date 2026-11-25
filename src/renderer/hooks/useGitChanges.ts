import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@renderer/api';
import type { RemoteWorkspace } from '@renderer/p2p/remote-workspace';
import {
  changesStateFrom,
  changesStateFromFailure,
  createRequestGate,
  type ChangesState,
} from '@renderer/diff/diff-load-state';

export interface GitChanges {
  state: ChangesState;
  /** Bumped on every applied list response (poll or refresh), so the selected diff reloads with it. */
  reloadToken: number;
  refresh: () => void;
}

interface LoadedChanges {
  projectId: number;
  remote: RemoteWorkspace | undefined;
  state: ChangesState;
}

/**
 * Polls `git:panel-status` for the Diff tab every `intervalMs` while mounted (spec AC21, AC24): a poll tick
 * is skipped while a request is in flight, and a response that a newer request or unmount has superseded
 * is dropped (AC29). A manual refresh supersedes a local request; it queues behind a remote one.
 */
export function useGitChanges(projectId: number, intervalMs = 3000, remote?: RemoteWorkspace): GitChanges {
  const [loaded, setLoaded] = useState<LoadedChanges | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const gateRef = useRef(createRequestGate());
  const pendingRefresh = useRef(false);

  const load = useCallback(
    async function loadStatus(fromPoll: boolean) {
      const gate = gateRef.current;
      if (gate.inFlight && (fromPoll || remote)) {
        if (!fromPoll) pendingRefresh.current = true;
        return;
      }
      const seq = gate.begin();
      try {
        const result = remote
          ? await remote.call('workspace.diffStatus', { projectId })
          : await api.invoke('git:panel-status', { projectId });
        const state = changesStateFrom(result);
        if (gate.isLatest(seq)) setLoaded({ projectId, remote, state });
      } catch (e) {
        if (gate.isLatest(seq)) setLoaded({ projectId, remote, state: changesStateFromFailure(e) });
      } finally {
        if (gate.isLatest(seq)) {
          setReloadToken((t) => t + 1);
          gate.settle(seq);
          if (pendingRefresh.current) {
            pendingRefresh.current = false;
            void loadStatus(false);
          }
        }
      }
    },
    [projectId, remote],
  );

  useEffect(() => {
    const gate = gateRef.current;
    setLoaded(null);
    void load(false);
    const id = window.setInterval(() => void load(true), intervalMs);
    return () => {
      window.clearInterval(id);
      pendingRefresh.current = false;
      gate.invalidate();
    };
  }, [load, intervalMs]);

  const refresh = useCallback(() => void load(false), [load]);
  const state = loaded?.projectId === projectId && loaded.remote === remote ? loaded.state : { phase: 'loading' } as const;
  return { state, reloadToken, refresh };
}
