import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { api } from '@renderer/api';
import { useShellStream } from '@renderer/hooks/useShellStream';

function readVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function buildTheme(): ITheme {
  return {
    background: 'rgba(0,0,0,0)',
    foreground: readVar('--term-fg',        '#e6edf3'),
    cursor:     readVar('--term-cursor',    '#e6edf3'),
    selectionBackground: readVar('--term-selection', 'rgba(255,255,255,0.2)'),
  };
}

export function ShellTab({ projectId, shellIndex }: { projectId: number; shellIndex: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termHostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const receivedLive = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (!termHostRef.current) return;
    const term = new Terminal({
      scrollback: 10000,
      // Explicit SF Mono stack — first match wins. Falls back through
      // common developer monospace fonts. `ui-monospace` alone can pick
      // Menlo bitmap fallback on some setups and looks pixelated.
      fontFamily: '"SF Mono", "JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, monospace',
      fontSize: 14,
      fontWeight: 'normal',
      fontWeightBold: 'bold',
      lineHeight: 1.25,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      theme: buildTheme(),
      allowProposedApi: true,
      screenReaderMode: true,
      // Explicit — don't let xterm try to boost contrast (blurs rendering).
      minimumContrastRatio: 1,
      // Skip WebGL: on macOS with translucent backgrounds and retina it
      // sometimes rasterises to a half-DPR buffer and looks pixelated.
      // The canvas renderer (default) is subpixel-crisp here.
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = '11';
    term.loadAddon(new WebLinksAddon((_ev: MouseEvent, url: string) => {
      void api.invoke('app:open-external', { url }).catch((e) => console.error(e));
    }));
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;

    term.open(termHostRef.current);
    term.onData((data) => { void api.invoke('shells:write', { projectId, shellIndex, data }); });
    termRef.current = term;

    function syncSize() {
      try {
        fit.fit();
        void api.invoke('shells:resize', { projectId, shellIndex, cols: term.cols, rows: term.rows });
      } catch { /* container might be zero-sized during transitions */ }
    }

    // Fit once after mount (allow font metrics to settle), then on resize.
    requestAnimationFrame(() => {
      requestAnimationFrame(syncSize);
    });

    // Replay any existing scrollback from the PTY so late-attaching viewports
    // (a pop-out window, tab switch back, second monitor) don't see an empty
    // terminal while the shell is idle. If a live event has already arrived
    // by the time the snapshot resolves, skip the replay to avoid an
    // out-of-order splice of old content after fresh output.
    receivedLive.current = false;
    (async () => {
      try {
        const { output } = await api.invoke('shells:snapshot', { projectId, shellIndex });
        if (output && termRef.current === term && !receivedLive.current) term.write(output);
      } catch { /* ignore — snapshot is best-effort */ }
    })();

    const ro = new ResizeObserver(syncSize);
    if (containerRef.current) ro.observe(containerRef.current);

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => { term.options.theme = buildTheme(); };
    media.addEventListener('change', onScheme);

    return () => {
      ro.disconnect();
      media.removeEventListener('change', onScheme);
      term.dispose();
      termRef.current = null;
      searchRef.current = null;
    };
  }, [projectId, shellIndex]);

  const findNext = useCallback((q: string) => {
    if (!q || !searchRef.current) return;
    searchRef.current.findNext(q, { caseSensitive: false, wholeWord: false, regex: false });
  }, []);
  const findPrev = useCallback((q: string) => {
    if (!q || !searchRef.current) return;
    searchRef.current.findPrevious(q, { caseSensitive: false, wholeWord: false, regex: false });
  }, []);

  // ⌘F opens the terminal search overlay when this tab has focus.
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'f' && !e.shiftKey) {
        e.preventDefault();
        setSearchOpen(true);
        // Focus after paint so React has rendered the input.
        requestAnimationFrame(() => searchInputRef.current?.focus());
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, []);

  useShellStream(
    projectId,
    shellIndex,
    (data) => { receivedLive.current = true; termRef.current?.write(data); },
    () => { termRef.current?.write('\r\n[shell exited]\r\n'); },
  );

  // Outer div = padding + background. Inner div = pure terminal viewport,
  // so xterm's own geometry math sees an element with no padding or extra chrome.
  return (
    <div
      ref={containerRef}
      data-testid="shell-tab"
      tabIndex={-1}
      className="relative w-full h-full px-3 pt-2 pb-3 bg-transparent focus:outline-none"
    >
      <div ref={termHostRef} className="w-full h-full" />
      {searchOpen && (
        <div
          className="absolute top-2 right-3 z-10 flex items-center gap-1 bg-[--panel-strong] border border-[--border] rounded-md shadow-lg px-1.5 py-1"
          data-testid="shell-search"
        >
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter')      { if (e.shiftKey) findPrev(searchQuery); else findNext(searchQuery); }
              else if (e.key === 'Escape') { setSearchOpen(false); setSearchQuery(''); searchRef.current?.clearDecorations(); termRef.current?.focus(); }
            }}
            placeholder="Find…"
            className="bg-transparent text-sm px-2 py-0.5 outline-none placeholder:text-[--text-muted] w-40"
          />
          <button onClick={() => findPrev(searchQuery)} title="Previous (⇧↩)" className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel]">↑</button>
          <button onClick={() => findNext(searchQuery)} title="Next (↩)"      className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel]">↓</button>
          <button
            onClick={() => { setSearchOpen(false); setSearchQuery(''); searchRef.current?.clearDecorations(); termRef.current?.focus(); }}
            title="Close (Esc)"
            className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel]"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
