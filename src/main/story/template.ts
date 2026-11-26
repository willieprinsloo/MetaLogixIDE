/**
 * Self-contained HTML template for a story chunk — visual-explainer
 * aesthetic (real typography, auto light/dark, collapsible timeline).
 *
 * Keep it dependency-free: no external fonts, no scripts beyond what we
 * inline. The file has to open cleanly in a plain browser as well as in
 * the StoryTab's webview.
 */

export interface TimelineRow {
  /** HH:MM:SS, sliced from the entry ts. */
  time: string;
  /** Short badge: "edit", "test", "prompt", "chat"… */
  kind: string;
  /** Who did it: "claude#0", "codex#1", "human". */
  who: string;
  /** Free-text — tool target, prompt excerpt, chat body. */
  text: string;
}

/**
 * One card in the vertical timeline. Replaces the single prose block
 * when the generator can split the window into periods; the paragraphs
 * array stays as a fallback for the template narrator.
 */
export interface TimelinePeriod {
  /** HH:MM or "Nov 24 13:40" for multi-day cards. */
  startLabel: string;
  endLabel: string;
  /** "35 min · 42 actions" — the strip under the time range. */
  metaLabel: string;
  /** Gap strip rendered ABOVE this card. Null means no strip. */
  gapBeforeLabel: string | null;
  /** 4-10 words, "Ported Ghostty tests". */
  headline: string;
  /** 2-3 sentences. */
  paragraph: string;
}

