/**
 * The Group activity view: group chats between this project's Claude tabs and headless GPT /
 * Gemini / Ollama agents (docs/superpowers/specs/2026-11-19-group-chats-design.md). Owns the panel
 * state and IPC; `GroupChatView` draws it. Refetches on `groups:changed` for the open project.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@renderer/api';
import { ENGINE_LABEL, type EngineStatus, type GroupView, type HeadlessEngine } from '@shared/group-chat';
import { GroupChatView } from './GroupChatView';
import { clampRounds, sayToGroup } from '@renderer/group-chat/group-actions';

type Tab = { projectId: number; shellIndex: number; title: string; joinable: boolean; why?: string };
const ENGINES: HeadlessEngine[] = ['codex', 'gemini', 'ollama'];
const message = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));

export function GroupChatPanel({ projectId, focusedShell, onDismiss }: {
  projectId: number;
  /** The Claude tab in view, offered as the first member of a new group. */
  focusedShell: { projectId: number; shellIndex: number } | null;
  onDismiss?: () => void;
}) {
  const [groups, setGroups] = useState<GroupView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [engines, setEngines] = useState<Record<HeadlessEngine, EngineStatus> | null>(null);
  const [form, setForm] = useState<{ engine: HeadlessEngine; name: string; model: string }>({ engine: 'codex', name: '', model: '' });
  const wrapRef = useRef<HTMLDivElement>(null);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); } catch (e) { setError(message(e)); }
  }, []);

  const reload = useCallback(async () => {
    if (!projectId) { setGroups([]); return; }
    try {
      const { groups: list } = await api.invoke('groups:list', { projectId });
      setGroups(list);
      setSelectedId((cur) => (cur && list.some((g) => g.id === cur) ? cur : list[0]?.id ?? null));
    } catch (e) { setError(message(e)); }
  }, [projectId]);

  useEffect(() => { setSelectedId(null); setAddOpen(false); void reload(); }, [reload]);
  useEffect(() => api.on('groups:changed', (ev) => { if (ev.projectId === projectId) void reload(); }), [projectId, reload]);

  const group = groups.find((g) => g.id === selectedId) ?? null;

  // keep the newest message in view, unless the user scrolled up to read
  const logLen = group?.log.length ?? 0;
  useEffect(() => {
    const el = wrapRef.current?.querySelector<HTMLElement>('[data-testid="group-transcript"]');
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom || logLen <= 1) el.scrollTop = el.scrollHeight;
  }, [logLen, selectedId]);

  const openAdd = () => {
    if (!group) return;
    setAddOpen((o) => !o);
    void api.invoke('groups:joinable', { projectId, id: group.id }).then((r) => setTabs(r.tabs), () => setTabs([]));
    void api.invoke('groups:engines', {}).then(setEngines, () => setEngines(null));
  };

  const addMenu = addOpen && group ? (
    <div className="absolute left-0 top-full mt-1 z-20 w-72 rounded-lg border border-[--border] bg-[--panel-strong] shadow-lg p-2 flex flex-col gap-2 text-xs" data-testid="group-add-menu">
      <div className="font-semibold text-[--text-muted] uppercase tracking-wider text-[10px]">Claude tabs</div>
      {tabs.length === 0 && <div className="text-[--text-muted]">No Claude tabs running in this project.</div>}
      {tabs.map((t) => (
        <button
          key={t.shellIndex} type="button" disabled={!t.joinable} title={t.why}
          onClick={() => void run(async () => { await api.invoke('groups:add-claude', { id: group.id, shell: { projectId: t.projectId, shellIndex: t.shellIndex } }); setAddOpen(false); })}
          className="text-left px-2 py-1 rounded hover:bg-[--accent-soft] disabled:opacity-50 disabled:hover:bg-transparent"
        >
          {t.title}{t.why ? ` — ${t.why}` : ''}
        </button>
      ))}
      <div className="font-semibold text-[--text-muted] uppercase tracking-wider text-[10px] mt-1">New agent</div>
      <select
        value={form.engine}
        onChange={(e) => setForm({ ...form, engine: e.target.value as HeadlessEngine, model: '' })}
        className="bg-[--panel] border border-[--border] rounded px-1.5 py-1"
        aria-label="Engine"
      >
        {ENGINES.map((en) => {
          const st = engines?.[en];
          return <option key={en} value={en} disabled={st ? !st.ready : false}>{ENGINE_LABEL[en]}{st && !st.ready ? ' (not ready)' : ''}</option>;
        })}
      </select>
      {engines && !engines[form.engine].ready && (
        <div className="text-red-500">{(engines[form.engine] as { why: string }).why}</div>
      )}
      <input
        value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
        placeholder={`Name (e.g. Reviewer)`} className="bg-[--panel] border border-[--border] rounded px-1.5 py-1" aria-label="Agent name"
      />
      {form.engine === 'ollama' ? (
        <select
          value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}
          className="bg-[--panel] border border-[--border] rounded px-1.5 py-1" aria-label="Ollama model"
        >
          <option value="">Pick a model…</option>
          {(engines?.ollama.ready ? engines.ollama.models ?? [] : []).map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      ) : (
        <input
          value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}
          placeholder="Model (optional)" className="bg-[--panel] border border-[--border] rounded px-1.5 py-1" aria-label="Model"
        />
      )}
      <button
        type="button"
        disabled={(form.engine === 'ollama' && !form.model) || (engines ? !engines[form.engine].ready : false)}
        onClick={() => void run(async () => {
          await api.invoke('groups:add-headless', { id: group.id, engine: form.engine, name: form.name.trim() || ENGINE_LABEL[form.engine], model: form.model || null });
          setForm({ engine: form.engine, name: '', model: '' });
          setAddOpen(false);
        })}
        className="px-2 py-1 rounded-md bg-[--accent] text-white disabled:opacity-40"
      >
        Add {ENGINE_LABEL[form.engine]} agent
      </button>
    </div>
  ) : null;

  return (
    <div ref={wrapRef} className="h-full min-h-0">
      <GroupChatView
        groups={groups}
        group={group}
        draft={draft}
        error={error}
        addMenu={addMenu}
        onClose={onDismiss}
        noProject={!projectId}
        onPick={(id) => { setSelectedId(id); setAddOpen(false); }}
        onNew={() => void run(async () => {
          const { group: g } = await api.invoke('groups:create', { projectId, claudeShell: focusedShell ?? undefined });
          setSelectedId(g.id);
          await reload();
        })}
        onRemoveMember={(member) => group && void run(() => api.invoke('groups:remove-member', { id: group.id, member }))}
        onOpenAdd={openAdd}
        onStop={() => group && void run(() => api.invoke('groups:stop', { id: group.id }))}
        onDelete={() => group && void run(async () => { await api.invoke('groups:delete', { id: group.id }); setSelectedId(null); await reload(); })}
        onRounds={(raw) => {
          const n = clampRounds(raw);
          if (group && n !== null && n !== group.maxRounds) void run(() => api.invoke('groups:update', { id: group.id, maxRounds: n }));
        }}
        onDraft={setDraft}
        onSend={() => group && void run(async () => { if (await sayToGroup(api, group.id, draft)) setDraft(''); })}
      />
    </div>
  );
}
