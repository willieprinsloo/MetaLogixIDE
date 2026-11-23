import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AssignmentChoices } from '@renderer/metaproject/AssignmentPanel';
import { failureCopy } from '@renderer/metaproject/messages';
import { AccountStatus, useMetaprojectSession, useSignInIntent } from '@renderer/metaproject/session';
import { applyAssignment, useAssignmentChoices, type AssignmentChoice } from '@renderer/metaproject/useAssignment';
import type { Project, Root } from '@shared/types';
import { api } from '@renderer/api';
import { ModalFrame } from '@renderer/components/ModalFrame';
import { ICON_SIZE, ICON_STROKE } from './icon-size';

interface Props {
  open: boolean;
  roots: Root[];
  defaultRootId?: number | null;
  onClose: () => void;
  onCreated: (p: Project) => void;
}

const NAME_RE = /^[A-Za-z0-9._-][A-Za-z0-9._ -]*$/;
function isValidName(n: string): boolean { return NAME_RE.test(n) && n !== '.' && n !== '..'; }

type Mode = 'empty' | 'clone';
type MpMode = 'none' | 'link' | 'create';

/** Best-effort folder name from a git URL: strips `.git`, takes last path segment. */
function folderFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\.git$/, '').replace(/[/:]$/, '');
  const last = trimmed.split(/[/:]/).pop() ?? '';
  return last;
}

/** Creates a local folder first, with optional assignment via the shared account. */
export function NewProjectDialog({ open, ...props }: Props) {
  return open ? <NewProjectForm {...props} /> : null;
}

