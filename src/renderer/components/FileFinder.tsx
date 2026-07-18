import Fuse from 'fuse.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@renderer/api';

interface FileEntry { relPath: string; name: string }

interface Props {
  open: boolean;
  projectId: number | null;
  onClose: () => void;
  onPick: (relPath: string) => void;
}

/**
 * ⌘P style file finder for the currently selected project.
 * Lazy-loads the full file list on open, fuzzy-matches on filename and
 * path, and hands the pick back to the caller (FilesTab opens it, App
 * routes to Files view).
 */
export function FileFinder({ open, projectId, onClose, onPick }: Props) {
  const [all, setAll] = useState<FileEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const load = useCallback(async () => {
    if (projectId == null) return;
    setLoading(true);
    try {
      const { files, total, truncated } = await api.invoke('files:list-all', { projectId, limit: 5000 });
      setAll(files);
      setTotal(total);
      setTruncated(truncated);
    } catch (e) {
      console.error(e);
      setAll([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    void load();
    inputRef.current?.focus();
  }, [open, load]);

  const fuse = useMemo(
    () => new Fuse(all, { keys: ['name', 'relPath'], threshold: 0.4, ignoreLocation: true }),
    [all],
  );
  const results = useMemo(
    () => (query ? fuse.search(query).map((r) => r.item) : all),
    [query, fuse, all],
  );
  const shown = results.slice(0, 40);

  useEffect(() => { setActiveIndex(0); }, [query]);
  useEffect(() => {
    if (!open) return;
    const item = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/40 backdrop-blur-sm"
      onClick={onClose}
      data-testid="file-finder"
    >
      <div
        className="bg-[--panel-strong] w-[720px] max-w-[92vw] rounded-xl shadow-2xl border border-[--border] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 border-b border-[--border]">
          <SearchIcon />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={loading ? 'Indexing…' : 'Find file by name or path…'}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIndex((i) => Math.min(i + 1, shown.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter' && shown[activeIndex]) {
                onPick(shown[activeIndex].relPath);
                onClose();
              } else if (e.key === 'Escape') {
                onClose();
              }
            }}
            className="flex-1 bg-transparent py-3 outline-none placeholder:text-[--text-muted]"
          />
          <span className="text-[--text-muted] text-[11px]">
            {shown.length} / {total.toLocaleString()}
            {truncated && <span className="ml-1 text-amber-400" title="Index capped at 5000 files.">·</span>}
          </span>
        </div>
        <ul ref={listRef} className="max-h-96 overflow-y-auto py-1">
          {!loading && shown.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-[--text-muted]">
              No files match <span className="font-mono text-[--text]">&ldquo;{query}&rdquo;</span>
            </li>
          )}
          {shown.map((f, i) => {
            const active = i === activeIndex;
            return (
              <li key={f.relPath}>
                <button
                  onClick={() => { onPick(f.relPath); onClose(); }}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={`w-full flex items-center gap-3 text-left px-3 py-1.5 mx-1 rounded-md ${
                    active ? 'bg-[color:var(--accent)] text-white' : 'hover:bg-[--panel]'
                  }`}
                >
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm truncate">{f.name}</span>
                    <span className={`block text-xs truncate ${active ? 'text-white/70' : 'text-[--text-muted]'}`}>
                      {f.relPath}
                    </span>
                  </span>
                  {active && <kbd>↩</kbd>}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="px-3 py-2 border-t border-[--border] text-[11px] text-[--text-muted] flex gap-3 justify-end">
          <span className="flex items-center gap-1"><kbd>↑↓</kbd> navigate</span>
          <span className="flex items-center gap-1"><kbd>↩</kbd> open</span>
          <span className="flex items-center gap-1"><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
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
