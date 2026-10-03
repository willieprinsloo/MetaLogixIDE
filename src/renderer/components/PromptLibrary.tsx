import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';

interface Prompt {
  id: string;
  projectId: number | null;
  title: string;
  body: string;
  tags: string[];
  updatedAt: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  projectId: number | null;
  /** Target shell for paste actions. When null, paste buttons are disabled. */
  activeShell: { projectId: number; shellIndex: number } | null;
  /** Nice-to-see project name in the "will paste into…" affordance. */
  activeShellLabel?: string;
}

/**
 * Modal library of reusable snippets to paste into a Claude/CLI shell. Two
 * scopes: **global** (shown in every project) and **this project** (only when
 * a project is open). Actions per row:
 *   Paste — types the body into the active shell, without submitting
 *   Send  — types the body AND appends \r so the shell runs it
 *   Edit / Delete — CRUD on the snippet
 *
 * The "Send" action confirms once before firing to avoid accidental
 * destructive commands.
 */
export function PromptLibrary({ open, onClose, projectId, activeShell, activeShellLabel }: Props) {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<Partial<Prompt> | null>(null);
  const [loading, setLoading] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { prompts } = await api.invoke('prompts:list', { projectId });
      setPrompts(prompts);
    } catch (e) {
      toast('Could not load prompts', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    } finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { if (open) void refresh(); }, [open, refresh]);
  useEffect(() => {
    if (!open) return;
    // Focus the search box on open so users can type-to-filter immediately.
    const id = window.setTimeout(() => searchRef.current?.focus(), 30);
    function onEsc(e: KeyboardEvent) { if (e.key === 'Escape' && !editing) onClose(); }
    document.addEventListener('keydown', onEsc);
    return () => { window.clearTimeout(id); document.removeEventListener('keydown', onEsc); };
  }, [open, onClose, editing]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return prompts;
    return prompts.filter((p) =>
      p.title.toLowerCase().includes(q)
      || p.body.toLowerCase().includes(q)
      || p.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [prompts, filter]);

  async function paste(p: Prompt, submit: boolean) {
    if (!activeShell) { toast('No active shell', { kind: 'error' }); return; }
    if (submit && !window.confirm(`Send "${p.title}" to ${activeShellLabel ?? 'the active shell'} and run it?`)) return;
    try {
      await api.invoke('prompts:paste', {
        projectId: activeShell.projectId,
        shellIndex: activeShell.shellIndex,
        text: p.body,
        submit,
      });
      toast(submit ? `Sent "${p.title}"` : `Pasted "${p.title}"`, { kind: 'success', timeoutMs: 1200 });
      onClose();
    } catch (e) {
      toast('Paste failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    }
  }

  async function save(next: Partial<Prompt>) {
    const title = (next.title ?? '').trim();
    const body  = next.body ?? '';
    if (!title || !body) { toast('Title and body are required', { kind: 'error' }); return; }
    try {
      await api.invoke('prompts:save', {
        prompt: {
          id: next.id ?? '',
          projectId: next.projectId ?? null,
          title, body,
          tags: next.tags ?? [],
        },
      });
      setEditing(null);
      void refresh();
    } catch (e) {
      toast('Save failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    }
  }

  async function remove(p: Prompt) {
    if (!window.confirm(`Delete "${p.title}"?`)) return;
    try { await api.invoke('prompts:delete', { id: p.id }); void refresh(); }
    catch (e) { toast('Delete failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') }); }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose} data-testid="prompt-library">
      <div
        className="bg-[--panel-strong] w-[720px] max-w-[92vw] h-[560px] max-h-[85vh] rounded-xl shadow-2xl border border-[--border] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2.5 border-b border-[--border] flex items-center gap-3">
          <div className="font-semibold text-sm">Prompt library</div>
          <span className="text-[10px] text-[--text-muted]">
            {projectId != null ? 'global + this project' : 'global only'}
          </span>
          <input
            ref={searchRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by title, body, tag…"
            className="ml-auto w-56 bg-[--panel] border border-[--border] rounded-md px-2.5 py-1 text-xs outline-none focus:ring-1 focus:ring-[--accent]/60"
          />
          <button
            onClick={() => setEditing({ projectId: projectId, title: '', body: '', tags: [] })}
            className="text-xs font-medium px-2.5 py-1 rounded-md pressable bg-[color:var(--accent)] text-white hover:brightness-110"
          >
            New
          </button>
          <button
            onClick={onClose}
            className="text-[--text-muted] hover:text-[--text] w-7 h-7 flex items-center justify-center rounded hover:bg-[--panel]"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {editing ? (
          <EditForm
            initial={editing}
            projectId={projectId}
            onSave={save}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto">
            {loading && prompts.length === 0 && (
              <div className="p-6 text-center text-xs text-[--text-muted]">Loading…</div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="p-6 text-center text-xs text-[--text-muted]">
                No prompts yet. Click <span className="text-[--text]">New</span> to add one.
              </div>
            )}
            <ul className="divide-y divide-[--border]">
              {filtered.map((p) => (
                <li key={p.id} className="px-4 py-2.5 hover:bg-[--panel] group">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[--text] truncate flex-1">{p.title}</span>
                    <span className={`text-[9px] px-1 py-0.5 rounded ${p.projectId != null ? 'bg-sky-500/20 text-sky-400' : 'bg-[--panel] text-[--text-muted]'}`}>
                      {p.projectId != null ? 'this project' : 'global'}
                    </span>
                    <button
                      onClick={() => void paste(p, false)}
                      disabled={!activeShell}
                      className="text-[10px] px-2 py-1 rounded border border-[--border] hover:bg-[--panel-strong] disabled:opacity-40"
                      title={activeShell ? `Paste into ${activeShellLabel ?? 'active shell'}` : 'Open a shell first'}
                    >
                      Paste
                    </button>
                    <button
                      onClick={() => void paste(p, true)}
                      disabled={!activeShell}
                      className="text-[10px] px-2 py-1 rounded pressable bg-[color:var(--accent)] text-white hover:brightness-110 disabled:opacity-40"
                      title="Paste and press Enter"
                    >
                      Send
                    </button>
                    <button
                      onClick={() => setEditing(p)}
                      className="text-[10px] text-[--text-muted] hover:text-[--text] px-1.5 py-1"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => void remove(p)}
                      className="text-[10px] text-[--text-muted] hover:text-[--danger] px-1.5 py-1"
                    >
                      Delete
                    </button>
                  </div>
                  <div className="mt-1 text-[11px] text-[--text-muted] whitespace-pre-wrap line-clamp-2 font-mono">
                    {p.body}
                  </div>
                  {p.tags.length > 0 && (
                    <div className="mt-1 flex gap-1 flex-wrap">
                      {p.tags.map((t) => (
                        <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-[--panel] border border-[--border] text-[--text-muted]">{t}</span>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function EditForm({
  initial, projectId, onSave, onCancel,
}: {
  initial: Partial<Prompt>;
  projectId: number | null;
  onSave: (next: Partial<Prompt>) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial.title ?? '');
  const [body, setBody] = useState(initial.body ?? '');
  const [tags, setTags] = useState((initial.tags ?? []).join(', '));
  const [scope, setScope] = useState<'global' | 'project'>(
    initial.projectId != null ? 'project' : (projectId != null ? 'project' : 'global'),
  );
  const canProject = projectId != null;
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
      <div className="text-xs font-semibold text-[--text-muted]">{initial.id ? 'Edit prompt' : 'New prompt'}</div>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title — e.g. Review this diff"
        className="w-full bg-[--panel] border border-[--border] rounded-md px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-[--accent]/60"
        autoFocus
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Prompt body — the text pasted into the shell"
        rows={12}
        className="w-full bg-[--panel] border border-[--border] rounded-md px-2.5 py-1.5 text-xs font-mono outline-none focus:ring-1 focus:ring-[--accent]/60"
      />
      <div className="flex items-center gap-3 text-xs">
        <label className="flex items-center gap-1.5 text-[--text-muted]">
          Scope
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as 'global' | 'project')}
            className="bg-[--panel] border border-[--border] rounded px-1.5 py-0.5"
          >
            <option value="global">Global</option>
            <option value="project" disabled={!canProject}>This project</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[--text-muted] flex-1">
          Tags
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="review, tests, refactor"
            className="flex-1 bg-[--panel] border border-[--border] rounded px-2 py-0.5"
          />
        </label>
      </div>
      <div className="flex items-center gap-2 pt-2">
        <button
          onClick={() => onSave({
            id: initial.id,
            projectId: scope === 'project' && canProject ? projectId : null,
            title, body,
            tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
          })}
          className="text-xs font-medium px-3 py-1.5 rounded-md pressable bg-[color:var(--accent)] text-white hover:brightness-110"
        >
          Save
        </button>
        <button
          onClick={onCancel}
          className="text-xs px-3 py-1.5 rounded-md border border-[--border] text-[--text-muted] hover:text-[--text] hover:bg-[--panel]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
