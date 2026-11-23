/** Owns the local creation draft and optional, independently cancellable assignment step. */
import { useState } from 'react';
import type { AssignmentCreateOutcome, MetaprojectResult } from '@shared/metaproject-contract';
import type { Project, Root } from '@shared/types';
import { api } from '@renderer/api';
import { useAssignmentOperation, type AssignmentChoice } from './assignment-operations';
import { assignmentReloadCopy, failureCopy } from './messages';
import { useMetaprojectSession, useSignInIntent } from './session';
import { useAssignmentChoices } from './useAssignment';

type Mode = 'empty' | 'clone';
type Wiring = { epoch: number; mode: 'none' | 'link' | 'create'; remoteId: number | null; name: string };
type LocalDraft = { mode: Mode; name: string; gitUrl: string; rootId: number | null; initGit: boolean };

/** Derives the usual project folder from HTTPS, SSH, or git@ remotes. */
export function folderFromUrl(url: string): string {
  return url.trim().replace(/\.git$/, '').replace(/[/:]$/, '').split(/[/:]/).pop() ?? '';
}

function useLocalDraft(roots: Root[], defaultRootId?: number | null) {
  const [draft, setDraft] = useState<LocalDraft>(() => ({
    mode: 'empty', name: '', gitUrl: '', initGit: true,
    rootId: roots.find((r) => r.id === defaultRootId)?.id ?? roots[0]?.id ?? null,
  }));
  const effectiveName = (draft.name.trim() || (draft.mode === 'clone' ? folderFromUrl(draft.gitUrl) : '')).trim();
  const nameOk = /^[A-Za-z0-9._-][A-Za-z0-9._ -]*$/.test(effectiveName) && effectiveName !== '.' && effectiveName !== '..';
  const gitOk = draft.mode === 'empty' || /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(draft.gitUrl.trim());
  return { ...draft, effectiveName, nameOk, gitOk, update: (next: Partial<LocalDraft>) => setDraft((prior) => ({ ...prior, ...next })) };
}

function useWiring(rootId: number | null) {
  const { snapshot, current } = useMetaprojectSession();
  const signIn = useSignInIntent(rootId);
  const [wiring, setWiring] = useState<Wiring>();
  const signedIn = snapshot?.phase === 'signed-in';
  const draft = signedIn && wiring?.epoch === snapshot.epoch ? wiring : undefined;
  const mode = draft?.mode ?? 'none';
  const selected = draft?.remoteId ?? null;
  const name = draft?.name ?? '';
  const { state: choices, reload: retryList } = useAssignmentChoices(mode === 'link');
  const update = (next: Partial<Wiring>) => {
    if (signedIn) setWiring({ epoch: snapshot.epoch, mode: 'none', remoteId: null, name: '', ...draft, ...next });
  };
  return { signedIn, mode, selected, name, choices, retryList, update, epoch: draft?.epoch, current,
    onSignIn: () => signIn('Assign a new local project', (account) => setWiring({ epoch: account.epoch, mode: 'link', remoteId: null, name: '' })) };
}

/** Runs local creation once; optional remote failure leaves the local project available. */
export function useNewProject(roots: Root[], defaultRootId: number | null | undefined, onCreated: (project: Project) => void) {
  const local = useLocalDraft(roots, defaultRootId);
  const wiring = useWiring(local.rootId);
  const operation = useAssignmentOperation(local.rootId);
  const [step, setStep] = useState<'local' | 'assignment' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Project | null>(null);
  const choice = pickAssignment(wiring);
  const canSubmit = !operation.busy && (created !== null || (local.nameOk && local.rootId !== null && local.gitOk && choice !== undefined));

  async function finishProject(project: Project, intent: Intent) {
    setCreated(project);
    if (!choice || wiring.epoch === undefined) { onCreated(project); return; }
    setStep('assignment');
    const notice = await assignFolder(project.id, { choice, epoch: wiring.epoch, current: wiring.current }, intent);
    if (!intent.current()) return;
    if (notice) setError(notice); else onCreated(project);
  }

  async function createProject(rootId: number, intent: Intent) {
    setError(null); setStep('local');
    try {
      const { project } = await createLocal(local, rootId);
      if (intent.current()) await finishProject(project, intent);
    } catch (e) { if (intent.current()) setError(String(e).replace(/^Error:\s*/, '')); }
    finally { if (intent.current()) setStep(null); }
  }

  const submit = () => operation.run(async (intent) => {
    if (!canSubmit) return;
    if (created) { onCreated(created); return; }
    if (local.rootId !== null) await createProject(local.rootId, intent);
  });
  return { local, wiring, error, created, canSubmit, submit, saving: operation.busy, canDismiss: step !== 'local',
    cancel: operation.cancel, savingStep: step === 'assignment' ? 'Assigning Metaproject…' : local.mode === 'empty' ? 'Creating project…' : 'Cloning project…' };
}

function pickAssignment(wiring: ReturnType<typeof useWiring>): AssignmentChoice | null | undefined {
  if (wiring.mode === 'none') return null;
  if (wiring.mode === 'create') return wiring.name.trim() ? { kind: 'create', name: wiring.name.trim() } : undefined;
  if (wiring.selected === null || wiring.choices.kind !== 'loaded' || !wiring.choices.value.some((p) => p.id === wiring.selected)) return undefined;
  return { kind: 'link', remoteId: wiring.selected };
}

function createLocal(local: ReturnType<typeof useLocalDraft>, rootId: number) {
  return local.mode === 'empty'
    ? api.invoke('projects:create', { rootId, name: local.effectiveName, initGit: local.initGit })
    : api.invoke('projects:clone-git', { rootId, url: local.gitUrl.trim(), name: local.effectiveName });
}

type Intent = Parameters<Parameters<ReturnType<typeof useAssignmentOperation>['run']>[0]>[0];
type NewAssignment = { choice: AssignmentChoice; epoch: number; current: ReturnType<typeof useMetaprojectSession>['current'] };

async function assignFolder(projectId: number, { choice, epoch, current }: NewAssignment, intent: Intent) {
  const stale = 'Local project created without a confirmed assignment. The account or dialog changed.';
  const valid = () => { const now = current(); return intent.current() && now?.epoch === epoch && now.phase === 'signed-in'; };
  if (!valid()) return stale;
  try {
    const context = await api.invoke('metaproject:assignment-get', { projectId });
    if (!valid()) return stale;
    if (!context.ok) return `Local project created without an assignment. ${failureCopy[context.reason]}`;
    if (context.value.projectId !== projectId) return stale;
    const result = await intent.apply(context.value, { ...choice, epoch });
    return valid() ? assignmentNotice(result) : stale;
  } catch { return 'Local project created, but its assignment could not be confirmed. Review Project Settings.'; }
}

function assignmentNotice(result: MetaprojectResult<AssignmentCreateOutcome>): string | null {
  if (!result.ok) return `Local project created without a new assignment. ${failureCopy[result.reason]} Review Project Settings.`;
  const { value } = result;
  if (value.kind === 'created-not-assigned') return `Created Metaproject project ${value.project.name} (#${value.project.id}), but it was not assigned to the local folder. ${failureCopy[value.reason]} Link the existing project from Project Settings.`;
  return value.kind === 'committed-reload' ? `${assignmentReloadCopy} Open the local project and review Project Settings.` : null;
}
