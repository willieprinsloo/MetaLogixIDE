import { useEffect, useMemo, useState } from 'react';
import type { Project, Root } from '@shared/types';
import { api } from '@renderer/api';

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
interface MpProject { id: number; name: string; identifier?: string | null }

/** Best-effort folder name from a git URL: strips `.git`, takes last path segment. */
function folderFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\.git$/, '').replace(/[/:]$/, '');
  const last = trimmed.split(/[/:]/).pop() ?? '';
  return last;
}

export function NewProjectDialog({ open, roots, defaultRootId, onClose, onCreated }: Props) {
  // Kind of project being created + folder / url inputs.
  const [mode, setMode] = useState<Mode>('empty');
  const [name, setName] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [rootId, setRootId] = useState<number | null>(null);
  const [initGit, setInitGit] = useState(true);
  // Metaproject wiring — none / pick existing / create new (with picker).
  const [mpMode, setMpMode] = useState<MpMode>('none');
  const [mpProjects, setMpProjects] = useState<MpProject[]>([]);
  const [mpSelectedId, setMpSelectedId] = useState<number | null>(null);
  const [mpNewName, setMpNewName] = useState('');
  const [mpLoggedIn, setMpLoggedIn] = useState(false);
  // General dialog state.
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingStep, setSavingStep] = useState<string>('');

  useEffect(() => {
    if (!open) return;
    setMode('empty');
    setName('');
    setGitUrl('');
    setInitGit(true);
    setMpMode('none');
    setMpProjects([]);
    setMpSelectedId(null);
    setMpNewName('');
    setError(null);
    setSaving(false);
    setSavingStep('');
    if (defaultRootId != null && roots.some((r) => r.id === defaultRootId)) setRootId(defaultRootId);
    else setRootId(roots[0]?.id ?? null);
    // Check whether we can offer metaproject link/create at all.
    (async () => {
      try {
        const s = await api.invoke('metaproject:status', undefined as never);
        setMpLoggedIn(!!s.loggedIn);
      } catch { setMpLoggedIn(false); }
    })();
  }, [open, defaultRootId, roots]);

  // When mpMode flips to 'link', lazily load the project list once.
  useEffect(() => {
    if (mpMode !== 'link' || mpProjects.length > 0) return;
    (async () => {
      try {
        const { projects } = await api.invoke('metaproject:list-projects', undefined as never);
        setMpProjects(projects);
      } catch (e) {
        setError(`Failed to load metaproject projects: ${String(e).replace(/^Error:\s*/, '')}`);
      }
    })();
  }, [mpMode, mpProjects.length]);

  // Effective folder name: for clone mode, prefer explicit name, else derive.
  const effectiveName = useMemo(() => {
    if (mode === 'empty') return name.trim();
    return (name.trim() || folderFromUrl(gitUrl)).trim();
  }, [mode, name, gitUrl]);

  const nameOk = useMemo(() => !!effectiveName && isValidName(effectiveName), [effectiveName]);
  const gitOk = mode === 'empty' || (gitUrl.trim().length > 0 && /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(gitUrl.trim()));
  const mpOk = mpMode !== 'create' || mpNewName.trim().length > 0;
  const mpLinkOk = mpMode !== 'link' || mpSelectedId != null;
  const canSubmit = nameOk && rootId != null && gitOk && mpOk && mpLinkOk && !saving;

  async function submit() {
    if (!canSubmit || rootId == null) return;
    setSaving(true);
    setError(null);
    let project: Project | null = null;
    try {
      // Step 1 — create the local project (either empty init or git clone).
      if (mode === 'empty') {
        setSavingStep('Creating project…');
        const res = await api.invoke('projects:create', { rootId, name: effectiveName, initGit });
        project = res.project;
      } else {
        setSavingStep(`Cloning ${gitUrl.trim()}…`);
        const res = await api.invoke('projects:clone-git', { rootId, url: gitUrl.trim(), name: effectiveName });
        project = res.project;
      }
      // Step 2 — optional metaproject wiring.
      if (project && mpMode === 'link' && mpSelectedId != null) {
        setSavingStep('Linking to metaproject…');
        await api.invoke('metaproject:link-local-project', { projectId: project.id, metaprojectProjectId: mpSelectedId });
      } else if (project && mpMode === 'create') {
        setSavingStep('Creating metaproject board…');
        const { project: mp } = await api.invoke('metaproject:create-project', { name: mpNewName.trim() });
        await api.invoke('metaproject:link-local-project', { projectId: project.id, metaprojectProjectId: mp.id });
      }
      if (project) {
        onCreated(project);
        onClose();
      }
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ''));
      setSaving(false);
      setSavingStep('');
    }
  }

  if (!open) return null;
  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose} data-testid="new-project-dialog">
      <div className="modal-panel bg-[--panel-strong] w-[560px] max-w-[92vw] rounded-xl shadow-2xl border border-[--border] overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-[--border] flex items-center justify-between">
          <div className="font-semibold">New project</div>
          <button onClick={onClose} className="text-[--text-muted] hover:text-[--text] w-7 h-7 flex items-center justify-center rounded hover:bg-[--panel]" aria-label="Close">
            <XCloseIcon />
          </button>
        </div>

        {/* Mode segmented control */}
        <div className="px-5 pt-4">
          <div className="inline-flex rounded-md border border-[--border] p-0.5 bg-[--panel]/50 text-xs">
            <button
              onClick={() => setMode('empty')}
              className={`px-3 py-1 rounded-md ${mode === 'empty' ? 'bg-[color:var(--accent)] text-white' : 'text-[--text-muted] hover:text-[--text]'}`}
              data-testid="mode-empty"
            >
              Empty folder
            </button>
            <button
              onClick={() => setMode('clone')}
              className={`px-3 py-1 rounded-md ${mode === 'clone' ? 'bg-[color:var(--accent)] text-white' : 'text-[--text-muted] hover:text-[--text]'}`}
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

          {/* Metaproject board wiring — only when the user is signed in;
              otherwise we hide the whole section rather than lie about it. */}
          {mpLoggedIn && (
            <div className="space-y-2 pt-2 border-t border-[--border]">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-[--text-muted]">Metaproject board</div>
              <div className="flex items-center gap-3 text-xs">
                <RadioPill checked={mpMode === 'none'}   onSelect={() => setMpMode('none')}>None</RadioPill>
                <RadioPill checked={mpMode === 'link'}   onSelect={() => setMpMode('link')}>Link existing</RadioPill>
                <RadioPill checked={mpMode === 'create'} onSelect={() => { setMpMode('create'); if (!mpNewName) setMpNewName(effectiveName); }}>Create new</RadioPill>
              </div>
              {mpMode === 'link' && (
                <div>
                  <select
                    value={mpSelectedId ?? ''}
                    onChange={(e) => setMpSelectedId(Number(e.target.value) || null)}
                    className="w-full bg-[--panel] text-[--text] border border-[--border] rounded-md px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-[--accent]/60"
                    data-testid="mp-link-select"
                  >
                    <option value="">— Choose a project —</option>
                    {mpProjects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}{p.identifier ? `  (${p.identifier})` : ''}</option>
                    ))}
                  </select>
                </div>
              )}
              {mpMode === 'create' && (
                <div>
                  <input
                    value={mpNewName}
                    onChange={(e) => setMpNewName(e.target.value)}
                    placeholder="Metaproject name (defaults to folder name)"
                    className="w-full bg-[--panel] text-[--text] border border-[--border] rounded-md px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-[--accent]/60"
                    data-testid="mp-create-name"
                  />
                </div>
              )}
              {mpMode !== 'none' && (
                <div className="text-[10px] text-[--text-muted]">
                  Writes <code className="font-mono">project_id</code> to <code className="font-mono">.metaproject.yaml</code> so the sidebar Board button and Chat pane light up automatically.
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="text-sm text-[--danger] bg-[--danger]/10 border border-[--danger]/30 rounded-md px-2 py-1.5">{error}</div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[--border] bg-[--panel]/50 flex items-center justify-end gap-2">
          {saving && savingStep && (
            <span className="text-[11px] text-[--text-muted] mr-auto flex items-center gap-2">
              <span className="mp-spinner" aria-hidden />
              {savingStep}
            </span>
          )}
          <button onClick={onClose} disabled={saving} className="text-sm px-3 py-1.5 rounded-md hover:bg-[--panel-strong] disabled:opacity-50">Cancel</button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className={`text-sm px-4 py-1.5 rounded-md text-white font-medium ${
              canSubmit ? 'pressable bg-[color:var(--accent)] hover:brightness-110' : 'bg-[--panel-strong] text-[--text-muted] cursor-not-allowed'
            }`}
            data-testid="new-project-create"
          >
            {saving ? 'Working…' : (mode === 'clone' ? 'Clone' : 'Create')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-sm font-medium">{label}</div>
      {hint && <div className="text-xs text-[--text-muted]">{hint}</div>}
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
          : 'border-[--border] text-[--text-muted] hover:text-[--text] hover:bg-[--panel]'
      }`}
    >
      <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${checked ? 'bg-[color:var(--accent)]' : 'bg-[--text-muted]/50'}`} />
      {children}
    </button>
  );
}

function XCloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
