import { useEffect, useReducer, useRef } from 'react';
import { api } from '@renderer/api';
import type { RemoteWorkspace } from '@renderer/p2p/remote-workspace';
import { entryKey, sidesRequestFor, type DiffEntry } from '@renderer/diff/diff-selection';
import {
  IDLE_SIDES,
  createRequestGate,
  diffSidesReducer,
  errorText,
  planSidesRequest,
  type DiffSidesState,
} from '@renderer/diff/diff-load-state';

/**
 * Loads `git:diff-sides` for the selected Diff tab entry (spec AC17, AC20, AC23, AC30). A new selection
 * shows loading; each `reloadToken` bump reloads quietly with `ifDiffHashNot`, and an `unchanged` or
 * identical response leaves the state object untouched, so nothing re-renders. Each `refreshToken` bump
 * (a manual Refresh) reads the full sides again, as does a reload while a side fails the content check
 * (AC38). Superseded responses are dropped.
 */
export function useDiffSides(projectId: number, entry: DiffEntry | null, reloadToken: number, refreshToken: number, remote?: RemoteWorkspace): DiffSidesState {
  const [state, dispatch] = useReducer(diffSidesReducer, IDLE_SIDES);
  const stateRef = useRef(state);
  stateRef.current = state;
  const gateRef = useRef(createRequestGate());
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const refreshRef = useRef(refreshToken);
  const remotePending = useRef(false);
  const [settledToken, retryPending] = useReducer((token: number) => token + 1, 0);
  const key = entry ? entryKey(entry) : null;
  const origPath = entry?.origPath;

  useEffect(() => {
    dispatch({ type: 'select', key });
  }, [key]);

  useEffect(() => {
    const current = entryRef.current;
    if (!current || key === null) return;
    const gate = gateRef.current;
    if (remote && gate.inFlight) {
      remotePending.current = true;
      return;
    }
    const forced = refreshRef.current !== refreshToken;
    refreshRef.current = refreshToken;
    const plan = planSidesRequest(stateRef.current, key, gate.inFlight, forced);
    if (plan.skip) return;
    const seq = gate.begin();
    const params = { projectId, ...sidesRequestFor(current), ...plan.extra };
    const response = remote ? remote.call('workspace.diffSides', params) : api.invoke('git:diff-sides', params);
    response
      .then((response) => {
        if (gate.isLatest(seq)) dispatch({ type: 'response', key, response });
      })
      .catch((e: unknown) => {
        if (gate.isLatest(seq)) dispatch({ type: 'failure', key, message: errorText(e) });
      })
      .finally(() => {
        if (!gate.isLatest(seq)) return;
        gate.settle(seq);
        if (remotePending.current) {
          remotePending.current = false;
          retryPending();
        }
      });
  }, [projectId, key, origPath, reloadToken, refreshToken, settledToken, remote]);

  useEffect(() => {
    const gate = gateRef.current;
    return () => {
      remotePending.current = false;
      gate.invalidate();
    };
  }, []);

  return state;
}
