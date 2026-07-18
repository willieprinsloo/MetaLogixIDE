import Fuse from 'fuse.js';
import { useEffect, useMemo, useRef, useState } from 'react';

export interface Command {
  id: string;
  title: string;
  category?: string;
  hint?: string;    // e.g. keyboard shortcut label like "⌘K"
  run: () => void | Promise<void>;
}

interface Props {
  open: boolean;
  commands: Command[];
  onClose: () => void;
}

export function CommandPalette({ open, commands, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const fuse = useMemo(
    () => new Fuse(commands, { keys: ['title', 'category', 'hint'], threshold: 0.4, ignoreLocation: true }),
    [commands],
  );
  const results = useMemo(
    () => (query ? fuse.search(query).map((r) => r.item) : commands),
    [query, fuse, commands],
  );
  const shown = results.slice(0, 40);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      inputRef.current?.focus();
    }
  }, [open]);
  useEffect(() => setActiveIndex(0), [query]);
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
      data-testid="command-palette"
    >
      <div
        className="bg-[--panel-strong] w-[640px] max-w-[92vw] rounded-xl shadow-2xl border border-[--border] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 border-b border-[--border]">
          <ChevronIcon />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Run a command…"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, shown.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); }
              else if (e.key === 'Enter' && shown[activeIndex]) {
                const cmd = shown[activeIndex];
                onClose();
                void cmd.run();
              } else if (e.key === 'Escape') onClose();
            }}
            className="flex-1 bg-transparent py-3 outline-none placeholder:text-[--text-muted]"
          />
        </div>
        <ul ref={listRef} className="max-h-96 overflow-y-auto py-1">
          {shown.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-[--text-muted]">No commands match.</li>
          )}
          {shown.map((c, i) => {
            const active = i === activeIndex;
            return (
              <li key={c.id}>
                <button
                  onClick={() => { onClose(); void c.run(); }}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={`w-full flex items-center gap-3 text-left px-3 py-1.5 mx-1 rounded-md ${
                    active ? 'bg-[color:var(--accent)] text-white' : 'hover:bg-[--panel]'
                  }`}
                >
                  <span className="flex-1 min-w-0">
                    {c.category && (
                      <span className={`text-[10px] uppercase tracking-wider mr-2 ${active ? 'text-white/70' : 'text-[--text-muted]'}`}>
                        {c.category}
                      </span>
                    )}
                    <span className="text-sm">{c.title}</span>
                  </span>
                  {c.hint && <kbd>{c.hint}</kbd>}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="px-3 py-2 border-t border-[--border] text-[11px] text-[--text-muted] flex gap-3 justify-end">
          <span className="flex items-center gap-1"><kbd>↑↓</kbd> navigate</span>
          <span className="flex items-center gap-1"><kbd>↩</kbd> run</span>
          <span className="flex items-center gap-1"><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[--text-muted]">
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}
