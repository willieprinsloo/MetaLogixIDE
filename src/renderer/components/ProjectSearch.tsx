import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@renderer/api';
import { ModalFrame } from '@renderer/components/ModalFrame';
import { ICON_SIZE, ICON_STROKE } from './icon-size';

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
    <ModalFrame
      testId="project-search"
      tier="modal"
      motion="none"
      layerClassName="flex items-start justify-center pt-16"
      onDismiss={onClose}
    >
      <div className="modal-sheet modal-sheet--compact w-[780px] max-w-[92vw] max-h-[80vh] overflow-hidden flex flex-col">
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
            className="flex-1 bg-transparent py-3 outline-none placeholder:text-[--modal-text-muted] font-mono text-sm"
          />
          <ToolbarToggle title="Match case" active={caseSensitive} onClick={() => setCaseSensitive((v) => !v)}>Aa</ToolbarToggle>
          <ToolbarToggle title="Regular expression" active={regex} onClick={() => setRegex((v) => !v)}>.*</ToolbarToggle>
        </div>

        <div className="px-3 py-1.5 border-b border-[--border] text-[11px] text-[--modal-text-muted] flex items-center gap-3">
          {loading && <span>Searching…</span>}
          {!loading && !error && (
            <span>
              {matches.length} match{matches.length === 1 ? '' : 'es'} in {grouped.length} file{grouped.length === 1 ? '' : 's'} · scanned {filesScanned}
              {truncated && <span className="text-amber-400" title="Scan capped for performance"> · capped</span>}
            </span>
          )}
          {error && <span className="text-[--danger]">{error}</span>}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {grouped.length === 0 && !loading && query.length >= 2 && !error && (
            <div className="p-6 text-center text-sm text-[--modal-text-muted]">No matches.</div>
          )}
          {grouped.map(([file, hits]) => (
            <div key={file} className="border-b border-[--border] last:border-b-0">
              <div className="px-3 py-1 text-[11px] font-mono text-[--modal-text-muted] bg-[--panel]/60 sticky top-0">{file}</div>
              {hits.map((m) => {
                const flatIdx = matches.indexOf(m);
                const active = flatIdx === activeIdx;
                return (
                  <button
                    key={`${m.relPath}:${m.line}:${m.col}`}
                    onClick={() => openMatch(m)}
                    onMouseEnter={() => setActiveIdx(flatIdx)}
                    className={`w-full text-left flex gap-3 px-3 py-1 text-[12px] font-mono ${
                      active ? 'bg-[--modal-row-active] text-[--modal-row-active-text]' : 'hover:bg-[--panel]'
                    }`}
                  >
                    <span className={`w-10 text-right shrink-0 ${active ? 'text-[--modal-row-active-text]' : 'text-[--modal-text-muted]'}`}>{m.line}</span>
                    <PreviewLine text={m.preview} query={query} regex={regex} caseSensitive={caseSensitive} />
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="px-3 py-2 border-t border-[--border] text-[11px] text-[--modal-text-muted] flex gap-3 justify-end">
          <span className="flex items-center gap-1"><kbd>↑↓</kbd> navigate</span>
          <span className="flex items-center gap-1"><kbd>↩</kbd> open</span>
          <span className="flex items-center gap-1"><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </ModalFrame>
  );
}

function PreviewLine({ text, query, regex, caseSensitive }: { text: string; query: string; regex: boolean; caseSensitive: boolean }) {
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
          className={p.hit ? 'bg-[color:var(--accent)]/25 text-[--text] rounded-sm px-0.5' : ''}
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
          ? 'bg-[color:var(--accent)] text-[--accent-text] border-transparent'
          : 'bg-[--panel] text-[--modal-text-muted] border-[--border] hover:text-[--text]'
      }`}
    >
      {children}
    </button>
  );
}

function SearchIcon() {
  return (
    <svg width={ICON_SIZE.md} height={ICON_SIZE.md} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE.outline} strokeLinecap="round" strokeLinejoin="round" className="text-[--modal-text-muted]">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}
