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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@renderer/api';
import { useTheme } from '@renderer/hooks/useTheme';
import type { StoryChunk } from '@shared/story';

interface Props {
  projectId: number;
}

/** The window selector shown next to "Catch me up". `'auto'` lets the
 *  picker walk the ladder (15m → 7d) until it has enough to narrate —
 *  the right default for most projects. A number pins the lookback. */
type WindowChoice = 'auto' | 15 | 60 | 240 | 1440 | 4320 | 10080;

const WINDOW_LABELS: Array<{ value: WindowChoice; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 15, label: '15 min' },
  { value: 60, label: '1 hour' },
  { value: 240, label: '4 hours' },
  { value: 1440, label: 'Today (24 h)' },
  { value: 4320, label: '3 days' },
  { value: 10080, label: '7 days' },
];

export function StoryTab({ projectId }: Props) {
  const { effective: theme } = useTheme();
  const [chunks, setChunks] = useState<StoryChunk[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [windowChoice, setWindowChoice] = useState<WindowChoice>('auto');

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

  // Clear selection when projectId changes — otherwise the html effect
  // reads a filename from the previous project and the reader shows
  // "loading…" forever while story:read returns null.
  useEffect(() => {
    setSelected(null);
    setHtml(null);
    setError(null);
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
        if (cancelled) return;
        setHtml(html);
        // A successful read clears any error from a previous failed read —
        // otherwise the red banner hangs around while a good chunk displays.
        setError(null);
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
      const { chunk } = await api.invoke('story:generate', { projectId, windowMinutes: windowChoice });
      // Select the new chunk so the right pane jumps to it immediately.
      setSelected(chunk.file);
      await refreshList();
    } catch (err) {
      setError(String(err));
    } finally {
      setGenerating(false);
    }
  }, [projectId, refreshList, windowChoice]);

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
            title={
              windowChoice === 'auto'
                ? 'Summarise agent activity. Auto picks a window from 15 min out to 7 days until it has enough to narrate.'
                : `Summarise the last ${WINDOW_LABELS.find((w) => w.value === windowChoice)?.label} of agent activity.`
            }
          >
            {generating ? '…writing' : '✨ Catch me up'}
          </button>
          <select
            value={String(windowChoice)}
            onChange={(e) => {
              const v = e.target.value;
              setWindowChoice(v === 'auto' ? 'auto' : (Number(v) as WindowChoice));
            }}
            disabled={generating}
            className="text-[11px] px-1.5 py-1 rounded border border-[--border] bg-[--panel] text-[--text] hover:bg-[--panel-strong] disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="story-window-select"
            title="How far back to look. Auto expands until there's enough to narrate."
          >
            {WINDOW_LABELS.map((w) => (
              <option key={String(w.value)} value={String(w.value)}>{w.label}</option>
            ))}
          </select>
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
          <ChunkFrame html={html} theme={theme} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-[--text-muted] text-sm">
            {selected ? 'loading…' : 'Select a chunk on the left.'}
          </div>
        )}
      </section>
    </div>
  );
}

function ChunkFrame({ html, theme }: { html: string; theme: 'light' | 'dark' }) {
  // Stamp the IDE's current theme onto the chunk's root so the page
  // matches the surrounding window — the CSS reads `:root[data-theme=...]`
  // first, falling back to prefers-color-scheme when the attribute is
  // absent (which is how the file looks when opened standalone).
  const themed = useMemo(() => withDataTheme(html, theme), [html, theme]);
  // srcDoc keeps document isolation without needing a blob URL — avoids
  // Electron CSP edge cases that were showing a blank white iframe.
  return (
    <iframe
      srcDoc={themed}
      sandbox="allow-same-origin"
      className="w-full h-full border-0"
      data-testid="story-frame"
      title="Story chunk"
    />
  );
}

function withDataTheme(html: string, theme: 'light' | 'dark'): string {
  if (!html) return '';
  // Stamp data-theme on the <html> element (new template reads it) AND
  // inject a last-wins override so chunks generated before the template
  // update still match the IDE theme AND use the newer layout density.
  const overrideVars = theme === 'dark'
    ? '--bg:#0e0e0d;--fg:#ebe9e6;--muted:#8a8a85;--rule:#2a2a28;--accent:#f97316;--panel:#181816;'
    : '--bg:#fafaf9;--fg:#1a1a1a;--muted:#666;--rule:#e5e5e5;--accent:#c2410c;--panel:#f3f3f2;';
  const override = `<style data-ide-theme-override="1">
    :root{${overrideVars}}
    main{max-width:60rem !important;padding:1.75rem 2rem 3rem !important;}
    header{padding-bottom:1rem !important;margin-bottom:1.5rem !important;}
    h1{font-size:1.6rem !important;margin:0 0 0.4rem !important;}
    details{margin-top:2rem !important;padding-top:1rem !important;}
  </style>`;
  const withTheme = html.replace(/<html\b([^>]*)>/i, (_, attrs) => {
    const cleaned = String(attrs).replace(/\sdata-theme="[^"]*"/gi, '');
    return `<html${cleaned} data-theme="${theme}">`;
  });
  // Injected right before </head> so it overrides earlier :root blocks.
  return withTheme.includes('</head>')
    ? withTheme.replace('</head>', `${override}</head>`)
    : withTheme + override;
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
