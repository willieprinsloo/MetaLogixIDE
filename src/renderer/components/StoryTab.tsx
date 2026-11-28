/**
 * Story tab — the newsfeed.
 *
 * A single scrollable column of posts. Each post is a full card read
 * in place: date header, PR / ticket chips, a one-sentence headline,
 * a short paragraph of context, and an Edit affordance. Day headers
 * break the stream into "Today", "Yesterday", or a dated chunk, so a
 * reader scanning for a specific moment lands on it.
 *
 * Refresh walks git since the last entry and streams new posts into
 * the top of the feed. Nothing older is ever rewritten; the human
 * can edit any entry after the fact and the edited bit persists.
 *
 * The old two-pane layout (left rail + right detail) is gone — the
 * feed reads top to bottom like a product changelog, not a doc page
 * with a sidebar.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@renderer/api';
import type { StoryFeature } from '@shared/story-feature';
import { splitHeadlineAndBody } from '@shared/story-feature-prompt';
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
  const reader = mpSession !== null
    ? <KanbanUrlReader projectId={projectId} onResolve={setKanbanUrl} />
    : null;
  return <Newsfeed projectId={projectId} kanbanUrl={kanbanUrl} extra={reader} />;
}

function Newsfeed({ projectId, kanbanUrl, extra }: { projectId: number; kanbanUrl: string | null; extra: React.ReactNode }) {
  const [features, setFeatures] = useState<StoryFeature[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMaintenance, setShowMaintenance] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    try {
      const { features } = await api.invoke('story:features:list', { projectId });
      setFeatures(features);
    } catch (err) {
      setError(String(err));
    }
  }, [projectId]);

  useEffect(() => {
    setError(null);
    setEditingId(null);
  }, [projectId]);

  useEffect(() => { void refreshList(); }, [refreshList]);

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
        setRefreshing(false);
        return;
      }
      setFeatures((cur) => {
        const next = cur.filter((f) => f.id !== ev.feature!.id);
        next.unshift(ev.feature!);
        next.sort((a, b) => b.ts.localeCompare(a.ts));
        return next;
      });
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
  }, [projectId]);

  const visibleFeatures = useMemo(
    () => (showMaintenance ? features : features.filter((f) => f.kind === 'feature')),
    [features, showMaintenance],
  );

  // Group by local day so the header above each run of posts reads
  // "Today" / "Yesterday" / a dated label. Each group keeps its posts
  // in the same newest-first order as the full list.
  const groups = useMemo(() => groupByDay(visibleFeatures), [visibleFeatures]);

  return (
    <div className="h-full flex flex-col min-h-0 bg-[--bg]" data-testid="story-tab">
      {extra}
      <header className="px-4 py-2 border-b border-[--border] flex items-center gap-3 shrink-0">
        <button
          onClick={refresh}
          disabled={refreshing}
          className="text-[12px] px-2.5 py-1 rounded-md border border-[color:var(--accent)]/40 text-[color:var(--accent)] hover:bg-[--accent-soft] disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
          data-testid="story-refresh"
          title="Scan git for new merges and direct feat:/fix: commits, and generate a post for each."
        >
          <span className={`inline-block ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true">↻</span>
          {refreshing ? 'Scanning…' : 'Refresh'}
        </button>
        <label className="text-[12px] text-[--text-muted] flex items-center gap-1.5 cursor-pointer" title="Show maintenance-only posts (refactors, test fixes, CI tweaks).">
          <input
            type="checkbox"
            checked={showMaintenance}
            onChange={(e) => setShowMaintenance(e.target.checked)}
            className="accent-[color:var(--accent)]"
            data-testid="story-show-maintenance"
          />
          Show maintenance
        </label>
        <span className="ml-auto text-[11px] text-[--text-muted] tabular-nums">{visibleFeatures.length} post{visibleFeatures.length === 1 ? '' : 's'}</span>
      </header>

      {refreshing && (
        <div
          className="h-0.5 bg-[color:var(--accent)]/70 animate-pulse shrink-0"
          data-testid="story-progress"
          role="progressbar"
          aria-label="Scanning git history for new changes"
          aria-busy="true"
        />
      )}

      {error && (
        <div className="mx-4 mt-2 px-3 py-1.5 text-[12px] text-[--hue-orange-soft-text] bg-[--hue-orange-soft] border border-[--border] rounded-md shrink-0" role="alert">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto min-h-0" data-testid="story-newsfeed">
        {features.length === 0 && !refreshing && (
          <div className="p-10 text-[13px] text-[--text-muted] text-center leading-relaxed max-w-md mx-auto">
            Nothing to read yet.
            <br />
            <br />
            Press <span className="text-[color:var(--accent)]">↻ Refresh</span> — I&apos;ll walk the git history and write a short post for each change that shipped.
          </div>
        )}
        {features.length === 0 && refreshing && (
          <div
            className="p-10 text-[13px] text-[--text-muted] text-center leading-relaxed max-w-md mx-auto"
            data-testid="story-scanning"
            aria-live="polite"
          >
            <span className="inline-block animate-spin mr-2 text-[color:var(--accent)]" aria-hidden="true">↻</span>
            <span className="animate-pulse">Scanning git history for changes that shipped…</span>
            <br />
            <br />
            <span className="text-[11px] opacity-70">This takes a moment on the first run — I&apos;m reading each commit and writing a short post for it.</span>
          </div>
        )}
        {groups.map((group) => (
          <section key={group.key} className="px-4 pt-5 pb-1" data-testid="story-day-group">
            <h2 className="text-[11px] uppercase tracking-wide text-[--text-muted] mb-3 flex items-center gap-2">
              <span className="h-px flex-1 bg-[--border]" aria-hidden="true" />
              <span className="font-medium">{group.label}</span>
              <span className="h-px flex-1 bg-[--border]" aria-hidden="true" />
            </h2>
            <ul className="space-y-3 max-w-3xl mx-auto">
              {group.features.map((f) => (
                <li key={f.id}>
                  <Post
                    feature={f}
                    editing={editingId === f.id}
                    onStartEdit={() => setEditingId(f.id)}
                    onEndEdit={() => setEditingId(null)}
                    projectId={projectId}
                    repoUrl={repoUrl}
                    kanbanUrl={kanbanUrl}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

interface PostProps {
  feature: StoryFeature;
  editing: boolean;
  onStartEdit: () => void;
  onEndEdit: () => void;
  projectId: number;
  repoUrl: string | null;
  kanbanUrl: string | null;
}

function Post({ feature, editing, onStartEdit, onEndEdit, projectId, repoUrl, kanbanUrl }: PostProps): React.JSX.Element {
  const { headline, body } = useMemo(() => splitHeadlineAndBody(feature.body), [feature.body]);
  const displayHeadline = headline ?? feature.title;
  const html = useMemo(() => renderStoryFeatureBody(body), [body]);
  const [draftTitle, setDraftTitle] = useState(displayHeadline);
  const [draftBody, setDraftBody] = useState(feature.body);

  useEffect(() => {
    if (editing) {
      setDraftTitle(displayHeadline);
      setDraftBody(feature.body);
    }
  }, [editing, displayHeadline, feature.body]);

  const save = useCallback(async () => {
    try {
      // Keep the stored body in its markdown-with-headline shape so a
      // re-edit round-trips cleanly. If the user changed the headline,
      // rewrite the first `# ` line in the body; otherwise persist the
      // body as-typed.
      const persistBody = withUpdatedHeadline(draftBody, draftTitle);
      await api.invoke('story:features:update', { projectId, id: feature.id, title: feature.title, body: persistBody });
      onEndEdit();
    } catch {
      // Error path kept quiet here; the IPC either succeeded or threw,
      // and the editor stays open so the user can retry.
    }
  }, [draftBody, draftTitle, feature.id, feature.title, onEndEdit, projectId]);

  if (editing) {
    return (
      <article className="rounded-lg border border-[color:var(--accent)]/40 bg-[--panel] p-4 flex flex-col gap-2" data-testid="story-post-editor">
        <input
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          className="w-full bg-transparent text-[16px] text-[--text] font-medium outline-none border-b border-transparent focus:border-[color:var(--accent)] pb-1"
          data-testid="story-post-edit-title"
          autoFocus
        />
        <textarea
          value={draftBody}
          onChange={(e) => setDraftBody(e.target.value)}
          rows={6}
          className="w-full bg-transparent text-[13px] text-[--text] font-mono leading-relaxed outline-none resize-y"
          data-testid="story-post-edit-body"
          spellCheck
        />
        <div className="flex justify-end gap-2">
          <button onClick={onEndEdit} className="text-[11px] px-2 py-1 rounded-md border border-[--border] text-[--text-muted] hover:bg-[--surface-hover]" data-testid="story-post-cancel">Cancel</button>
          <button onClick={save} className="text-[11px] px-2 py-1 rounded-md border border-[color:var(--accent)]/40 text-[color:var(--accent)] hover:bg-[--accent-soft]" data-testid="story-post-save">Save</button>
        </div>
      </article>
    );
  }

  return (
    <article
      className={`rounded-lg border border-[--border] bg-[--panel] p-4 ${feature.kind === 'maintenance' ? 'opacity-60' : ''}`}
      data-testid="story-post"
      data-kind={feature.kind}
    >
      <header className="flex items-center gap-2 text-[11px] text-[--text-muted] mb-1.5 flex-wrap">
        <span className="tabular-nums">{formatTime(feature.ts)}</span>
        {feature.prNumber !== null && <PrChip prNumber={feature.prNumber} repoUrl={repoUrl} />}
        {feature.ticketRefs?.map((ref) => <TicketChip key={ref} refToken={ref} kanbanUrl={kanbanUrl} />)}
        {feature.kind === 'maintenance' && <span className="px-1 rounded bg-[--panel] text-[10px] uppercase tracking-wide">maintenance</span>}
        {feature.edited && <span className="text-[10px] italic" title="Hand-edited.">edited</span>}
        <button
          onClick={onStartEdit}
          className="ml-auto text-[11px] text-[--text-muted] hover:text-[--text]"
          data-testid="story-post-edit"
          title="Edit this post."
        >
          Edit
        </button>
      </header>
      <h3 className="text-[15px] text-[--text] font-medium leading-snug mb-1.5" data-testid="story-post-headline">{displayHeadline}</h3>
      {body.trim() && (
        <div
          className="text-[13px] text-[--text] leading-relaxed story-feature-prose"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </article>
  );
}

/** Replace or insert a `# <headline>` line at the top of a body
 *  blob. Keeps the rest of the body untouched. */