function NewProjectForm({ roots, defaultRootId, onClose, onCreated }: Omit<Props, 'open'>) {
  const { snapshot, current } = useMetaprojectSession();
  const [mode, setMode] = useState<Mode>('empty');
  const [name, setName] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [rootId, setRootId] = useState<number | null>(() => roots.find((r) => r.id === defaultRootId)?.id ?? roots[0]?.id ?? null);
  const [initGit, setInitGit] = useState(true);
  const signedIn = snapshot?.phase === 'signed-in';
  const signIn = useSignInIntent(rootId);
  const [wiring, setWiring] = useState<{ epoch: number; mode: MpMode; remoteId: number | null; name: string }>();
  const draft = signedIn && wiring?.epoch === snapshot.epoch ? wiring : undefined;
  const mpMode = draft?.mode ?? 'none';
  const selected = draft?.remoteId ?? null;
  const mpNewName = draft?.name ?? '';
  const { state: choices, reload: retryList } = useAssignmentChoices(mpMode === 'link');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Project | null>(null);
  const [savingStep, setSavingStep] = useState('');
  const saving = !!savingStep;
  const live = useRef(false);
  useLayoutEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const effectiveName = useMemo(() => mode === 'empty' ? name.trim() : (name.trim() || folderFromUrl(gitUrl)).trim(), [mode, name, gitUrl]);
  const nameOk = isValidName(effectiveName);
  const gitOk = mode === 'empty' || /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(gitUrl.trim());
  const mpOk = mpMode !== 'create' || !!mpNewName.trim();
  const mpLinkOk = mpMode !== 'link' || (choices.kind === 'loaded' && choices.value.some((p) => p.id === selected));
  const canSubmit = !saving && (created !== null || (nameOk && rootId !== null && gitOk && mpOk && mpLinkOk));

  function updateWiring(next: Partial<NonNullable<typeof wiring>>) {
    if (signedIn) setWiring({ epoch: snapshot.epoch, mode: 'none', remoteId: null, name: '', ...draft, ...next });
  }

  async function submit() {
    if (!canSubmit) return;
    if (created) { onCreated(created); return; }
    if (rootId === null) return;
    const epoch = draft?.epoch;
    let choice: AssignmentChoice | null = null;
    if (mpMode === 'link' && selected !== null) choice = { kind: 'link', remoteId: selected };
    if (mpMode === 'create') choice = { kind: 'create', name: mpNewName.trim() };
    setError(null);
    setSavingStep(mode === 'empty' ? 'Creating project…' : 'Cloning project…');
    try {
      const { project } = mode === 'empty' ? await api.invoke('projects:create', { rootId, name: effectiveName, initGit })
        : await api.invoke('projects:clone-git', { rootId, url: gitUrl.trim(), name: effectiveName });
      if (!live.current) return;
      setCreated(project);
      if (!choice || epoch === undefined) { onCreated(project); return; }
      setSavingStep('Assigning Metaproject…');
      const error = await assignNewFolder(project.id, epoch, choice, () => live.current && current()?.epoch === epoch && current()?.phase === 'signed-in');
      if (!live.current) return;
      if (error) setError(error); else onCreated(project);
    } catch (e) {
      if (live.current) setError(String(e).replace(/^Error:\s*/, ''));
    } finally { if (live.current) setSavingStep(''); }
  }

  return (
    <ModalFrame
      testId="new-project-dialog"
      tier="modal"
      motion="fade"
      layerClassName="flex items-center justify-center"
      onDismiss={saving ? undefined : onClose}
    >
      <div className="modal-panel modal-sheet w-[560px] max-w-[92vw] max-h-[95vh] overflow-auto">
        <div className="px-5 py-4 border-b border-[--border] flex items-center justify-between">
          <div className="font-semibold">New project</div>
          <button onClick={onClose} disabled={saving} className="text-[--modal-text-muted] hover:text-[--text] w-7 h-7 flex items-center justify-center rounded hover:bg-[--panel]" aria-label="Close">
            <XCloseIcon />
          </button>
        </div>

        <fieldset disabled={saving || !!created}>
        <div className="px-5 pt-4">
          <div className="inline-flex rounded-md border border-[--border] p-0.5 bg-[--panel]/50 text-xs">
            <button
              onClick={() => setMode('empty')}
              className={`px-3 py-1 rounded-md ${mode === 'empty' ? 'bg-[color:var(--accent)] text-[--accent-text]' : 'text-[--modal-text-muted] hover:text-[--text]'}`}
              data-testid="mode-empty"
            >
              Empty folder
            </button>
            <button
              onClick={() => setMode('clone')}
              className={`px-3 py-1 rounded-md ${mode === 'clone' ? 'bg-[color:var(--accent)] text-[--accent-text]' : 'text-[--modal-text-muted] hover:text-[--text]'}`}
              data-testid="mode-clone"
            >
              Clone git repo
            </button>
          </div>
        </div>

        <div className="p-5 space-y-4">
          {mode === 'clone' && (
            <Field label="Git URL" hint="HTTPS, SSH, or git@… — anything the system `git clone` accepts.">
              <input
                autoFocus
                value={gitUrl}
                onChange={(e) => setGitUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
                placeholder="git@github.com:owner/repo.git"
                className="w-full font-mono bg-[--panel] text-[--text] border border-[--border] rounded-md px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-[--accent]/60"
                data-testid="new-project-git-url"
              />
              {gitUrl && !gitOk && (
                <div className="text-xs text-[--danger] mt-1">
                  Expected an https://, ssh://, git://, or git@… URL.
                </div>
              )}
            </Field>
          )}

          <Field
            label="Folder name"
            hint={mode === 'clone' ? 'Optional — leave blank to derive from the git URL.' : 'Folder name inside the chosen root.'}
          >
            <input
              autoFocus={mode === 'empty'}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); if (e.key === 'Escape') onClose(); }}
              placeholder={mode === 'clone' ? (gitUrl ? folderFromUrl(gitUrl) || 'my-new-project' : 'my-new-project') : 'my-new-project'}
              className="w-full bg-[--panel] text-[--text] border border-[--border] rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-[--accent]/60"
              data-testid="new-project-name"
            />
            {(mode === 'empty' && name && !nameOk) || (mode === 'clone' && !nameOk && (name || gitUrl)) ? (
              <div className="text-xs text-[--danger] mt-1">
                Use letters, digits, dot, dash, underscore, or spaces. Must start with a letter or digit.
              </div>
            ) : null}
          </Field>

          <Field label="Root" hint="Parent folder. Add more roots in Settings.">
            <select
              value={rootId ?? ''}
              onChange={(e) => setRootId(Number(e.target.value))}
              className="w-full bg-[--panel] text-[--text] border border-[--border] rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-[--accent]/60"
              data-testid="new-project-root"
            >
              {roots.length === 0 && <option value="">No roots yet — add one in Settings</option>}
              {roots.map((r) => (
                <option key={r.id} value={r.id}>{r.path}</option>
              ))}
            </select>
          </Field>

          {mode === 'empty' && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={initGit}
                onChange={(e) => setInitGit(e.target.checked)}
                className="accent-[--accent]"
                data-testid="new-project-git"
              />
              Initialize <code className="font-mono">git</code> and a <code className="font-mono">README.md</code>
            </label>
          )}

          {!created && (
            <div className="space-y-2 pt-2 border-t border-[--border]">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-[--modal-text-muted]">Metaproject board</div>
              {!signedIn ? <AccountStatus onSignIn={() => signIn('Assign a new local project', (account) => setWiring({ epoch: account.epoch, mode: 'link', remoteId: null, name: '' }))} /> : <div className="flex flex-wrap items-center gap-3 text-xs">
                <RadioPill checked={mpMode === 'none'}   onSelect={() => updateWiring({ mode: 'none' })}>None</RadioPill>
                <RadioPill checked={mpMode === 'link'}   onSelect={() => updateWiring({ mode: 'link' })}>Link existing</RadioPill>
                <RadioPill checked={mpMode === 'create'} onSelect={() => updateWiring({ mode: 'create', name: mpNewName || effectiveName })}>Create new</RadioPill>
              </div>}
              {mpMode === 'link' && <AssignmentChoices choices={choices} onRetry={retryList} selected={selected} disabled={saving}
                onSelect={(remoteId) => updateWiring({ remoteId })} />}
              {mpMode === 'create' && (
                <div>
                  <input
                    aria-label="New Metaproject project name" maxLength={255}
                    value={mpNewName}
                    onChange={(e) => updateWiring({ name: e.target.value })}
                    placeholder="Metaproject name (defaults to folder name)"
                    className="w-full bg-[--panel] text-[--text] border border-[--border] rounded-md px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-[--accent]/60"
                    data-testid="mp-create-name"
                  />
                </div>
              )}
              {mpMode !== 'none' && (
                <div className="text-[10px] text-[--modal-text-muted]">
                  Saves the assignment for this folder in <code className="font-mono">.metaproject.yaml</code>.
                </div>
              )}
            </div>
          )}

        </div>
        </fieldset>
        {error && (
          <div role="alert" className="text-sm text-[--danger] bg-[--danger]/10 border border-[--danger]/30 rounded-md mx-5 mb-4 px-2 py-1.5">{error}</div>
        )}

        <div className="px-5 py-3 border-t border-[--border] bg-[--panel]/50 flex items-center justify-end gap-2">
          {saving && savingStep && (
            <span className="text-[11px] text-[--modal-text-muted] mr-auto flex items-center gap-2">
              <span className="mp-spinner" aria-hidden />
              {savingStep}
            </span>
          )}
          <button onClick={onClose} disabled={saving} className="text-sm px-3 py-1.5 rounded-md hover:bg-[--panel-strong] disabled:opacity-50">Cancel</button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className={`text-sm px-4 py-1.5 rounded-md text-[--accent-text] font-medium ${
              canSubmit ? 'pressable bg-[color:var(--accent)] hover:brightness-110' : 'bg-[--panel-strong] text-[--modal-text-muted] cursor-not-allowed'
            }`}
            data-testid="new-project-create"
          >
            {saving ? 'Working…' : created ? 'Open local project' : mode === 'clone' ? 'Clone' : 'Create'}
          </button>
        </div>
      </div>
    </ModalFrame>
  );
}

