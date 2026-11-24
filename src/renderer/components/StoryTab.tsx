/**
 * Story tab — plain-English chunks of what the agents have been doing.
 *
 * Left column: list of past chunks, newest first.
 * Right column: the selected chunk, rendered as its self-contained HTML
 * inside a sandboxed iframe. Styling and timeline belong to the page,
 * not this shell — the window just hosts them.
 *
 * "✨ Catch me up" asks the main process to generate a fresh chunk from
 * the last 15 minutes of activity; `story:changed` refreshes the list.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@renderer/api';
import type { StoryChunk } from '@shared/story';

interface Props {
  projectId: number;
}

export function StoryTab({ projectId }: Props) {
  const [chunks, setChunks] = useState<StoryChunk[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    try {
      const { chunks } = await api.invoke('story:list', { projectId });
      setChunks(chunks);
      // If nothing is selected yet, open the newest automatically — the
      // empty right-pane isn't useful when there are chunks to read.
      setSelected((cur) => cur ?? chunks[0]?.file ?? null);
    } catch (err) {
      setError(String(err));
    }
  }, [projectId]);

  useEffect(() => { void refreshList(); }, [refreshList]);

  useEffect(() => {
    const off = api.on('story:changed', (ev) => {
      if (ev.projectId !== projectId) return;
      void refreshList();
    });
    return off;
  }, [projectId, refreshList]);

  // Load HTML for the selected chunk.
  useEffect(() => {
    let cancelled = false;
    if (!selected) { setHtml(null); return; }
    (async () => {
      try {
        const { html } = await api.invoke('story:read', { projectId, file: selected });
        if (!cancelled) setHtml(html);
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, selected]);

  const catchUp = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const { chunk } = await api.invoke('story:generate', { projectId, windowMinutes: 15 });
      // Select the new chunk so the right pane jumps to it immediately.
      setSelected(chunk.file);
      await refreshList();
    } catch (err) {
      setError(String(err));
    } finally {
      setGenerating(false);
    }
  }, [projectId, refreshList]);

  return (
    <div className="h-full flex min-h-0" data-testid="story-tab">
      {/* Left column: chunk list */}
      <aside className="w-72 shrink-0 border-r border-[--border] flex flex-col min-h-0">
        <div className="px-3 py-2 border-b border-[--border] flex items-center gap-2">
          <button
            onClick={catchUp}
            disabled={generating}
            className="text-[11px] px-2 py-1 rounded border border-[color:var(--accent)]/40 text-[color:var(--accent)] hover:bg-[--accent-soft] disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="story-catch-up"
            title="Summarise the last 15 minutes of agent activity"
          >
            {generating ? '…writing' : '✨ Catch me up'}
          </button>
          <span className="ml-auto text-[11px] text-[--text-muted] tabular-nums">{chunks.length}</span>
        </div>
        <div className="flex-1 overflow-auto min-h-0">
          {chunks.length === 0 && !generating && (
            <div className="p-6 text-[12px] text-[--text-muted] text-center leading-relaxed">
              Nothing to read yet.
              <br />
              <br />
              Press <span className="text-[color:var(--accent)]">✨ Catch me up</span> and I&apos;ll turn the last 15 minutes of agent activity into a short, readable write-up.
            </div>
          )}
          <ul>
            {chunks.map((c) => (
              <li key={c.file}>
                <button
                  onClick={() => setSelected(c.file)}
                  className={`w-full text-left px-3 py-2 border-b border-[--border] hover:bg-[--surface-hover] ${selected === c.file ? 'bg-[--accent-soft]' : ''}`}
                  data-testid="story-chunk"
                >
                  <div className="text-[13px] text-[--text] truncate">{c.title}</div>
                  <div className="text-[11px] text-[--text-muted] truncate mt-0.5">{formatWhen(c.ts)}</div>
                  <div className="text-[11px] text-[--text-muted] truncate mt-0.5 opacity-80">{c.blurb}</div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* Right column: rendered chunk */}
      <section className="flex-1 min-w-0 flex flex-col min-h-0 bg-[--bg]">
        {error && (
          <div className="px-3 py-1.5 text-[11px] text-[--hue-orange-soft-text] bg-[--hue-orange-soft] border-b border-[--border]">
            {error}
          </div>
        )}
        {html ? (
          <ChunkFrame html={html} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-[--text-muted] text-sm">
            {selected ? 'loading…' : 'Select a chunk on the left.'}
          </div>
        )}
      </section>
    </div>
  );
}

function ChunkFrame({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  // Blob URL keeps document isolation (no base URL leaks, no parent window
  // access) while letting the iframe navigate its own inline anchors.
  const blobUrl = useMemo(() => {
    const blob = new Blob([html], { type: 'text/html' });
    return URL.createObjectURL(blob);
  }, [html]);
  useEffect(() => () => URL.revokeObjectURL(blobUrl), [blobUrl]);
  return (
    <iframe
      ref={ref}
      src={blobUrl}
      sandbox="allow-same-origin"
      className="w-full h-full border-0"
      data-testid="story-frame"
      title="Story chunk"
    />
  );
}

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (sameDay) return `today · ${hhmm}`;
    const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `${date} · ${hhmm}`;
  } catch {
    return iso;
  }
}
