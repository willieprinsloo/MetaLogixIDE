import { AssignmentChoices } from '@renderer/metaproject/AssignmentPanel';
import { folderFromUrl, useNewProject } from '@renderer/metaproject/useNewProject';
import { AccountStatus, SignedInPersistenceWarning } from '@renderer/metaproject/session';
import type { Project, Root } from '@shared/types';
import { ModalFrame } from '@renderer/components/ModalFrame';
import { ICON_SIZE, ICON_STROKE } from './icon-size';

interface Props {
  open: boolean;
  roots: Root[];
  defaultRootId?: number | null;
  onClose: () => void;
  onCreated: (p: Project) => void;
}

/** Creates a local folder first, with optional assignment via the shared account. */
export function NewProjectDialog({ open, ...props }: Props) {
  return open ? <NewProjectForm {...props} /> : null;
}

function NewProjectForm({ roots, defaultRootId, onClose, onCreated }: Omit<Props, 'open'>) {
  const form = useNewProject(roots, defaultRootId, onCreated);
  const { saving, created, error, canDismiss, cancel } = form;
  const dismiss = () => { if (canDismiss) { cancel(); onClose(); } };

  return (
    <ModalFrame
      testId="new-project-dialog"
      tier="modal"
      motion="fade"
      layerClassName="flex items-center justify-center"
      onDismiss={canDismiss ? dismiss : undefined}
    >
      <div className="modal-panel modal-sheet w-[560px] max-w-[92vw] max-h-[95vh] overflow-auto" onKeyDown={(event) => {
        if (event.key === 'Escape' && canDismiss) { event.stopPropagation(); dismiss(); }
      }}>
        <div className="px-5 py-4 border-b border-[--border] flex items-center justify-between">
          <div className="font-semibold">New project</div>
          <button onClick={dismiss} disabled={!canDismiss} className="text-[--modal-text-muted] hover:text-[--text] w-7 h-7 flex items-center justify-center rounded hover:bg-[--panel]" aria-label="Close">
            <XCloseIcon />
          </button>
        </div>

        <fieldset disabled={saving || !!created}>
          <LocalModePicker local={form.local} />
          <div className="p-5 space-y-4">
            <LocalProjectFields local={form.local} roots={roots} submit={form.submit} />
            {!created && <WiringFields wiring={form.wiring} effectiveName={form.local.effectiveName} />}
            {created && <SignedInPersistenceWarning />}
          </div>
        </fieldset>
        {error && <div role="alert" className="text-sm text-[--danger] bg-[--danger]/10 border border-[--danger]/30 rounded-md mx-5 mb-4 px-2 py-1.5">{error}</div>}
        <NewProjectActions form={form} dismiss={dismiss} />
      </div>
    </ModalFrame>
  );
}

type Form = ReturnType<typeof useNewProject>;

function LocalModePicker({ local: { mode, update } }: { local: Form['local'] }) {
  return <div className="px-5 pt-4">
          <div className="inline-flex rounded-md border border-[--border] p-0.5 bg-[--panel]/50 text-xs">
            <button
              onClick={() => update({ mode: 'empty' })}
              className={`px-3 py-1 rounded-md ${mode === 'empty' ? 'bg-[color:var(--accent)] text-[--accent-text]' : 'text-[--modal-text-muted] hover:text-[--text]'}`}
              data-testid="mode-empty"
            >
              Empty folder
            </button>
            <button
              onClick={() => update({ mode: 'clone' })}
              className={`px-3 py-1 rounded-md ${mode === 'clone' ? 'bg-[color:var(--accent)] text-[--accent-text]' : 'text-[--modal-text-muted] hover:text-[--text]'}`}
              data-testid="mode-clone"
            >
              Clone git repo
            </button>
          </div>
        </div>;
}

