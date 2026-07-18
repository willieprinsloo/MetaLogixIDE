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

export function NewProjectDialog({ open, roots, defaultRootId, onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [rootId, setRootId] = useState<number | null>(null);
  const [initGit, setInitGit] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setError(null);
    setSaving(false);
    // Prefer explicit default, else first root, else null.
    if (defaultRootId != null && roots.some((r) => r.id === defaultRootId)) setRootId(defaultRootId);
    else setRootId(roots[0]?.id ?? null);
  }, [open, defaultRootId, roots]);

  const nameOk = useMemo(() => !!name && isValidName(name), [name]);
  const canSubmit = nameOk && rootId != null && !saving;

  async function submit() {
    if (!canSubmit || rootId == null) return;
    setSaving(true);
    setError(null);
    try {
      const { project } = await api.invoke('projects:create', { rootId, name: name.trim(), initGit });
      onCreated(project);
      onClose();
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ''));
      setSaving(false);
    }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose} data-testid="new-project-dialog">
      <div className="bg-[--panel-strong] w-[520px] max-w-[92vw] rounded-xl shadow-2xl border border-[--border] overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-[--border] flex items-center justify-between">
          <div className="font-semibold">New project</div>
          <button onClick={onClose} className="text-[--text-muted] hover:text-[--text] w-7 h-7 flex items-center justify-center rounded hover:bg-[--panel]" aria-label="Close">✕</button>
        </div>
        <div className="p-5 space-y-4">
          <Field label="Name" hint="Folder name inside the chosen root.">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); if (e.key === 'Escape') onClose(); }}
              placeholder="my-new-project"
              className="w-full bg-[--panel] text-[--text] border border-[--border] rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-[--accent]/60"
              data-testid="new-project-name"
            />
            {name && !nameOk && (
              <div className="text-xs text-[--danger] mt-1">
                Use letters, digits, dot, dash, underscore, or spaces. Must start with a letter or digit.
              </div>
            )}
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

          {error && (
            <div className="text-sm text-[--danger]">{error}</div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-[--border] bg-[--panel]/50 flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-sm px-3 py-1.5 rounded-md hover:bg-[--panel-strong]">Cancel</button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className={`text-sm px-4 py-1.5 rounded-md text-white ${
              canSubmit ? 'bg-[color:var(--accent)] hover:brightness-110' : 'bg-[--panel-strong] text-[--text-muted] cursor-not-allowed'
            }`}
            data-testid="new-project-create"
          >
            {saving ? 'Creating…' : 'Create'}
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
