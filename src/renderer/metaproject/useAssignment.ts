/** Loads registered assignments and current-account project choices without sharing stale picker results. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '@renderer/api';
import type { MetaprojectAssignment, MetaprojectFailure, MetaprojectRemoteProject, MetaprojectResult } from '@shared/metaproject-contract';
import { useMetaprojectSession } from './session';

export type Load<T> = { kind: 'loading' } | { kind: 'error'; reason: MetaprojectFailure } | { kind: 'loaded'; value: T };
const loading = { kind: 'loading' } as const;

function useLoad<T>(scope: string | null, load: () => Promise<Load<T>>) {
  const [state, setState] = useState<{ scope: string; cleared: number; result: Load<T> }>();
  const [request, setRequest] = useState({ generation: 0, cleared: 0 });
  const revision = useRef(0);
  const invalidate = useCallback((clear: boolean) => {
    revision.current += 1;
    setRequest(({ generation, cleared }) => ({ generation: generation + 1, cleared: cleared + Number(clear) }));
  }, []);
  const reload = useCallback(() => invalidate(true), [invalidate]);
  const refresh = useCallback(() => invalidate(false), [invalidate]);
  useLayoutEffect(() => () => { revision.current += 1; }, [scope]);
  useEffect(() => {
    if (scope === null) { setState(undefined); return; }
    const version = ++revision.current;
    const finish = (result: Load<T>) => { if (revision.current === version) setState({ scope, cleared: request.cleared, result }); };
    void load().then(finish).catch(() => finish({ kind: 'error', reason: 'unavailable' }));
  }, [scope, request, load]);
  const cached = state?.scope === scope ? state : undefined;
  return { state: cached?.cleared === request.cleared ? cached.result : loading, previous: cached?.result, reload, refresh };
}

function asLoad<T>(result: MetaprojectResult<T>): Load<T> {
  return result.ok ? { kind: 'loaded', value: result.value } : { kind: 'error', reason: result.reason };
}

/** Rechecks broad project changes without interrupting a view whose authority is unchanged. */
export function useAssignment(projectId: number | null) {
  const { snapshot } = useMetaprojectSession();
  const load = useCallback(async () => {
    if (projectId === null) return loading;
    const result = await api.invoke('metaproject:assignment-get', { projectId });
    if (result.ok && result.value.projectId !== projectId) return { kind: 'error', reason: 'stale' } as const;
    return asLoad(result);
  }, [projectId]);
  const result = useLoad(projectId === null ? null : `${projectId}:${snapshot?.epoch ?? '-'}:${snapshot?.origin ?? '-'}`, load);
  const { reload, refresh } = result;
  useEffect(() => {
    if (projectId === null) return;
    const offAssignment = api.on('metaproject:assignment-changed', ({ projectId: changed }) => { if (changed === projectId) reload(); });
    const offProjects = api.on('projects:changed', ({ projectId: changed, kind }) => {
      if (changed !== undefined && changed !== projectId) return;
      if (changed === projectId && kind === 'removed') reload(); else refresh();
    });
    return () => { offAssignment(); offProjects(); };
  }, [projectId, reload, refresh]);
  return result;
}

/** Loads allowed remote projects only while a picker for the current signed-in epoch is open. */
export function useAssignmentChoices(open: boolean) {
  const { snapshot, current } = useMetaprojectSession();
  const epoch = open && snapshot?.phase === 'signed-in' ? snapshot.epoch : null;
  const load = useCallback(async (): Promise<Load<MetaprojectRemoteProject[]>> => {
    if (epoch === null) return loading;
    const result = await api.invoke('metaproject:assignment-list', { epoch });
    const now = current();
    if (now?.phase !== 'signed-in' || now.epoch !== epoch) return loading;
    if (!result.ok) return { kind: 'error', reason: result.reason };
    return result.value.epoch === epoch ? { kind: 'loaded', value: result.value.projects } : { kind: 'error', reason: 'stale' };
  }, [current, epoch]);
  return useLoad(epoch === null ? null : String(epoch), load);
}
