/** Loads registered assignments and current-account project choices without sharing stale picker results. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '@renderer/api';
import type { AssignmentCreateOutcome, MetaprojectAssignment, MetaprojectFailure, MetaprojectRemoteProject, MetaprojectResult } from '@shared/metaproject-contract';
import { useMetaprojectSession } from './session';

export type Load<T> = { kind: 'loading' } | { kind: 'error'; reason: MetaprojectFailure } | { kind: 'loaded'; value: T };
const loading = { kind: 'loading' } as const;

function useLoad<T>(scope: string | null, load: () => Promise<Load<T>>) {
  const [state, setState] = useState<{ scope: string; generation: number; result: Load<T> }>();
  const [generation, bump] = useState(0);
  const revision = useRef(0);
  const reload = useCallback(() => {
    revision.current += 1;
    bump((n) => n + 1);
  }, []);
  useLayoutEffect(() => () => { revision.current += 1; }, [scope]);
  useEffect(() => {
    if (scope === null) { setState(undefined); return; }
    const version = ++revision.current;
    void load().then((result) => {
      if (revision.current === version) setState({ scope, generation, result });
    }).catch(() => {
      if (revision.current === version) setState({ scope, generation, result: { kind: 'error', reason: 'unavailable' } });
    });
  }, [scope, generation, load]);
  const cached = state?.scope === scope ? state : undefined;
  return { state: cached?.generation === generation ? cached.result : loading, previous: cached?.result, reload };
}

function asLoad<T>(result: MetaprojectResult<T>): Load<T> {
  return result.ok ? { kind: 'loaded', value: result.value } : { kind: 'error', reason: result.reason };
}

/** Loads the current local folder assignment and invalidates it on named assignment or origin changes. */
export function useAssignment(projectId: number | null) {
  const { snapshot } = useMetaprojectSession();
  const load = useCallback(async () => {
    if (projectId === null) return loading;
    const result = await api.invoke('metaproject:assignment-get', { projectId });
    if (result.ok && result.value.projectId !== projectId) return { kind: 'error', reason: 'stale' } as const;
    return asLoad(result);
  }, [projectId]);
  const result = useLoad(projectId === null ? null : `${projectId}:${snapshot?.epoch ?? '-'}:${snapshot?.origin ?? '-'}`, load);
  const { reload } = result;
  useEffect(() => {
    if (projectId === null) return;
    return api.on('metaproject:assignment-changed', (event) => { if (event.projectId === projectId) reload(); });
  }, [projectId, reload]);
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

export type AssignmentChoice = { kind: 'link'; remoteId: number } | { kind: 'create'; name: string };

/** Applies exactly one remote link or create-and-link against the explicit committed folder revision. */
export async function applyAssignment(project: MetaprojectAssignment, epoch: number, choice: AssignmentChoice): Promise<MetaprojectResult<AssignmentCreateOutcome>> {
  if (!('revision' in project)) return { ok: false, reason: project.kind === 'invalid' ? 'invalid-file' : 'unavailable' };
  const context = { projectId: project.projectId, revision: project.revision, epoch };
  try {
    if (choice.kind === 'create') return await api.invoke('metaproject:assignment-create', { ...context, name: choice.name });
    const result = await api.invoke('metaproject:assignment-save', { ...context, remoteId: choice.remoteId });
    return result.ok ? { ok: true, value: { kind: 'assigned', assignment: result.value } } : result;
  } catch { return { ok: false, reason: 'unavailable' }; }
}
