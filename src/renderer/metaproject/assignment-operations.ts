/** Fences one editor or dialog write from preflight through commit acknowledgement. */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { api } from '@renderer/api';
import type { AssignmentCreateOutcome, MetaprojectAssignment, MetaprojectRemoteProject, MetaprojectResult } from '@shared/metaproject-contract';
import { assignmentReloadCopy, failureCopy } from './messages';
import { useMetaprojectSession } from './session';

export type AssignmentChoice = { kind: 'link'; remoteId: number } | { kind: 'create'; name: string };
type Change = { kind: 'remove' } | (AssignmentChoice & { epoch: number });
type Outcome = MetaprojectResult<AssignmentCreateOutcome>;
type Intent = { current: () => boolean; apply: (project: MetaprojectAssignment, change: Change) => Promise<Outcome> };
type Ticket = { operationId: string; sent: boolean };

/** Close the local intent first, then send cancellation before another write can start. */
export function useAssignmentOperation(scope: string | number | null) {
  const active = useRef<Ticket | null>(null);
  const live = useRef(false);
  const [busy, setBusy] = useState(false);
  const cancel = useCallback(() => {
    const ticket = active.current;
    active.current = null;
    if (ticket?.sent) void api.invoke('metaproject:assignment-cancel', { operationId: ticket.operationId }).catch(() => undefined);
    if (live.current && ticket) setBusy(false);
  }, []);
  useLayoutEffect(() => {
    live.current = true;
    setBusy(false);
    return () => { live.current = false; cancel(); };
  }, [scope, cancel]);

  const run = async (action: (intent: Intent) => Promise<void>) => {
    if (!live.current || active.current) return;
    const ticket = { operationId: crypto.randomUUID(), sent: false };
    active.current = ticket;
    setBusy(true);
    const current = () => active.current === ticket;
    try { await action({ current, apply: (project, change) => apply(project, change, ticket, current) }); }
    finally { if (current()) { active.current = null; setBusy(false); } }
  };
  return { run, busy, cancel };
}

async function apply(project: MetaprojectAssignment, change: Change, ticket: Ticket, current: () => boolean): Promise<Outcome> {
  if (!current() || ticket.sent) return { ok: false, reason: 'stale' };
  if (!('revision' in project)) return { ok: false, reason: project.kind === 'invalid' ? 'invalid-file' : 'unavailable' };
  const context = { projectId: project.projectId, revision: project.revision, operationId: ticket.operationId };
  ticket.sent = true;
  try {
    if (change.kind === 'remove') return await api.invoke('metaproject:assignment-remove', context);
    if (change.kind === 'link') return await api.invoke('metaproject:assignment-save', { ...context, epoch: change.epoch, remoteId: change.remoteId });
    return await api.invoke('metaproject:assignment-create', { ...context, epoch: change.epoch, name: change.name });
  } catch { return { ok: false, reason: 'unavailable' }; }
  finally { ticket.sent = false; }
}

type Mode = 'none' | 'link' | 'create' | 'remove';
type Feedback = { text: string; error: boolean };
type Resolution = { feedback: Feedback; partial?: MetaprojectRemoteProject; assignment?: MetaprojectAssignment; reload?: true };

function resolve(result: Outcome, removed: boolean): Resolution {
  if (!result.ok) return { feedback: { text: failureCopy[result.reason], error: true } };
  const { value } = result;
  if (value.kind === 'created-not-assigned') return { partial: value.project, feedback: {
    text: `Created ${value.project.name} (#${value.project.id}) but did not assign the folder. ${failureCopy[value.reason]} Link the existing project instead of creating it again.`, error: true,
  } };
  if (value.kind === 'committed-reload') return { reload: true, feedback: { text: assignmentReloadCopy, error: true } };
  return { assignment: value.assignment, feedback: { text: removed ? 'Assignment removed.' : 'Metaproject assignment saved.', error: false } };
}

/** Controls explicit assignment intent, partial success, and safe reload in the named editor. */
export function useAssignmentEditor(assignment: MetaprojectAssignment, initialLink: boolean) {
  const { snapshot, current } = useMetaprojectSession();
  const operation = useAssignmentOperation(assignment.projectId);
  const [mode, setMode] = useState<Mode | null>(null);
  const [selected, select] = useState<number | null>(null);
  const [resolution, setResolution] = useState<{ from: MetaprojectAssignment; result: Resolution }>();
  const activeMode = mode ?? (initialLink ? 'link' : 'none');
  const result = resolution?.result;
  const freshResolution = resolution?.from === assignment ? result : undefined;
  const context = freshResolution?.assignment ?? assignment;
  const signedIn = snapshot?.phase === 'signed-in';
  const mutate = (choice: AssignmentChoice | { kind: 'remove' }) => operation.run(async (intent) => {
    const now = current();
    const epoch = now?.epoch;
    if (choice.kind !== 'remove' && (now?.phase !== 'signed-in' || snapshot?.epoch !== now.epoch)) return;
    const response = await intent.apply(context, choice.kind === 'remove' ? choice : { ...choice, epoch: now?.epoch ?? -1 });
    if (!intent.current() || (choice.kind !== 'remove' && current()?.epoch !== epoch)) return;
    const result = resolve(response, choice.kind === 'remove');
    setResolution({ from: assignment, result });
    if (response.ok) { setMode(result.partial ? 'link' : 'none'); select(result.partial?.id ?? null); }
  });
  const changeMode = (next: Mode) => {
    operation.cancel();
    setMode(next);
    if (next === 'none') select(null);
  };
  return { context, activeMode, signedIn, selected, select, mutate, changeMode, busy: operation.busy,
    blocked: freshResolution?.reload === true, feedback: result?.feedback, partial: result?.partial };
}
