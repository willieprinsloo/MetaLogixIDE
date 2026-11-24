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

export interface StoryTemplate {
  title: string;
  /** Range line shown under the title, e.g. "14:30 – 14:47 · 17 minutes · 2 shells". */
  subtitle: string;
  /** Plain-English paragraphs; each becomes its own `<p>`. */
  paragraphs: string[];
  /** Raw events, shown inside a <details> at the bottom. */
  timeline: TimelineRow[];
  /** Project name, shown in the header strap. */
  project: string;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export function renderStoryHtml(t: StoryTemplate): string {
  const paragraphs = t.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('\n');
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
      max-width: 44rem;
      margin: 0 auto;
      padding: 3rem 1.5rem 6rem;
    }
    header {
      border-bottom: 1px solid var(--rule);
      padding-bottom: 1.25rem;
      margin-bottom: 2rem;
    }
    .project {
      font: 500 11px/1 ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 0.75rem;
    }
    h1 {
      font: 700 2rem/1.2 ui-serif, Georgia, serif;
      margin: 0 0 0.5rem;
      color: var(--fg);
      letter-spacing: -0.015em;
    }
    .subtitle {
      font: 400 13px/1.5 ui-sans-serif, system-ui, sans-serif;
      color: var(--muted);
    }
    p {
      margin: 0 0 1.15rem;
    }
    details {
      margin-top: 3rem;
      border-top: 1px solid var(--rule);
      padding-top: 1.5rem;
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
    ${paragraphs || '<div class="empty">Nothing happened in this window.</div>'}
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
