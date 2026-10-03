import { useCallback, useEffect, useRef, useState } from 'react';
import { usePersistedNumber } from '@renderer/hooks/usePersistedNumber';
import { Terminal, type IDisposable, type ITheme, type ILinkProvider, type IBufferCellPosition } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { api } from '@renderer/api';
import { useShellStream } from '@renderer/hooks/useShellStream';
import { terminalFocus } from '@renderer/hooks/useWindowTerminalFocus';
import { detectPaths } from '@shared/detect-paths';
import { sanitizeTerminalCopy } from '@shared/sanitize-terminal-copy';
import { HoverPreview, type HoverPreviewState } from './HoverPreview';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { toast } from '@renderer/hooks/useToasts';

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

export function ShellTab({
  projectId, shellIndex, onOpenFile, primary = false,
}: {
  projectId: number;
  shellIndex: number;
  onOpenFile?: (relPath: string, line: number | null) => void;
  /** Left pane or popout terminal: the window-focus fallback when none was used yet. */
  primary?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termHostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Ordering guard for the "snapshot vs live" race on remount. Live PTY
  // data can arrive between term.open() and the snapshot HTTP round-trip
  // resolving; if we wrote it straight to xterm and then also wrote the
  // snapshot, we'd get a splice like [live delta][full scrollback again].
  // Instead we buffer live in `pendingLive` until the snapshot lands,
  // then flush the buffer. `snapshotReady` flips to true after either
  // path completes so live writes go direct from then on.
  const snapshotReady = useRef(false);
  const pendingLive = useRef('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [fontSize, setFontSize] = usePersistedNumber('metaide.shellFontSize', 14, 9, 28);
  const [hover, setHover] = useState<HoverPreviewState | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const onOpenFileRef = useRef<typeof onOpenFile>(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const primaryRef = useRef(primary);
  primaryRef.current = primary;

  useEffect(() => {
    if (!termHostRef.current) return;
    const term = new Terminal({
      scrollback: 10000,
      // Explicit SF Mono stack — first match wins. Falls back through
      // common developer monospace fonts. `ui-monospace` alone can pick
      // Menlo bitmap fallback on some setups and looks pixelated.
      fontFamily: '"SF Mono", "JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, monospace',
      fontSize,
      fontWeight: 'normal',
      fontWeightBold: 'bold',
      lineHeight: 1.25,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      theme: buildTheme(),
      allowProposedApi: true,
      // screenReaderMode is intentionally off — the hidden mirror element
      // it injects into the DOM can drift out of sync during a fast
      // remount and paint stray characters into the visible row.
      // Explicit — don't let xterm try to boost contrast (blurs rendering).
      minimumContrastRatio: 1,
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

    // File-path link provider: matches things like src/main/index.ts:42
    // in terminal output, shows a hover preview, click opens in Files.
    const pathLinkProvider: ILinkProvider = {
      provideLinks(bufferLineNumber, callback) {
        const buf = term.buffer.active;
        const rawLine = buf.getLine(bufferLineNumber - 1);
        if (!rawLine) { callback(undefined); return; }
        const text = rawLine.translateToString(true);
        const hits = detectPaths(text);
        if (hits.length === 0) { callback(undefined); return; }
        callback(hits.map((h) => ({
          range: {
            start: { x: h.startIndex + 1, y: bufferLineNumber } as IBufferCellPosition,
            end:   { x: h.endIndex,       y: bufferLineNumber } as IBufferCellPosition,
          },
          text: h.raw,
          activate: () => {
            setHover(null);
            onOpenFileRef.current?.(h.path, h.line);
          },
          hover: (ev: MouseEvent) => {
            setHover({ x: ev.clientX, y: ev.clientY, projectId, path: h.path, line: h.line });
          },
          leave: () => { setHover(null); },
        })));
      },
    };
    const linkProviderDisposable: IDisposable = term.registerLinkProvider(pathLinkProvider);

    // NOTE ordering: we deliberately do NOT term.open() yet. Opening the
    // terminal against a container whose fonts haven't loaded or whose CSS
    // hasn't laid out yet means xterm measures the wrong cell width, so
    // every subsequent write lands at a mis-computed column. That produced
    // the "text wraps into a vertical column on the right" bug. We wait
    // until document.fonts is ready AND the host has real pixel dimensions
    // BEFORE opening the terminal.
    term.onData((data) => { void api.invoke('shells:write', { projectId, shellIndex, data }); });
    termRef.current = term;
    let opened = false;
    let disposed = false;
    const focusReg = terminalFocus.register({
      key: { projectId, shellIndex },
      primary: primaryRef.current,
      isOpen: () => opened,
      focus: () => term.focus(),
    });

    // Track the last-fit rows/cols so we can drop no-op resize calls that
    // would otherwise spam the PTY when the container reports the same
    // size repeatedly.
    let lastCols = -1, lastRows = -1;
    function syncSize() {
      if (!opened) return;
      try {
        const host = termHostRef.current;
        if (!host || host.clientWidth < 20 || host.clientHeight < 20) return;
        fit.fit();
        // After a fit, force a repaint — xterm's canvas/DOM renderer
        // occasionally leaves stale glyphs at the old cell positions
        // (that's why a manual window resize used to "fix" the display).
        try { term.refresh(0, Math.max(0, term.rows - 1)); } catch { /* fine */ }
        if (term.cols === lastCols && term.rows === lastRows) return;
        lastCols = term.cols; lastRows = term.rows;
        void api.invoke('shells:resize', { projectId, shellIndex, cols: term.cols, rows: term.rows });
      } catch { /* container might be zero-sized during transitions */ }
    }

    // Snapshot fetch runs in parallel with the open-when-ready gate below;
    // whichever finishes second writes the snapshot into a correctly-sized
    // terminal.
    snapshotReady.current = false;
    pendingLive.current = '';
    let cachedSnapshot: string | null = null;
    const snapshotPromise = api.invoke('shells:snapshot', { projectId, shellIndex })
      .then(({ output }) => { cachedSnapshot = output; })
      .catch(() => { cachedSnapshot = ''; });

    function writeSnapshotAndFlush() {
      if (termRef.current !== term || disposed) return;
      const output = cachedSnapshot ?? '';
      if (output) {
        term.reset();
        // Main serializes complete terminal state, so write it verbatim — it
        // also restores the live SGR state the next PTY bytes continue from.
        term.write(output);
      }
      if (pendingLive.current) term.write(pendingLive.current);
      snapshotReady.current = true;
      pendingLive.current = '';
      // One last fit + refresh once xterm has processed the write queue.
      requestAnimationFrame(syncSize);
    }

    /**
     * The actual open sequence: wait for fonts + a laid-out container,
     * THEN term.open, fit, and write the snapshot. This is the fix for
     * "text wraps into a vertical stripe on the right" — that only
     * happened when open+write ran before the container had real width,
     * because xterm computed a bogus cell size and every wrap landed at
     * the wrong column.
     */
    async function openWhenReady(): Promise<void> {
      try { await (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready; }
      catch { /* fine — best-effort */ }
      // Poll (via rAF) until the host has real dimensions. Bail after
      // ~2s so we don't hold up the terminal forever if a parent layout
      // is stuck; fallback opens against whatever's there.
      const startedAt = performance.now();
      while (!disposed) {
        const host = termHostRef.current;
        if (host && host.clientWidth >= 20 && host.clientHeight >= 20) break;
        if (performance.now() - startedAt > 2000) break;
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }
      if (disposed || termRef.current !== term) return;
      const host = termHostRef.current;
      if (!host) return;
      term.open(host);
      // Load the WebGL renderer AFTER open so its context binds to the
      // actual canvas. WebGL sidesteps the DOM renderer's row-width-vs-
      // container-width overflow bug that produced the vertical-stripe
      // artefact when cols were slightly off from the container's pixel
      // width (Chrome would wrap the "row" div's overflow into the next
      // visual line). If WebGL init fails (no GPU / driver hiccup) we
      // silently fall back to the DOM renderer.
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => { try { webgl.dispose(); } catch { /* fine */ } });
        term.loadAddon(webgl);
      } catch (e) { console.warn('[metaide] webgl renderer unavailable, falling back to DOM', e); }
      opened = true;
      term.textarea?.addEventListener('focus', () => focusReg.used());
      focusReg.opened();
      // First fit AFTER open so xterm has an element to measure.
      syncSize();
      // Snapshot may already be back — write it into the correctly-sized
      // terminal. If not yet, the .then() below picks up.
      if (cachedSnapshot != null) writeSnapshotAndFlush();
      else void snapshotPromise.then(writeSnapshotAndFlush);
    }
    void openWhenReady();

    // Fit follow-ups catch flex parents that settle after our open, plus
    // any late-arriving font-metric changes. The ResizeObserver below
    // handles genuine size changes during the terminal's lifetime.
    const late1 = window.setTimeout(syncSize, 150);
    const late2 = window.setTimeout(syncSize, 400);
    const onWinFocus = () => syncSize();
    window.addEventListener('focus', onWinFocus);

    const ro = new ResizeObserver(syncSize);
    if (containerRef.current) ro.observe(containerRef.current);

    // Intercept every copy from the terminal (Cmd+C, right-click Copy,
    // browser Edit menu) and replace the clipboard payload with a
    // sanitized version — strips ANSI, PUA icons, zero-width chars, NBSPs,
    // and trailing-space column padding. Without this, pastes into email
    // land as "Â " for NBSP and tofu boxes for Nerd Font glyphs.
    function onCopy(e: ClipboardEvent) {
      const sel = term.getSelection();
      if (!sel) return;
      e.preventDefault();
      const cleaned = sanitizeTerminalCopy(sel);
      try { e.clipboardData?.setData('text/plain', cleaned); }
      catch { /* fall back to navigator.clipboard below */ }
      if (!e.clipboardData) {
        void navigator.clipboard?.writeText(cleaned).catch(() => {});
      }
    }
    const copyHost = termHostRef.current;
    copyHost?.addEventListener('copy', onCopy);

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => { term.options.theme = buildTheme(); };
    media.addEventListener('change', onScheme);
    // Also fire when the in-app theme toggle flips `data-theme` on <html>:
    // the media query only tracks the OS, so without this the terminal keeps
    // its old palette after Settings → Appearance → Light/Dark.
    const themeObserver = new MutationObserver(() => { term.options.theme = buildTheme(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      disposed = true;
      window.clearTimeout(late1);
      window.clearTimeout(late2);
      window.removeEventListener('focus', onWinFocus);
      ro.disconnect();
      media.removeEventListener('change', onScheme);
      themeObserver.disconnect();
      copyHost?.removeEventListener('copy', onCopy);
      linkProviderDisposable.dispose();
      focusReg.unregister();
      term.dispose();
      termRef.current = null;
      searchRef.current = null;
    };
    // We deliberately don't include fontSize here — a font-size change
    // shouldn't recreate the terminal. The separate effect below applies
    // it to the running Terminal instance instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, shellIndex]);

  const findNext = useCallback((q: string) => {
    if (!q || !searchRef.current) return;
    searchRef.current.findNext(q, { caseSensitive: false, wholeWord: false, regex: false });
  }, []);
  const findPrev = useCallback((q: string) => {
    if (!q || !searchRef.current) return;
    searchRef.current.findPrevious(q, { caseSensitive: false, wholeWord: false, regex: false });
  }, []);

  // Push font-size changes into the running Terminal instance so ⌘+/⌘- feels live.
  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.fontSize = fontSize;
    // Trigger a resize so the fit addon recomputes cols/rows for the new font metrics.
    try {
      const el = containerRef.current;
      if (el) {
        const evt = new Event('resize'); void evt; // no-op; ResizeObserver already handles container size, but font metric change requires fit re-run
      }
    } catch { /* ignore */ }
  }, [fontSize]);

  // ⌘F opens the terminal search overlay when this tab has focus.
  // ⌘= / ⌘- / ⌘0 zoom the terminal font.
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'f' && !e.shiftKey) {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
      } else if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        setFontSize(fontSize + 1);
      } else if (mod && e.key === '-') {
        e.preventDefault();
        setFontSize(fontSize - 1);
      } else if (mod && e.key === '0') {
        e.preventDefault();
        setFontSize(14);
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [fontSize, setFontSize]);

  useShellStream(
    projectId,
    shellIndex,
    (data) => {
      if (snapshotReady.current) termRef.current?.write(data);
      else pendingLive.current += data;
    },
    () => { termRef.current?.write('\r\n[shell exited]\r\n'); },
  );

  // Outer div = padding + background. Inner div = pure terminal viewport,
  // so xterm's own geometry math sees an element with no padding or extra chrome.
  return (
    <div
      ref={containerRef}
      data-testid="shell-tab"
      tabIndex={-1}
      onDragOver={(e) => {
        // Terminal accepts BOTH OS file drops (from Finder) AND intra-app
        // drags from the Files tree (which set text/plain to the relPath).
        // Without preventDefault the webview would try to navigate to
        // file://<dropped-path> — that's the "error" the user was seeing.
        const types = e.dataTransfer?.types;
        if (types?.includes('Files') || types?.includes('text/plain')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDropActive(true);
        }
      }}
      onDragLeave={() => setDropActive(false)}
      onContextMenu={(e) => {
        // Only intercept when the click is inside the terminal viewport.
        // Anything else (search bar, drop overlay) uses default browser menu.
        if (!(e.target as HTMLElement).closest('.xterm')) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      onDrop={(e) => {
        setDropActive(false);
        const dt = e.dataTransfer;
        if (!dt) return;
        let paths: string[] = [];
        if (dt.files?.length) {
          paths = Array.from(dt.files).map((f) => api.pathForFile(f)).filter((p) => !!p);
        }
        if (paths.length === 0) {
          const text = dt.getData('text/plain');
          if (text) paths = [text];
        }
        if (paths.length === 0) return;
        e.preventDefault();
        // Single-quote each path so the CLI receives it verbatim, and escape
        // any embedded single-quote via the standard `'"'"'` gymnastics.
        const quoted = paths.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(' ');
        void api.invoke('shells:write', { projectId, shellIndex, data: quoted });
      }}
      className="relative w-full h-full min-h-0 px-3 pt-2 pb-3 bg-transparent focus:outline-none"
    >
      <div ref={termHostRef} className="w-full h-full" />
      {dropActive && (
        <div className="absolute inset-2 pointer-events-none rounded-md border-2 border-dashed border-[color:var(--accent)] bg-[color:var(--accent)]/10 flex items-center justify-center text-xs text-[--text] font-medium">
          Drop to paste path
        </div>
      )}
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
      <HoverPreview
        state={hover}
        onOpen={(relPath, line) => { setHover(null); onOpenFileRef.current?.(relPath, line); }}
      />
      {menu && (() => {
        const term = termRef.current;
        const hasSelection = !!term?.hasSelection();
        const items: ContextMenuItem[] = [
          {
            label: 'Copy',
            disabled: !hasSelection,
            onClick: async () => {
              const sel = term?.getSelection() ?? '';
              if (!sel) return;
              try {
                await navigator.clipboard.writeText(sanitizeTerminalCopy(sel));
                toast('Copied', { kind: 'success' });
              } catch (e) {
                toast('Copy failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
              }
            },
          },
          {
            label: 'Copy all (visible scrollback)',
            separatorAfter: true,
            onClick: async () => {
              const t = termRef.current;
              if (!t) return;
              const buf = t.buffer.active;
              const lines: string[] = [];
              for (let y = 0; y < buf.length; y++) {
                const line = buf.getLine(y);
                if (line) lines.push(line.translateToString(true));
              }
              try {
                await navigator.clipboard.writeText(sanitizeTerminalCopy(lines.join('\n')));
                toast(`Copied ${lines.length} lines`, { kind: 'success' });
              } catch (e) {
                toast('Copy failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
              }
            },
          },
          {
            label: 'Paste',
            onClick: async () => {
              try {
                const text = await navigator.clipboard.readText();
                if (text) void api.invoke('shells:write', { projectId, shellIndex, data: text });
              } catch (e) {
                toast('Paste failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
              }
            },
          },
          {
            label: 'Clear selection',
            disabled: !hasSelection,
            onClick: () => { termRef.current?.clearSelection(); },
          },
        ];
        return <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />;
      })()}
    </div>
  );
}
