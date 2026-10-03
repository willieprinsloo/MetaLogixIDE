import Fuse from 'fuse.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useProjects } from '@renderer/hooks/useProjects';
import { useAliveShellIds } from '@renderer/hooks/useAliveShellIds';
import { useProjectClaudeState } from '@renderer/hooks/useClaudeStates';
import type { Project } from '@shared/types';
import { StatusDot } from './StatusDot';

export function ProjectSwitcher({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (p: Project) => void }) {
  const { projects, refresh } = useProjects();
  const { aliveIds } = useAliveShellIds();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const fuse = useMemo(() => new Fuse(projects, { keys: ['name', 'path'], threshold: 0.4 }), [projects]);
  const results = useMemo(
    () => (query ? fuse.search(query).map((r) => r.item) : projects),
    [query, fuse, projects],
  );

  useEffect(() => {
    if (open) {
      void refresh();
      setActiveIndex(0);
      inputRef.current?.focus();
    } else {
      setQuery('');
    }
  }, [open, refresh]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const item = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  if (!open) return null;

  const shown = results.slice(0, 20);
  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-start justify-center pt-24 z-50"
      onClick={onClose}
    >
      <div
        className="bg-[--panel-strong] w-[640px] max-w-[92vw] rounded-xl shadow-2xl border border-[--border] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 border-b border-[--border]">
          <SearchIcon />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Switch to project…"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIndex((i) => Math.min(i + 1, shown.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter' && shown[activeIndex]) {
                onPick(shown[activeIndex]);
                onClose();
              } else if (e.key === 'Escape') {
                onClose();
              }
            }}
            className="flex-1 bg-transparent py-3 outline-none placeholder:text-[--text-muted]"
          />
          <span className="text-[--text-muted] text-[11px]">{shown.length} of {projects.length}</span>
        </div>
        <ul ref={listRef} className="max-h-96 overflow-y-auto py-1">
          {shown.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-[--text-muted]">
              No projects match <span className="font-mono text-[--text]">&ldquo;{query}&rdquo;</span>
            </li>
          )}
          {shown.map((p, i) => (
            <ProjectSwitcherRow
              key={p.id}
              project={p}
              active={i === activeIndex}
              alive={aliveIds.has(p.id)}
              onPick={() => { onPick(p); onClose(); }}
              onHover={() => setActiveIndex(i)}
            />
          ))}
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

/**
 * One palette row. A component of its own (rather than inline in the
 * `.map()`) so `useProjectClaudeState` has a stable per-project call site.
 * AC21: the dot gets the white ring on the active row, since the accent
 * fill it sits on doesn't otherwise clear 3:1 for amber or red.
 */
function ProjectSwitcherRow({
  project, active, alive, onPick, onHover,
}: {
  project: Project;
  active: boolean;
  alive: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  const claudeState = useProjectClaudeState(project.id);
  return (
    <li>
      <button
        onClick={onPick}
        onMouseEnter={onHover}
        className={`w-full flex items-center gap-3 text-left px-3 py-2 mx-1 rounded-md ${
          active ? 'bg-[color:var(--accent)] text-white' : 'hover:bg-[--panel]'
        }`}
      >
        {alive ? (
          <StatusDot state={claudeState} ring={active} className="shrink-0" />
        ) : (
          <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-transparent border border-[--border]" />
        )}
        <span className="flex-1 min-w-0">
          <span className="block text-sm truncate">{project.name}</span>
          <span className={`block text-xs truncate ${active ? 'text-white/70' : 'text-[--text-muted]'}`}>{project.path}</span>
        </span>
        {active && <kbd>↩</kbd>}
      </button>
    </li>
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
