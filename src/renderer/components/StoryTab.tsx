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
import { githubPrUrl } from '@shared/story-ref-extract';
import { useAssignment } from '@renderer/metaproject/useAssignment';
import { useOptionalMetaprojectSession } from '@renderer/metaproject/session';
import { renderStoryFeatureBody } from '@renderer/story/renderFeatureBody';

interface Props {
  projectId: number;
}

export function StoryTab({ projectId }: Props) {
  const mpSession = useOptionalMetaprojectSession();
  const [kanbanUrl, setKanbanUrl] = useState<string | null>(null);
  // Only mount the assignment reader when the metaproject session
  // provider is live — otherwise `useAssignment` throws by design.
  // A tiny child component carries the hook and reports its finding
  // back through `onKanbanUrl`, so the main component stays clean.
  const kanbanReader = mpSession !== null
    ? <KanbanUrlReader projectId={projectId} onResolve={setKanbanUrl} />
    : null;
  return <StoryTabCore projectId={projectId} kanbanUrl={kanbanUrl} extra={kanbanReader} />;
}

function StoryTabCore({ projectId, kanbanUrl, extra }: { projectId: number; kanbanUrl: string | null; extra: React.ReactNode }) {
  const [features, setFeatures] = useState<StoryFeature[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState<string | null>(null);
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

  // Fetch the GitHub repo URL once per project change. Rare to shift
  // mid-session (requires editing .git/config), so no watcher.
  useEffect(() => {
    let cancelled = false;
    setRepoUrl(null);
    (async () => {
      try {
        const { repoUrl: url } = await api.invoke('story:features:repo-url', { projectId });
        if (!cancelled) setRepoUrl(url);
      } catch { if (!cancelled) setRepoUrl(null); }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

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
      {extra}
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
                  <div className="flex items-center gap-1.5 text-[11px] text-[--text-muted] mb-0.5 flex-wrap">
                    <span className="tabular-nums">{formatDate(f.ts)}</span>
                    {f.prNumber !== null && (
                      <PrLink prNumber={f.prNumber} repoUrl={repoUrl} />
                    )}
                    {f.ticketRefs?.map((ref) => (
                      <TicketChip key={ref} refToken={ref} kanbanUrl={kanbanUrl} />
                    ))}
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
            <FeatureDetail feature={selected} onEdit={startEdit} repoUrl={repoUrl} kanbanUrl={kanbanUrl} />
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

function FeatureDetail({ feature, onEdit, repoUrl, kanbanUrl }: { feature: StoryFeature; onEdit: () => void; repoUrl: string | null; kanbanUrl: string | null }) {
  const html = useMemo(() => renderStoryFeatureBody(feature.body), [feature.body]);
  return (
    <div className="flex-1 overflow-auto min-h-0 flex flex-col" data-testid="story-feature-detail">
      <header className="px-6 pt-6 pb-3 border-b border-[--border]">
        <div className="flex items-center gap-2 text-[11px] text-[--text-muted] mb-1 tabular-nums">
          <span>{formatFullDate(feature.ts)}</span>
          {feature.prNumber !== null && (
            <PrLink prNumber={feature.prNumber} repoUrl={repoUrl} />
          )}
          {feature.ticketRefs?.map((ref) => (
            <TicketChip key={ref} refToken={ref} kanbanUrl={kanbanUrl} />
          ))}
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

/** PR number chip. Clickable when the repo URL resolved; plain text
 *  otherwise (e.g. the user hasn't configured a GitHub remote, or it's
 *  a self-hosted forge). The row button that wraps the chip uses
 *  `stopPropagation` so clicking the link doesn't also select the row. */
function PrLink({ prNumber, repoUrl }: { prNumber: number; repoUrl: string | null }): React.JSX.Element {
  const url = githubPrUrl(repoUrl, prNumber);
  if (!url) {
    return <span className="text-[color:var(--accent)]">#{prNumber}</span>;
  }
  return (
    <a
      href={url}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        void api.invoke('app:open-external', { url });
      }}
      className="text-[color:var(--accent)] underline-offset-2 hover:underline"
      title={`Open PR #${prNumber} on GitHub`}
      data-testid="story-feature-pr-link"
      data-pr-number={prNumber}
    >
      #{prNumber}
    </a>
  );
}

/** Metaproject ticket ref chip (e.g. `METAI-7`). Clickable when the
 *  current project is linked to a metaproject board — opens the
 *  kanban. v1 does not resolve the ref to the exact ticket URL; the
 *  user lands on the board, where the identifier badge is enough to
 *  find the ticket. Follow-up work can swap the href when the server
 *  gains a `/tickets/<ref>` deep link. */
function TicketChip({ refToken, kanbanUrl }: { refToken: string; kanbanUrl: string | null }): React.JSX.Element {
  const base = `px-1 rounded text-[10px] uppercase tracking-wide font-medium`;
  if (!kanbanUrl) {
    return <span className={`${base} bg-[--panel] text-[--text-muted]`} data-testid="story-feature-ticket-chip">{refToken}</span>;
  }
  return (
    <a
      href={kanbanUrl}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        void api.invoke('app:open-external', { url: kanbanUrl });
      }}
      className={`${base} bg-[color:var(--accent-soft)] text-[color:var(--accent)] hover:brightness-110`}
      title={`Open the metaproject board (search for ${refToken})`}
      data-testid="story-feature-ticket-chip"
      data-ref={refToken}
    >
      {refToken}
    </a>
  );
}

/** Reads the current project's metaproject assignment and reports the
 *  kanban URL up to StoryTab. Mounts only when the session provider is
 *  present — `useAssignment` throws without one, so we can't call it
 *  unconditionally from StoryTab. Renders nothing visible. */
function KanbanUrlReader({ projectId, onResolve }: { projectId: number; onResolve: (url: string | null) => void }): null {
  const { state } = useAssignment(projectId);
  useEffect(() => {
    if (state.kind !== 'loaded') { onResolve(null); return; }
    const a = state.value;
    onResolve(a.kind === 'linked' ? `${a.origin}/projects/${a.remoteId}/kanban` : null);
  }, [state, onResolve]);
  return null;
}