function LocalProjectFields({ local, roots, submit }: { local: Form['local']; roots: Root[]; submit: Form['submit'] }) {
  const { mode, name, gitUrl, initGit, nameOk, update } = local;
  const cloning = mode === 'clone';
  return <>
          {cloning && <CloneUrlField local={local} />}

          <Field
            label="Folder name"
            hint={mode === 'clone' ? 'Optional — leave blank to derive from the git URL.' : 'Folder name inside the chosen root.'}
          >
            <input
              autoFocus={mode === 'empty'}
              value={name}
              onChange={(e) => update({ name: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
              placeholder={(cloning && folderFromUrl(gitUrl)) || 'my-new-project'}
              className="w-full bg-[--panel] text-[--text] border border-[--border] rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-[--accent]/60"
              data-testid="new-project-name"
            />
            {!nameOk && (name || (cloning && gitUrl)) ? (
              <div className="text-xs text-[--danger] mt-1">
                Use letters, digits, dot, dash, underscore, or spaces. Must start with a letter or digit.
              </div>
            ) : null}
          </Field>

          <RootField roots={roots} local={local} />

          {mode === 'empty' && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={initGit}
                onChange={(e) => update({ initGit: e.target.checked })}
                className="accent-[--accent]"
                data-testid="new-project-git"
              />
              Initialize <code className="font-mono">git</code> and a <code className="font-mono">README.md</code>
            </label>
          )}

  </>;
}

function CloneUrlField({ local: { gitUrl, gitOk, update } }: { local: Form['local'] }) {
  return <Field label="Git URL" hint="HTTPS, SSH, or git@… — anything the system `git clone` accepts.">
    <input autoFocus value={gitUrl} onChange={(e) => update({ gitUrl: e.target.value })} placeholder="git@github.com:owner/repo.git"
      className="w-full font-mono bg-[--panel] text-[--text] border border-[--border] rounded-md px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-[--accent]/60"
      data-testid="new-project-git-url" />
    {gitUrl && !gitOk && <div className="text-xs text-[--danger] mt-1">Expected an https://, ssh://, git://, or git@… URL.</div>}
  </Field>;
}

function RootField({ roots, local: { rootId, update } }: { roots: Root[]; local: Form['local'] }) {
  return <Field label="Root" hint="Parent folder. Add more roots in Settings.">
    <select value={rootId ?? ''} onChange={(e) => update({ rootId: Number(e.target.value) })}
      className="w-full bg-[--panel] text-[--text] border border-[--border] rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-[--accent]/60"
      data-testid="new-project-root">
      {roots.length === 0 && <option value="">No roots yet — add one in Settings</option>}
      {roots.map((r) => <option key={r.id} value={r.id}>{r.path}</option>)}
    </select>
  </Field>;
}

function WiringFields({ wiring, effectiveName }: { wiring: Form['wiring']; effectiveName: string }) {
  const { signedIn, mode, name, selected, choices, retryList, update, onSignIn } = wiring;
  return <div className="space-y-2 pt-2 border-t border-[--border]">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-[--modal-text-muted]">Metaproject board</div>
              {signedIn ? <><SignedInPersistenceWarning /><div className="flex flex-wrap items-center gap-3 text-xs">
                <RadioPill checked={mode === 'none'} onSelect={() => update({ mode: 'none' })}>None</RadioPill>
                <RadioPill checked={mode === 'link'} onSelect={() => update({ mode: 'link' })}>Link existing</RadioPill>
                <RadioPill checked={mode === 'create'} onSelect={() => update({ mode: 'create', name: name || effectiveName })}>Create new</RadioPill>
              </div></> : <AccountStatus onSignIn={onSignIn} />}
              {mode === 'link' && <AssignmentChoices choices={choices} onRetry={retryList} selected={selected}
                onSelect={(remoteId) => update({ remoteId })} />}
              {mode === 'create' && (
                <div>
                  <input
                    aria-label="New Metaproject project name" maxLength={255}
                    value={name}
                    onChange={(e) => update({ name: e.target.value })}
                    placeholder="Metaproject name (defaults to folder name)"
                    className="w-full bg-[--panel] text-[--text] border border-[--border] rounded-md px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-[--accent]/60"
                    data-testid="mp-create-name"
                  />
                </div>
              )}
              {mode !== 'none' && (
                <div className="text-[10px] text-[--modal-text-muted]">
                  Saves the assignment for this folder in <code className="font-mono">.metaproject.yaml</code>.
                </div>
              )}
            </div>;
}

function NewProjectActions({ form, dismiss }: { form: Form; dismiss: () => void }) {
  const { local: { mode }, saving, savingStep, created, canDismiss, canSubmit, submit } = form;
  return <div className="px-5 py-3 border-t border-[--border] bg-[--panel]/50 flex items-center justify-end gap-2">
          {saving && savingStep && (
            <span className="text-[11px] text-[--modal-text-muted] mr-auto flex items-center gap-2">
              <span className="mp-spinner" aria-hidden />
              {savingStep}
            </span>
          )}
          <button onClick={dismiss} disabled={!canDismiss} className="text-sm px-3 py-1.5 rounded-md hover:bg-[--panel-strong] disabled:opacity-50">Cancel</button>
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
        </div>;
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