export interface StoryTemplate {
  title: string;
  /** Range line shown under the title, e.g. "14:30 – 14:47 · 17 minutes · 2 shells". */
  subtitle: string;
  /** Preferred: vertical cards. When omitted, falls back to `paragraphs`. */
  periods?: TimelinePeriod[];
  /** Plain-English paragraphs; each becomes its own `<p>`. Used when
   *  `periods` is not supplied (e.g. the template-fallback narrator). */
  paragraphs?: string[];
  /** Raw events, shown inside a <details> at the bottom. */
  timeline: TimelineRow[];
  /** Project name, shown in the header strap. */
  project: string;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/**
 * Render the main body — either the timeline cards (when `periods` is
 * non-empty) or the fallback paragraph stack. Returns an HTML fragment
 * that goes between the header and the raw-events details.
 */
function renderBody(t: StoryTemplate): string {
  if (t.periods && t.periods.length > 0) {
    return `<ol class="timeline">${t.periods.map(renderPeriod).join('')}</ol>`;
  }
  if (t.paragraphs && t.paragraphs.length > 0) {
    return t.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('\n');
  }
  return '<div class="empty">Nothing happened in this window.</div>';
}

function renderPeriod(p: TimelinePeriod): string {
  const gap = p.gapBeforeLabel
    ? `<li class="gap" aria-hidden="true"><span>${esc(p.gapBeforeLabel)}</span></li>`
    : '';
  const sameEdge = p.startLabel === p.endLabel;
  const range = sameEdge
    ? `<span class="t-start">${esc(p.startLabel)}</span>`
    : `<span class="t-start">${esc(p.startLabel)}</span><span class="t-sep" aria-hidden="true">→</span><span class="t-end">${esc(p.endLabel)}</span>`;
  return `${gap}
    <li class="period">
      <div class="when">${range}<span class="meta">${esc(p.metaLabel)}</span></div>
      <h2 class="headline">${esc(p.headline || 'Period')}</h2>
      <p class="body">${esc(p.paragraph)}</p>
    </li>`;
}

export function renderStoryHtml(t: StoryTemplate): string {
  const body = renderBody(t);
  const rows = t.timeline.map((r) => `
      <tr>
        <td class="t">${esc(r.time)}</td>
        <td class="k k-${esc(r.kind)}">${esc(r.kind)}</td>
        <td class="w">${esc(r.who)}</td>
        <td class="x">${esc(r.text)}</td>
      </tr>`).join('');
  const rowCount = t.timeline.length;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(t.title)}</title>
  <style>
    :root {
      --bg: #fafaf9;
      --fg: #1a1a1a;
      --muted: #666;
      --rule: #e5e5e5;
      --accent: #c2410c;
      --panel: #f3f3f2;
      --k-edit: #10b981;
      --k-test: #3b82f6;
      --k-chat: #a855f7;
      --k-prompt: #f59e0b;
      --k-tool: #c2410c;
      --k-turn-end: #999;
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        --bg: #0e0e0d;
        --fg: #ebe9e6;
        --muted: #8a8a85;
        --rule: #2a2a28;
        --accent: #f97316;
        --panel: #181816;
      }
    }
    /* Explicit override — the IDE stamps data-theme on <html> so the chunk
       matches the surrounding window even when the system is set otherwise. */
    :root[data-theme="dark"] {
      --bg: #0e0e0d;
      --fg: #ebe9e6;
      --muted: #8a8a85;
      --rule: #2a2a28;
      --accent: #f97316;
      --panel: #181816;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
    body {
      font: 17px/1.65 ui-serif, Georgia, 'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Palatino, serif;
      -webkit-font-smoothing: antialiased;
    }
    main {
      max-width: 60rem;
      margin: 0 auto;
      padding: 1.75rem 2rem 3rem;
    }
    header {
      border-bottom: 1px solid var(--rule);
      padding-bottom: 1rem;
      margin-bottom: 1.5rem;
    }
    .project {
      font: 500 11px/1 ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 0.75rem;
    }
    h1 {
      font: 700 1.6rem/1.2 ui-serif, Georgia, serif;
      margin: 0 0 0.4rem;
      color: var(--fg);
      letter-spacing: -0.015em;
    }
    .subtitle {
      font: 400 13px/1.5 ui-sans-serif, system-ui, sans-serif;
      color: var(--muted);
    }
    /* --- period cards --- */
    .timeline {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .timeline .period {
      position: relative;
      padding: 1.25rem 0 1.25rem 1.5rem;
      border-left: 2px solid var(--rule);
    }
    .timeline .period::before {
      content: "";
      position: absolute;
      left: -0.47rem;
      top: 1.55rem;
      width: 0.8rem;
      height: 0.8rem;
      border-radius: 999px;
      background: var(--accent);
      box-shadow: 0 0 0 3px var(--bg);
    }
    .timeline .period + .period {
      border-top: 1px dashed var(--rule);
      margin-top: 0;
    }
    .timeline .when {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 0.5rem;
      font: 500 12px/1 ui-sans-serif, system-ui, sans-serif;
      color: var(--muted);
      letter-spacing: 0.04em;
      margin-bottom: 0.35rem;
    }
    .timeline .t-start, .timeline .t-end {
      font-variant-numeric: tabular-nums;
      color: var(--fg);
    }
    .timeline .t-sep { color: var(--muted); }
    .timeline .meta { color: var(--muted); }
    .timeline .headline {
      font: 600 1.15rem/1.3 ui-serif, Georgia, serif;
      margin: 0 0 0.55rem;
      color: var(--fg);
      letter-spacing: -0.01em;
    }
    .timeline .body {
      margin: 0;
      font-size: 15px;
      line-height: 1.6;
    }
    .timeline .gap {
      list-style: none;
      padding: 0.75rem 0 0.75rem 1.5rem;
      border-left: 2px dotted var(--rule);
      color: var(--muted);
      font: italic 13px/1.4 ui-sans-serif, system-ui, sans-serif;
    }
    .timeline .gap span { opacity: 0.8; }
    /* --- Fallback single-prose paragraphs --- */
    p {
      margin: 0 0 1.15rem;
    }
    details {
      margin-top: 2rem;
      border-top: 1px solid var(--rule);
      padding-top: 1rem;
    }
    summary {
      cursor: pointer;
      font: 500 12px/1 ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      padding: 0.25rem 0;
      user-select: none;
    }
    summary:hover { color: var(--fg); }
    table {
      width: 100%;
      margin-top: 1rem;
      border-collapse: collapse;
      font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    td {
      padding: 0.35rem 0.5rem;
      vertical-align: top;
      border-bottom: 1px solid var(--rule);
    }
    td.t { color: var(--muted); white-space: nowrap; width: 5rem; font-variant-numeric: tabular-nums; }
    td.k {
      white-space: nowrap;
      width: 5rem;
      font-weight: 500;
      color: var(--muted);
    }
    td.k-edit { color: var(--k-edit); }
    td.k-test { color: var(--k-test); }
    td.k-chat { color: var(--k-chat); }
    td.k-prompt { color: var(--k-prompt); }
    td.k-tool { color: var(--k-tool); }
    td.k-turn-end { color: var(--k-turn-end); }
    td.w { color: var(--muted); white-space: nowrap; width: 6rem; }
    td.x { word-break: break-word; color: var(--fg); }
    .empty {
      padding: 2rem 0;
      color: var(--muted);
      text-align: center;
      font: italic 15px/1.5 ui-serif, Georgia, serif;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="project">${esc(t.project)}</div>
      <h1>${esc(t.title)}</h1>
      <div class="subtitle">${esc(t.subtitle)}</div>
    </header>
    ${body}
    ${rowCount > 0 ? `
    <details>
      <summary>Timeline · ${rowCount} events</summary>
      <table>
        <tbody>${rows}
        </tbody>
      </table>
    </details>` : ''}
  </main>
</body>
</html>
`;
}