function withUpdatedHeadline(body: string, headline: string): string {
  const trimmed = body.trim();
  const lines = trimmed.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (idx >= 0) {
    lines[idx] = `# ${headline.trim()}`;
    return lines.join('\n');
  }
  return `# ${headline.trim()}\n\n${trimmed}`.trim();
}

/** Metaproject kanban URL reader. Mounts only inside a provider. */
function KanbanUrlReader({ projectId, onResolve }: { projectId: number; onResolve: (url: string | null) => void }): null {
  const { state } = useAssignment(projectId);
  useEffect(() => {
    if (state.kind !== 'loaded') { onResolve(null); return; }
    const a = state.value;
    onResolve(a.kind === 'linked' ? `${a.origin}/projects/${a.remoteId}/kanban` : null);
  }, [state, onResolve]);
  return null;
}

function PrChip({ prNumber, repoUrl }: { prNumber: number; repoUrl: string | null }): React.JSX.Element {
  const url = githubPrUrl(repoUrl, prNumber);
  if (!url) return <span className="px-1 rounded text-[10px] uppercase tracking-wide bg-[--accent-soft] text-[color:var(--accent)]">#{prNumber}</span>;
  return (
    <a
      href={url}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); void api.invoke('app:open-external', { url }); }}
      className="px-1 rounded text-[10px] uppercase tracking-wide bg-[--accent-soft] text-[color:var(--accent)] hover:brightness-110"
      title={`Open PR #${prNumber} on GitHub`}
      data-testid="story-post-pr-link"
      data-pr-number={prNumber}
    >
      #{prNumber}
    </a>
  );
}

