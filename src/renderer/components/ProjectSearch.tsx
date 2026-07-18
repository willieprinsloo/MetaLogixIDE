import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@renderer/api';

interface Match { relPath: string; line: number; col: number; preview: string }

interface Props {
  open: boolean;
  projectId: number | null;
  onClose: () => void;
  onOpenMatch: (relPath: string, line: number) => void;
}

/**
 * ⌘⇧F Find in Project — modal search with a live-updating results list
 * grouped by file. Debounced query; escape / click-outside close.
 */
export function ProjectSearch({ open, projectId, onClose, onOpenMatch }: Props) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [matches, setMatches] = useState<Match[]>([]);
  const [filesScanned, setFilesScanned] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);

  const grouped = useMemo(() => {
    const map = new Map<string, Match[]>();
    for (const m of matches) {
      const arr = map.get(m.relPath) ?? [];
      arr.push(m);
      map.set(m.relPath, arr);
    }
    return [...map.entries()];
  }, [matches]);

  const flatFocusable = matches;

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setMatches([]);
    setFilesScanned(0);
    setTruncated(false);
    setError(null);
    setActiveIdx(0);
    inputRef.current?.focus();
  }, [open]);

  // Debounced search.
  useEffect(() => {
    if (!open || projectId == null) return;
    if (query.length < 2) { setMatches([]); setFilesScanned(0); setTruncated(false); setError(null); return; }
    const mySeq = ++seqRef.current;
    setLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const res = await api.invoke('search:project', { projectId, query, caseSensitive, regex });
        if (mySeq !== seqRef.current) return;                       // stale
        setMatches(res.matches);
        setFilesScanned(res.filesScanned);
        setTruncated(res.truncated);
        setError(null);
      } catch (e) {
        if (mySeq === seqRef.current) setError(String(e).replace(/^Error:\s*/, ''));
      } finally {
        if (mySeq === seqRef.current) setLoading(false);
      }
    }, 220);
    return () => window.clearTimeout(t);
  }, [open, projectId, query, caseSensitive, regex]);

  const openMatch = useCallback((m: Match) => { onOpenMatch(m.relPath, m.line); onClose(); }, [onOpenMatch, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 bg-black/50 backdrop-blur-sm"
      onClick={onClose}
      data-testid="project-search"
    >
      <div
        className="bg-[--panel-strong] w-[780px] max-w-[92vw] max-h-[80vh] rounded-xl shadow-2xl border border-[--border] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 border-b border-[--border]">
          <SearchIcon />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={projectId == null ? 'Select a project first' : 'Find in project…'}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, flatFocusable.length - 1)); }
              else if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
              else if (e.key === 'Enter' && flatFocusable[activeIdx]) { openMatch(flatFocusable[activeIdx]); }
              else if (e.key === 'Escape') onClose();
            }}
            className="flex-1 bg-transparent py-3 outline-none placeholder:text-[--text-muted] font-mono text-sm"
          />
          <ToolbarToggle title="Match case" active={caseSensitive} onClick={() => setCaseSensitive((v) => !v)}>Aa</ToolbarToggle>
          <ToolbarToggle title="Regular expression" active={regex} onClick={() => setRegex((v) => !v)}>.*</ToolbarToggle>
        </div>

        <div className="px-3 py-1.5 border-b border-[--border] text-[11px] text-[--text-muted] flex items-center gap-3">
          {loading && <span>Searching…</span>}
          {!loading && !error && (
            <span>
              {matches.length} match{matches.length === 1 ? '' : 'es'} in {grouped.length} file{grouped.length === 1 ? '' : 's'} · scanned {filesScanned}
              {truncated && <span className="text-amber-400" title="Scan capped for performance"> · capped</span>}
            </span>
          )}
          {error && <span className="text-[--danger]">{error}</span>}
        </div>

        <div className="flex-1 overflow-y-auto">
          {grouped.length === 0 && !loading && query.length >= 2 && !error && (
            <div className="p-6 text-center text-sm text-[--text-muted]">No matches.</div>
          )}
          {grouped.map(([file, hits]) => (
            <div key={file} className="border-b border-[--border] last:border-b-0">
              <div className="px-3 py-1 text-[11px] font-mono text-[--text-muted] bg-[--panel]/60 sticky top-0">{file}</div>
              {hits.map((m) => {
                const flatIdx = matches.indexOf(m);
                const active = flatIdx === activeIdx;
                return (
                  <button
                    key={`${m.relPath}:${m.line}:${m.col}`}
                    onClick={() => openMatch(m)}
                    onMouseEnter={() => setActiveIdx(flatIdx)}
                    className={`w-full text-left flex gap-3 px-3 py-1 text-[12px] font-mono ${
                      active ? 'bg-[color:var(--accent)] text-white' : 'hover:bg-[--panel]'
                    }`}
                  >
                    <span className={`w-10 text-right shrink-0 ${active ? 'text-white/70' : 'text-[--text-muted]'}`}>{m.line}</span>
                    <PreviewLine text={m.preview} query={query} regex={regex} caseSensitive={caseSensitive} active={active} />
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="px-3 py-2 border-t border-[--border] text-[11px] text-[--text-muted] flex gap-3 justify-end">
          <span className="flex items-center gap-1"><kbd>↑↓</kbd> navigate</span>
          <span className="flex items-center gap-1"><kbd>↩</kbd> open</span>
          <span className="flex items-center gap-1"><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

function PreviewLine({ text, query, regex, caseSensitive, active }: { text: string; query: string; regex: boolean; caseSensitive: boolean; active: boolean }) {
  const parts = useMemo(() => {
    if (!query || query.length < 2) return [{ t: text, hit: false }];
    let re: RegExp;
    try {
      re = regex
        ? new RegExp(query, caseSensitive ? 'g' : 'gi')
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
    } catch { return [{ t: text, hit: false }]; }
    const out: Array<{ t: string; hit: boolean }> = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ t: text.slice(last, m.index), hit: false });
      out.push({ t: m[0], hit: true });
      last = m.index + m[0].length;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    if (last < text.length) out.push({ t: text.slice(last), hit: false });
    return out;
  }, [text, query, regex, caseSensitive]);

  return (
    <span className="truncate flex-1">
      {parts.map((p, i) => (
        <span
          key={i}
          className={p.hit
            ? (active ? 'bg-white/25 rounded-sm px-0.5' : 'bg-[color:var(--accent)]/25 text-[--text] rounded-sm px-0.5')
            : ''}
        >
          {p.t}
        </span>
      ))}
    </span>
  );
}

function ToolbarToggle({ title, active, onClick, children }: { title: string; active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`h-6 w-8 flex items-center justify-center rounded text-[11px] font-mono border ${
        active
          ? 'bg-[color:var(--accent)] text-white border-transparent'
          : 'bg-[--panel] text-[--text-muted] border-[--border] hover:text-[--text]'
      }`}
    >
      {children}
    </button>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[--text-muted]">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}
