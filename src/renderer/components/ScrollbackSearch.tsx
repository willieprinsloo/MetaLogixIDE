import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@renderer/api';
import { ModalFrame } from '@renderer/components/ModalFrame';
import { ICON_SIZE } from './icon-size';
import { XIcon } from './shell-icons';

interface Match {
  projectId: number;
  shellIndex: number;
  projectName: string;
  launchName: string;
  pid: number;
  line: string;
  lineNumber: number;
  contextBefore: string[];
  contextAfter: string[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called with a match location so the caller can focus the tab. */
  onFocus: (projectId: number, shellIndex: number) => void;
}

/**
 * Global scrollback search — greps every alive shell's rolling scrollback
 * for a query and shows matches grouped by shell. Debounces at 250ms; ⌘⏎ on
 * a match focuses that shell tab. Rendered as a top-of-screen modal so it
 * doesn't push around the shell being searched.
 */
export function ScrollbackSearch({ open, onClose, onFocus }: Props) {
  const [query, setQuery] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [matches, setMatches] = useState<Match[]>([]);
  const [scanned, setScanned] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const runSearch = useCallback(async (q: string, re: boolean, cs: boolean) => {
    if (!q.trim()) { setMatches([]); setScanned(0); return; }
    setLoading(true);
    try {
      const { matches, shellsScanned } = await api.invoke('shells:search-scrollback', {
        query: q, regex: re, caseSensitive: cs, contextLines: 1,
      });
      setMatches(matches);
      setScanned(shellsScanned);
      setSelected(0);
    } catch { setMatches([]); }
    finally { setLoading(false); }
  }, []);

  // Debounce so a fast typist doesn't fire a search per keystroke.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => { void runSearch(query, regex, caseSensitive); }, 250);
    return () => window.clearTimeout(t);
  }, [open, query, regex, caseSensitive, runSearch]);

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((n) => Math.min(matches.length - 1, n + 1)); }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); setSelected((n) => Math.max(0, n - 1)); }
      else if (e.key === 'Enter' && matches[selected]) {
        e.preventDefault();
        const m = matches[selected]!;
        onFocus(m.projectId, m.shellIndex);
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, matches, selected, onClose, onFocus]);

  if (!open) return null;

  return (
    <ModalFrame
      testId="scrollback-search"
      tier="modal"
      motion="none"
      layerClassName="flex items-start justify-center pt-[10vh]"
      onDismiss={onClose}
    >
      <div className="modal-sheet modal-sheet--compact w-[720px] max-w-[92vw] max-h-[75vh] flex flex-col overflow-hidden">
        <div className="px-3 py-2 border-b border-[--border] flex items-center gap-2">
          <span className="text-xs text-[--modal-text-muted]">🔎 all shells</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search live scrollback across every shell…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-[--modal-text-muted]"
          />
          <label className="flex items-center gap-1 text-[10px] text-[--modal-text-muted]" title="Match case">
            <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} className="accent-[color:var(--accent)]" />
            Aa
          </label>
          <label className="flex items-center gap-1 text-[10px] text-[--modal-text-muted]" title="Regex">
            <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} className="accent-[color:var(--accent)]" />
            .*
          </label>
          <button
            onClick={onClose}
            className="text-[--modal-text-muted] hover:text-[--text] w-7 h-7 flex items-center justify-center rounded hover:bg-[--panel]"
            aria-label="Close"
          >
            <XIcon size={ICON_SIZE.md} />
          </button>
        </div>
        <div className="px-3 py-1 border-b border-[--border] text-[10px] text-[--modal-text-muted] flex gap-3">
          <span>{loading ? 'searching…' : `${matches.length} match${matches.length === 1 ? '' : 'es'} across ${scanned} shell${scanned === 1 ? '' : 's'}`}</span>
          <span className="ml-auto opacity-80">↑↓ to navigate · ⏎ to focus · Esc to close</span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto font-mono">
          {!loading && query.trim() && matches.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-[--modal-text-muted]">No matches — try a different query, or open a shell to search.</div>
          )}
          {matches.map((m, i) => (
            <button
              key={`${m.projectId}:${m.shellIndex}:${m.lineNumber}:${i}`}
              onClick={() => { onFocus(m.projectId, m.shellIndex); onClose(); }}
              onMouseEnter={() => setSelected(i)}
              className={`w-full text-left px-3 py-1.5 text-[11px] border-b border-[--border]/70 hover:bg-[--panel] block ${
                i === selected ? 'bg-[--panel]' : ''
              }`}
            >
              <div className="flex items-center gap-2 text-[10px]">
                <span className="text-[color:var(--accent)] font-semibold">{m.projectName}</span>
                <span className="text-[--modal-text-muted]">/</span>
                <span className="text-[--modal-text-muted]">{m.launchName}</span>
                <span className="text-[--modal-text-muted] ml-auto">line {m.lineNumber}</span>
              </div>
              {m.contextBefore.map((l, ci) => (
                <div key={`b${ci}`} className="text-[--modal-text-muted] opacity-60 truncate">{l}</div>
              ))}
              <div className="text-[--text] whitespace-pre-wrap break-all">
                {highlight(m.line, query, regex, caseSensitive)}
              </div>
              {m.contextAfter.map((l, ci) => (
                <div key={`a${ci}`} className="text-[--modal-text-muted] opacity-60 truncate">{l}</div>
              ))}
            </button>
          ))}
        </div>
      </div>
    </ModalFrame>
  );
}

function highlight(line: string, query: string, regex: boolean, caseSensitive: boolean): React.ReactNode {
  if (!query) return line;
  let re: RegExp;
  try {
    re = regex
      ? new RegExp(query, caseSensitive ? 'g' : 'gi')
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
  } catch { return line; }
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) parts.push(<span key={key++}>{line.slice(last, m.index)}</span>);
    parts.push(<mark key={key++} className="bg-amber-500/40 text-inherit">{m[0]}</mark>);
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  if (last < line.length) parts.push(<span key={key++}>{line.slice(last)}</span>);
  return parts;
}
