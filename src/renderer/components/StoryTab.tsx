/**
 * Story tab — the feature-ledger handoff view.
 *
 * Left rail: one row per capability that shipped, newest first.
 * Right pane: the three-section plain-English note for the selected
 * entry — what you can now do, why it matters, where it lives.
 *
 * "Refresh" scans git since the last entry and streams new rows in as
 * each one is generated. Nothing older is ever rewritten; the human
 * can edit any entry after the fact and the edited bit persists.
 *
 * The old activity-window narrator still exists on the main side and
 * writes to `.metaide/story/` — this tab no longer surfaces it; the
 * feature feed is the owner-facing lens on the project.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@renderer/api';
import type { StoryFeature } from '@shared/story-feature';
import { renderStoryFeatureBody } from '@renderer/story/renderFeatureBody';

interface Props {
  projectId: number;
}

export function StoryTab({ projectId }: Props) {
  const [features, setFeatures] = useState<StoryFeature[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMaintenance, setShowMaintenance] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');

  const refreshList = useCallback(async () => {
    try {
      const { features } = await api.invoke('story:features:list', { projectId });
      setFeatures(features);
      // Auto-select the newest entry on first load; do not jump off
      // what the human is reading on a streaming update.
      setSelectedId((cur) => cur ?? features[0]?.id ?? null);
    } catch (err) {
      setError(String(err));
    }
  }, [projectId]);

  useEffect(() => {
    setSelectedId(null);
    setError(null);
  }, [projectId]);

  useEffect(() => { void refreshList(); }, [refreshList]);

  // Stream new entries in as the main side writes them.
  useEffect(() => {
    const off = api.on('story:features:changed', (ev) => {
      if (ev.projectId !== projectId) return;
      if (ev.feature === null) {
        // Batch end — drop the refreshing indicator.
        setRefreshing(false);
        return;
      }
      setFeatures((cur) => {
        const next = cur.filter((f) => f.id !== ev.feature!.id);
        next.unshift(ev.feature!);
        // Keep newest first — the main side already feeds in that order,
        // but a mid-batch edit event could arrive out of order.
        next.sort((a, b) => b.ts.localeCompare(a.ts));
        return next;
      });
      // Auto-select the first streamed entry on an empty feed.
      setSelectedId((cur) => cur ?? ev.feature!.id);
    });
    return off;
  }, [projectId]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      await api.invoke('story:features:refresh', { projectId });
    } catch (err) {
      setError(String(err));
      setRefreshing(false);
    }
    // The batch-end event resets `refreshing`; the call above resolves
    // when the main side returns the summary, which is after that event.
  }, [projectId]);

  const selected = useMemo(
    () => features.find((f) => f.id === selectedId) ?? null,
    [features, selectedId],
  );

  const visibleFeatures = useMemo(
    () => (showMaintenance ? features : features.filter((f) => f.kind === 'feature')),
    [features, showMaintenance],
  );

  const startEdit = useCallback(() => {
    if (!selected) return;
    setDraftTitle(selected.title);
    setDraftBody(selected.body);
    setEditing(true);
  }, [selected]);

  const saveEdit = useCallback(async () => {
    if (!selected) return;
    try {
      await api.invoke('story:features:update', {
        projectId,
        id: selected.id,
        title: draftTitle,
        body: draftBody,
      });
      setEditing(false);
    } catch (err) {
      setError(String(err));
    }
  }, [projectId, selected, draftTitle, draftBody]);

  const cancelEdit = useCallback(() => setEditing(false), []);

  return (
    <div className="h-full flex min-h-0" data-testid="story-tab">
      {/* Left rail: feature feed */}
      <aside className="w-80 shrink-0 border-r border-[--border] flex flex-col min-h-0">
        <div className="px-3 py-2 border-b border-[--border] flex items-center gap-2">
          <button
            onClick={refresh}
            disabled={refreshing}
            className="text-[11px] px-2 py-1 rounded border border-[color:var(--accent)]/40 text-[color:var(--accent)] hover:bg-[--accent-soft] disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="story-refresh"
            title="Scan git for new merges and direct feat:/fix: commits, and generate a handoff note for each."
          >
            {refreshing ? '…scanning' : '↻ Refresh'}
          </button>
          <label className="text-[11px] text-[--text-muted] flex items-center gap-1 ml-auto cursor-pointer" title="Show maintenance-only entries (refactors, test fixes, CI tweaks).">
            <input
              type="checkbox"
              checked={showMaintenance}
              onChange={(e) => setShowMaintenance(e.target.checked)}
              className="accent-[color:var(--accent)]"
              data-testid="story-show-maintenance"
            />
            maintenance
          </label>
          <span className="text-[11px] text-[--text-muted] tabular-nums">{visibleFeatures.length}</span>
        </div>
        <div className="flex-1 overflow-auto min-h-0">
          {features.length === 0 && !refreshing && (
            <div className="p-6 text-[12px] text-[--text-muted] text-center leading-relaxed">
              No features logged yet.
              <br />
              <br />
              Press <span className="text-[color:var(--accent)]">↻ Refresh</span> — I&apos;ll walk the git history and write a short handoff note for each change that shipped.
            </div>
          )}
          <ul>
            {visibleFeatures.map((f) => (
              <li key={f.id}>
                <button
                  onClick={() => { setEditing(false); setSelectedId(f.id); }}
                  className={`w-full text-left px-3 py-2 border-b border-[--border] hover:bg-[--surface-hover] ${selectedId === f.id ? 'bg-[--accent-soft]' : ''} ${f.kind === 'maintenance' ? 'opacity-60' : ''}`}
                  data-testid="story-feature-row"
                >
                  <div className="flex items-center gap-1.5 text-[11px] text-[--text-muted] mb-0.5">
                    <span className="tabular-nums">{formatDate(f.ts)}</span>
                    {f.prNumber !== null && <span className="text-[color:var(--accent)]">#{f.prNumber}</span>}
                    {f.kind === 'maintenance' && <span className="px-1 rounded bg-[--panel] text-[10px] uppercase tracking-wide">maintenance</span>}
                    {f.edited && <span className="text-[10px] italic" title="This entry was hand-edited.">edited</span>}
                  </div>
                  <div className="text-[13px] text-[--text] leading-snug">{f.title}</div>
                  {f.scope && <div className="text-[11px] text-[--text-muted] truncate mt-0.5 font-mono opacity-80">{f.scope}</div>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* Right pane: detail */}
      <section className="flex-1 min-w-0 flex flex-col min-h-0 bg-[--bg]">
        {error && (
          <div className="px-3 py-1.5 text-[11px] text-[--hue-orange-soft-text] bg-[--hue-orange-soft] border-b border-[--border]">
            {error}
          </div>
        )}
        {selected ? (
          editing ? (
            <FeatureEditor
              title={draftTitle}
              body={draftBody}
              onTitle={setDraftTitle}
              onBody={setDraftBody}
              onSave={saveEdit}
              onCancel={cancelEdit}
            />
          ) : (
            <FeatureDetail feature={selected} onEdit={startEdit} />
          )
        ) : (
          <div className="flex-1 flex items-center justify-center text-[--text-muted] text-sm">
            {features.length === 0 ? 'Press Refresh to build the feed.' : 'Select a feature on the left.'}
          </div>
        )}
      </section>
    </div>
  );
}

function FeatureDetail({ feature, onEdit }: { feature: StoryFeature; onEdit: () => void }) {
  const html = useMemo(() => renderStoryFeatureBody(feature.body), [feature.body]);
  return (
    <div className="flex-1 overflow-auto min-h-0 flex flex-col" data-testid="story-feature-detail">
      <header className="px-6 pt-6 pb-3 border-b border-[--border]">
        <div className="flex items-center gap-2 text-[11px] text-[--text-muted] mb-1 tabular-nums">
          <span>{formatFullDate(feature.ts)}</span>
          {feature.prNumber !== null && <span className="text-[color:var(--accent)]">#{feature.prNumber}</span>}
          <span className="font-mono">{feature.id}</span>
          {feature.edited && <span className="italic">· edited</span>}
          <button
            onClick={onEdit}
            className="ml-auto text-[11px] px-2 py-0.5 rounded border border-[--border] text-[--text] hover:bg-[--surface-hover]"
            data-testid="story-feature-edit"
            title="Edit this entry's title or prose."
          >
            Edit
          </button>
        </div>
        <h1 className="text-[18px] text-[--text] font-medium leading-tight">{feature.title}</h1>
        {feature.scope && <div className="mt-2 text-[12px] text-[--text-muted] font-mono">{feature.scope}</div>}
      </header>
      <article
        className="px-6 py-5 text-[14px] text-[--text] leading-relaxed story-feature-prose"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function FeatureEditor({
  title,
  body,
  onTitle,
  onBody,
  onSave,
  onCancel,
}: {
  title: string;
  body: string;
  onTitle: (v: string) => void;
  onBody: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="story-feature-editor">
      <header className="px-6 pt-6 pb-3 border-b border-[--border] flex items-center gap-2">
        <input
          value={title}
          onChange={(e) => onTitle(e.target.value)}
          className="flex-1 bg-transparent text-[--text] text-[18px] font-medium outline-none border-b border-transparent focus:border-[color:var(--accent)]"
          data-testid="story-feature-edit-title"
        />
        <button
          onClick={onCancel}
          className="text-[11px] px-2 py-1 rounded border border-[--border] text-[--text-muted] hover:bg-[--surface-hover]"
          data-testid="story-feature-cancel"
        >
          Cancel
        </button>
        <button
          onClick={onSave}
          className="text-[11px] px-2 py-1 rounded border border-[color:var(--accent)]/40 text-[color:var(--accent)] hover:bg-[--accent-soft]"
          data-testid="story-feature-save"
        >
          Save
        </button>
      </header>
      <textarea
        value={body}
        onChange={(e) => onBody(e.target.value)}
        className="flex-1 min-h-0 px-6 py-5 bg-transparent text-[--text] text-[14px] leading-relaxed outline-none resize-none font-mono"
        data-testid="story-feature-edit-body"
        spellCheck
      />
    </div>
  );
}

/** `2026-11-27T13:00:00Z` → `Nov 27`. Today shows "today"; yesterday "yesterday". */
function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (target === startOfToday) return 'today';
    if (target === startOfToday - dayMs) return 'yesterday';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return iso.slice(0, 10);
  }
}

function formatFullDate(iso: string): string {
  try {
    const d = new Date(iso);
    const date = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `${date} · ${hhmm}`;
  } catch {
    return iso;
  }
}
