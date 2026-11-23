/** Named project assignment editor reused from Project Settings and the Chat sidebar. */
import { useId, useState } from 'react';
import type { MetaprojectAssignment, MetaprojectRemoteProject } from '@shared/metaproject-contract';
import { failureCopy, mpButton, mpInput } from './messages';
import { AccountStatus, SignedInPersistenceWarning, useMetaprojectSession, useSignInIntent } from './session';
import { useAssignment, useAssignmentChoices, type Load } from './useAssignment';
import { useAssignmentEditor } from './assignment-operations';

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
  const editor = useAssignmentEditor(assignment, initialLink);
  const { context, signedIn, busy, feedback, blocked } = editor;
  return <div className="space-y-3">
    <div className="break-words"><strong>{context.localName}</strong><div className="text-[--text-muted]">{context.localPath}</div></div>
    {!blocked && <AssignmentSummary assignment={context} />}
    {signedIn ? <SignedInPersistenceWarning /> : <AccountStatus onSignIn={onSignIn} />}
    {!blocked && 'revision' in context && <AssignmentActions editor={editor} disabled={busy || checking} allowCreate={allowCreate} />}
    {busy && <p role="status">Applying assignment…</p>}
    {feedback && <p role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
    {!busy && !checking && (feedback?.error || !('revision' in context)) && <button type="button" className={mpButton} onClick={reload}>Reload assignment</button>}
  </div>;
}

type ActionsProps = { editor: ReturnType<typeof useAssignmentEditor>; disabled: boolean; allowCreate: boolean };

function AssignmentActions({ editor, disabled, allowCreate }: ActionsProps) {
  const { context, activeMode, signedIn, partial, selected, select, changeMode, mutate } = editor;
  const [name, setName] = useState('');
  const { state: choices, reload: retryList } = useAssignmentChoices(activeMode === 'link');
  const selectedChoice = choices.kind === 'loaded' && choices.value.some((p) => p.id === selected);
  return <>
      <div className="flex flex-wrap gap-2">
        {signedIn && <button type="button" className={mpButton} disabled={disabled} onClick={() => changeMode('link')}>{context.kind === 'linked' ? 'Change assignment' : 'Link existing'}</button>}
        {allowCreate && signedIn && !partial && <button type="button" className={mpButton} disabled={disabled} onClick={() => changeMode('create')}>Create and link</button>}
        {context.kind !== 'unlinked' && <button type="button" className={mpButton} disabled={disabled} onClick={() => changeMode('remove')}>Remove assignment</button>}
      </div>
      {signedIn && activeMode === 'link' && <div className="space-y-2">
        <AssignmentChoices choices={choices} onRetry={retryList} selected={selected} onSelect={select} disabled={disabled} />
        {context.kind !== 'unlinked' && <p>This replaces the current assignment for {context.localName}.</p>}
        <button type="button" className={mpButton} disabled={disabled || !selectedChoice || selected === null} onClick={() => { if (selected !== null) void mutate({ kind: 'link', remoteId: selected }); }}>Save assignment</button>
      </div>}
      {signedIn && activeMode === 'create' && <div className="space-y-2">
        <label className="block">New Metaproject project name<input className={mpInput} value={name} maxLength={255} disabled={disabled} onChange={(e) => setName(e.target.value)} /></label>
        {context.kind !== 'unlinked' && <p>This replaces the current assignment for {context.localName}.</p>}
        <button type="button" className={mpButton} disabled={disabled || !name.trim()} onClick={() => void mutate({ kind: 'create', name: name.trim() })}>Create project and save assignment</button>
      </div>}
      {activeMode === 'remove' && <div className="space-y-2"><p>Remove the assignment for {context.localName}? This only changes the local folder.</p><button type="button" className={mpButton} disabled={disabled} onClick={() => void mutate({ kind: 'remove' })}>Confirm removal</button></div>}
      {activeMode !== 'none' && <button type="button" className={mpButton} onClick={() => changeMode('none')}>Cancel assignment change</button>}
  </>;
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
