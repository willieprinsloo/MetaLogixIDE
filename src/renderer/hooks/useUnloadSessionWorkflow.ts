import { useEffect, useRef, useState } from 'react';
import type { Project } from '@shared/types';
import type { PrimarySessionInspection } from '@shared/unload-session-contract';
import { api } from '@renderer/api';
import { UNLOAD_SESSION_COPY as COPY } from '@renderer/unload-session-copy';
import { consentRisk, currentSessionRisk, needsFreshConsent, type SessionRisk } from '@renderer/unload-session';

type Target = Pick<Project, 'id' | 'name'>;
type LiveInspection = Extract<PrimarySessionInspection, { kind: 'live' }>;

/** A pending stop always refers to the generation whose risk was explicitly accepted. */
export type UnloadSessionState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly inspection: LiveInspection; readonly consent: SessionRisk; readonly error: string | null }
  | { readonly kind: 'pending'; readonly inspection: LiveInspection; readonly consent: SessionRisk }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'gone' }
  | { readonly kind: 'replaced' };

type Ready = Extract<UnloadSessionState, { kind: 'ready' }>;
type Transition = UnloadSessionState | 'stopped';

function inspectedState(inspection: PrimarySessionInspection, visible: boolean): UnloadSessionState {
  return inspection.kind === 'gone' ? { kind: 'gone' }
    : { kind: 'ready', inspection, consent: consentRisk(inspection, visible), error: null };
}

async function inspectEscalation(ready: Ready, projectId: number, visible: boolean): Promise<UnloadSessionState> {
  const refreshed = inspectedState(await api.invoke('shells:inspect-primary', { projectId }), visible);
  if (refreshed.kind !== 'ready') return refreshed;
  if (refreshed.inspection.generation !== ready.inspection.generation) return { kind: 'replaced' };
  return { ...refreshed, error: COPY.escalated };
}

async function stopInspected(ready: Ready, projectId: number, current: () => { visible: boolean; signal: 'idle' | 'busy' | 'blocked' }): Promise<Transition> {
  const next = await api.invoke('shells:inspect-primary', { projectId });
  if (next.kind === 'gone') return { kind: 'gone' };
  if (next.generation !== ready.inspection.generation) return { kind: 'replaced' };
  const { visible, signal } = current();
  const risk = currentSessionRisk(next, visible, signal);
  if (needsFreshConsent(ready.consent, risk)) {
    return { kind: 'ready', inspection: next, consent: risk, error: COPY.escalated };
  }
  const outcome = await api.invoke('shells:stop-primary', {
    projectId, generation: ready.inspection.generation, acknowledgedWorkRisk: risk.work,
  });
  if (outcome.kind === 'stopped') return 'stopped';
  if (outcome.kind === 'escalated') return inspectEscalation(ready, projectId, current().visible);
  return { kind: outcome.kind };
}

/** Inspects and revalidates exactly one live primary generation before its guarded stop. */
export function useUnloadSessionWorkflow(
  target: Target,
  visible: boolean,
  signal: 'idle' | 'busy' | 'blocked',
  onClose: () => void,
  onStopped: () => void,
): { readonly state: UnloadSessionState; readonly risk: SessionRisk; readonly confirm: () => Promise<void>; readonly retry: () => Promise<void> } {
  const [state, setState] = useState<UnloadSessionState>({ kind: 'loading' });
  const pending = useRef(false);
  const active = useRef(true);
  const current = useRef({ visible, signal });
  current.current = { visible, signal };

  useEffect(() => {
    active.current = true;
    void api.invoke('shells:inspect-primary', { projectId: target.id }).then((inspection) => {
      if (active.current) setState(inspectedState(inspection, current.current.visible));
    }).catch(() => { if (active.current) setState({ kind: 'error', message: COPY.inspectionFailed }); });
    return () => { active.current = false; };
  }, [target.id]);

  async function retry(): Promise<void> {
    if (pending.current) return;
    pending.current = true;
    setState({ kind: 'loading' });
    try {
      const next = inspectedState(await api.invoke('shells:inspect-primary', { projectId: target.id }), current.current.visible);
      if (active.current) setState(next);
    } catch {
      if (active.current) setState({ kind: 'error', message: COPY.inspectionFailed });
    } finally { pending.current = false; }
  }

  async function confirm(): Promise<void> {
    if (state.kind !== 'ready' || pending.current) return;
    pending.current = true;
    setState({ kind: 'pending', inspection: state.inspection, consent: state.consent });
    try {
      const next = await stopInspected(state, target.id, () => current.current);
      if (!active.current) return;
      if (next === 'stopped') { onStopped(); onClose(); }
      else setState(next);
    } catch {
      if (active.current) setState({ kind: 'error', message: COPY.stopFailed });
    } finally { pending.current = false; }
  }

  const inspection = state.kind === 'ready' || state.kind === 'pending' ? state.inspection : { kind: 'gone' as const };
  const risk = currentSessionRisk(inspection, visible, signal);
  return { state, risk, confirm, retry };
}
