/** Named project assignment editor reused from Project Settings and the Chat sidebar. */
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { api } from '@renderer/api';
import type { MetaprojectAssignment, MetaprojectRemoteProject } from '@shared/metaproject-contract';
import { failureCopy, mpButton, mpInput } from './messages';
import { AccountStatus, useMetaprojectSession, useSignInIntent } from './session';
import { applyAssignment, useAssignment, useAssignmentChoices, type AssignmentChoice, type Load } from './useAssignment';

interface ChoicesProps {
  choices: Load<MetaprojectRemoteProject[]>; onRetry: () => void;
  selected: number | null; onSelect: (project: number | null) => void; disabled?: boolean;
}

/** Shows loading, failed and actually empty responses separately before offering a labelled picker. */
export function AssignmentChoices({ choices, onRetry, selected, onSelect, disabled }: ChoicesProps) {
  const id = useId();
  if (choices.kind === 'loading') return <p role="status">Loading accessible Metaproject projects…</p>;
  if (choices.kind === 'error') return <div role="alert">{failureCopy[choices.reason]} <button type="button" className={mpButton} onClick={onRetry}>Retry project list</button></div>;
  if (!choices.value.length) return <p role="status">No accessible Metaproject projects.</p>;
  return <div className="space-y-1">
    <label htmlFor={id}>Metaproject project</label>
    <select id={id} data-testid="mp-link-select" className={mpInput} value={selected ?? ''} disabled={disabled} onChange={(e) => onSelect(Number(e.target.value) || null)}>
      <option value="">Choose a project</option>
      {choices.value.map((p) => <option key={p.id} value={p.id}>{p.name}{p.identifier ? ` (${p.identifier})` : ''} · #{p.id}</option>)}
    </select>
  </div>;
}

/** Shows the local folder, authoritative assignment and explicit mutations for just that folder. */
export function AssignmentPanel({ projectId, compact = false }: { projectId: number; compact?: boolean }) {
  const { state, previous, reload } = useAssignment(projectId);
  const { snapshot } = useMetaprojectSession();
  const signIn = useSignInIntent(projectId);
  const [resumed, setResumed] = useState<{ projectId: number; epoch: number }>();
  const initialLink = resumed?.projectId === projectId && resumed.epoch === snapshot?.epoch;
  const visible = state.kind === 'loading' ? previous : state;
  return <section aria-label="Metaproject assignment" className={compact ? 'max-h-[55%] shrink-0 overflow-auto border-b border-[--border] p-3 text-xs' : 'border-t border-[--border] pt-6 text-sm'}>
    <h3 className="mb-2 font-semibold">Metaproject assignment</h3>
    {state.kind === 'loading' && <p role="status">Loading assignment…</p>}
    {state.kind === 'error' && <div role="alert">{failureCopy[state.reason]} <button className={mpButton} onClick={reload}>Reload assignment</button></div>}
    {visible?.kind === 'loaded' && <AssignmentEditor key={`${projectId}:${snapshot?.epoch}:${snapshot?.origin}`} assignment={visible.value} reload={reload}
      checking={state.kind === 'loading'} allowCreate={compact} initialLink={initialLink}
      onSignIn={() => signIn(`Assign ${visible.value.localName}`, (signedIn) => setResumed({ projectId, epoch: signedIn.epoch }))} />}
  </section>;
}

interface EditorProps { assignment: MetaprojectAssignment; reload: () => void; checking: boolean; onSignIn: () => void; allowCreate: boolean; initialLink: boolean }

function AssignmentEditor({ assignment, reload, checking, onSignIn, allowCreate, initialLink }: EditorProps) {
  const { snapshot, current } = useMetaprojectSession();
  const [mode, setMode] = useState<'none' | 'link' | 'create' | 'remove' | null>(null);
  const activeMode = mode ?? (initialLink ? 'link' : 'none');
  const [selected, select] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const [partial, setPartial] = useState<MetaprojectRemoteProject | null>(null);
  const [committed, setCommitted] = useState<{ from: MetaprojectAssignment; value: MetaprojectAssignment }>();
  const context = committed?.from === assignment ? committed.value : assignment;
  const live = useRef(false);
  useLayoutEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const { state: choices, reload: retryList } = useAssignmentChoices(activeMode === 'link');
  const signedIn = snapshot?.phase === 'signed-in';
  const selectedChoice = choices.kind === 'loaded' && choices.value.some((p) => p.id === selected);

  async function mutate(choice: AssignmentChoice | 'remove') {
    if (busy || checking || !('revision' in context) || (choice !== 'remove' && !signedIn)) return;
    const epoch = snapshot?.epoch;
    setBusy(true); setFeedback(null);
    try {
      if (choice === 'remove') {
        const result = await api.invoke('metaproject:assignment-remove', { projectId: context.projectId, revision: context.revision });
        if (!live.current) return;
        if (!result.ok) { setFeedback({ text: failureCopy[result.reason], error: true }); return; }
        setCommitted({ from: assignment, value: result.value }); setMode('none'); setFeedback({ text: 'Assignment removed.', error: false });
      } else if (epoch !== undefined) {
        const result = await applyAssignment(context, epoch, choice);
        if (!live.current || current()?.epoch !== epoch) return;
        if (!result.ok) { setFeedback({ text: failureCopy[result.reason], error: true }); return; }
        if (result.value.kind === 'created-not-assigned') {
          setPartial(result.value.project); select(result.value.project.id); setMode('link');
          setFeedback({ text: `Created ${result.value.project.name} (#${result.value.project.id}) but did not assign the folder. ${failureCopy[result.value.reason]} Link the existing project instead of creating it again.`, error: true });
          return;
        }
        setCommitted({ from: assignment, value: result.value.assignment }); setMode('none'); setPartial(null); select(null);
        setFeedback({ text: 'Metaproject assignment saved.', error: false });
      }
    } catch { if (live.current) setFeedback({ text: failureCopy.unavailable, error: true }); }
    finally { if (live.current) setBusy(false); }
  }

  return <div className="space-y-3">
    <div className="break-words"><strong>{context.localName}</strong><div className="text-[--text-muted]">{context.localPath}</div></div>
    <AssignmentSummary assignment={context} />
    {!signedIn && <AccountStatus onSignIn={onSignIn} />}
    {'revision' in context && <>
      <div className="flex flex-wrap gap-2">
        {signedIn && <button type="button" className={mpButton} disabled={busy || checking} onClick={() => setMode('link')}>{context.kind === 'linked' ? 'Change assignment' : 'Link existing'}</button>}
        {allowCreate && signedIn && !partial && <button type="button" className={mpButton} disabled={busy || checking} onClick={() => setMode('create')}>Create and link</button>}
        {context.kind !== 'unlinked' && <button type="button" className={mpButton} disabled={busy || checking} onClick={() => setMode('remove')}>Remove assignment</button>}
      </div>
      {signedIn && activeMode === 'link' && <div className="space-y-2">
        <AssignmentChoices choices={choices} onRetry={retryList} selected={selected} onSelect={select} disabled={busy || checking} />
        {context.kind !== 'unlinked' && <p>This replaces the current assignment for {context.localName}.</p>}
        <button type="button" className={mpButton} disabled={busy || checking || !selectedChoice || selected === null} onClick={() => { if (selected !== null) void mutate({ kind: 'link', remoteId: selected }); }}>Save assignment</button>
      </div>}
      {signedIn && activeMode === 'create' && <div className="space-y-2">
        <label className="block">New Metaproject project name<input className={mpInput} value={name} maxLength={255} disabled={busy || checking} onChange={(e) => setName(e.target.value)} /></label>
        {context.kind !== 'unlinked' && <p>This replaces the current assignment for {context.localName}.</p>}
        <button type="button" className={mpButton} disabled={busy || checking || !name.trim()} onClick={() => void mutate({ kind: 'create', name: name.trim() })}>Create project and save assignment</button>
      </div>}
      {activeMode === 'remove' && <div className="space-y-2"><p>Remove the assignment for {context.localName}? This only changes the local folder.</p><button type="button" className={mpButton} disabled={busy || checking} onClick={() => void mutate('remove')}>Confirm removal</button></div>}
      {activeMode !== 'none' && <button type="button" className={mpButton} disabled={busy || checking} onClick={() => { setMode('none'); select(null); }}>Cancel assignment change</button>}
    </>}
    {busy && <p role="status">Applying assignment…</p>}
    {feedback && <p role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
    {!busy && !checking && (feedback?.error || !('revision' in context)) && <button type="button" className={mpButton} onClick={reload}>Reload assignment</button>}
  </div>;
}

function AssignmentSummary({ assignment }: { assignment: MetaprojectAssignment }) {
  switch (assignment.kind) {
    case 'linked': return <p>Assigned to project #{assignment.remoteId} at {assignment.origin}.</p>;
    case 'origin-mismatch': return <p role="alert">{failureCopy['origin-mismatch']} Linked to another service: project #{assignment.remoteId} at {assignment.origin}. Choose again to replace it.</p>;
    case 'unconfirmed': return <p>Previous assignment suggestion: #{assignment.remoteId}. Confirm it by choosing an accessible project.</p>;
    case 'unlinked': return <p>No Metaproject assignment for this folder.</p>;
    case 'invalid': return <p role="alert">{failureCopy['invalid-file']}</p>;
    case 'unavailable': return <p role="alert">Could not read the assignment file.</p>;
  }
}