async function assignNewFolder(projectId: number, epoch: number, choice: AssignmentChoice, current: () => boolean) {
  const stale = 'Local project created without a confirmed assignment. The account or dialog changed.';
  if (!current()) return stale;
  try {
    const context = await api.invoke('metaproject:assignment-get', { projectId });
    if (!current() || (context.ok && context.value.projectId !== projectId)) return stale;
    if (!context.ok) return `Local project created without an assignment. ${failureCopy[context.reason]}`;
    const result = await applyAssignment(context.value, epoch, choice);
    if (!current()) return stale;
    if (!result.ok) return `Local project created without a new assignment. ${failureCopy[result.reason]} Review Project Settings.`;
    if (result.value.kind === 'created-not-assigned') return `Created Metaproject project ${result.value.project.name} (#${result.value.project.id}), but it was not assigned to the local folder. ${failureCopy[result.value.reason]} Link the existing project from Project Settings.`;
    return null;
  } catch { return 'Local project created, but its assignment could not be confirmed. Review Project Settings.'; }
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-sm font-medium">{label}</div>
      {hint && <div className="text-xs text-[--modal-text-muted]">{hint}</div>}
      {children}
    </div>
  );
}

function RadioPill({ checked, onSelect, children }: { checked: boolean; onSelect: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`px-2.5 py-1 rounded-md border ${
        checked
          ? 'bg-[color:var(--accent)]/20 border-[color:var(--accent)]/60 text-[--text]'
          : 'border-[--border] text-[--modal-text-muted] hover:text-[--text] hover:bg-[--panel]'
      }`}
    >
      <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${checked ? 'bg-[color:var(--accent)]' : 'bg-[--modal-text-muted]/50'}`} />
      {children}
    </button>
  );
}

function XCloseIcon() {
  return (
    <svg width={ICON_SIZE.md} height={ICON_SIZE.md} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE.outline} strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