function TicketChip({ refToken, kanbanUrl }: { refToken: string; kanbanUrl: string | null }): React.JSX.Element {
  const base = 'px-1 rounded text-[10px] uppercase tracking-wide font-medium';
  if (!kanbanUrl) return <span className={`${base} bg-[--panel] text-[--text-muted]`} data-testid="story-post-ticket-chip">{refToken}</span>;
  return (
    <a
      href={kanbanUrl}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); void api.invoke('app:open-external', { url: kanbanUrl }); }}
      className={`${base} bg-[color:var(--accent-soft)] text-[color:var(--accent)] hover:brightness-110`}
      title={`Open the metaproject board (search for ${refToken})`}
      data-testid="story-post-ticket-chip"
      data-ref={refToken}
    >
      {refToken}
    </a>
  );
}

interface DayGroup {
  key: string;
  label: string;
  features: StoryFeature[];
}

function groupByDay(features: StoryFeature[]): DayGroup[] {
  const groups = new Map<string, StoryFeature[]>();
  for (const f of features) {
    const key = dayKey(f.ts);
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }
  const now = new Date();
  const todayKey = dayKey(now.toISOString());
  const yesterdayKey = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toISOString());
  return [...groups.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([key, items]) => ({
      key,
      label: key === todayKey ? 'Today' : key === yesterdayKey ? 'Yesterday' : formatDayLabel(items[0]!.ts),
      features: items,
    }));
}

function dayKey(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } catch {
    return iso.slice(0, 10);
  }
}

function formatDayLabel(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString(undefined, sameYear ? { weekday: 'short', month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso.slice(0, 10);
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  } catch {
    return '';
  }
}
