import { useCallback, useEffect, useRef, useState } from 'react';
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
import { AnimatePresence } from 'motion/react';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { isTerminalGeometryHeld, onTerminalGeometryRelease } from '@renderer/terminal-geometry-hold';
import { toast } from '@renderer/hooks/useToasts';
import { useFontSettings } from '@renderer/fonts/font-settings-context';
import { useTerminalFontSize } from '@renderer/fonts/terminal-font-size-context';
import { useTerminalFontWeight } from '@renderer/fonts/terminal-font-weight-context';
import { terminalFontWeightOptions } from '@renderer/terminal-font-weight-apply';
import type { TerminalWeights } from '@shared/terminal-font-weight';
import { stepTerminalFontSize } from '@shared/terminal-font-size';
import { buildFontFamilyStack } from '@renderer/fonts/font-family';
import { TERMINAL_FONT_FALLBACK, type FontFamilyPreference } from '@shared/font-settings';
import {
  createTerminalFontUpdater,
  createTerminalGeometrySynchronizer,
  type TerminalFontUpdater,
  type TerminalGeometrySynchronizer,
} from '@renderer/terminal-font-update';
const TERMINAL_FONT_READY_TIMEOUT_MS = 1500;

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
    black: readVar('--term-black', '#000000'),
    red: readVar('--term-red', '#cd0000'),
    green: readVar('--term-green', '#00cd00'),
    yellow: readVar('--term-yellow', '#cdcd00'),
    blue: readVar('--term-blue', '#0000ee'),
    magenta: readVar('--term-magenta', '#cd00cd'),
    cyan: readVar('--term-cyan', '#00cdcd'),
    white: readVar('--term-white', '#e5e5e5'),
    brightBlack: readVar('--term-bright-black', '#7f7f7f'),
    brightRed: readVar('--term-bright-red', '#ff0000'),
    brightGreen: readVar('--term-bright-green', '#00ff00'),
    brightYellow: readVar('--term-bright-yellow', '#ffff00'),
    brightBlue: readVar('--term-bright-blue', '#5c5cff'),
    brightMagenta: readVar('--term-bright-magenta', '#ff00ff'),
    brightCyan: readVar('--term-bright-cyan', '#00ffff'),
    brightWhite: readVar('--term-bright-white', '#ffffff'),
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
  const geometrySyncRef = useRef<TerminalGeometrySynchronizer | null>(null);
  const fontUpdaterRef = useRef<TerminalFontUpdater | null>(null);
  const appliedFontFamilyRef = useRef<FontFamilyPreference>(null);
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
  const { size: fontSize, ready: fontSizeReady, setSize: setFontSize } = useTerminalFontSize();
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const fontSizeReadyRef = useRef(fontSizeReady);
  fontSizeReadyRef.current = fontSizeReady;
  const { weight: fontWeight, boldWeight, ready: fontWeightReady } = useTerminalFontWeight();
  const fontWeightsRef = useRef<TerminalWeights>({ weight: fontWeight, boldWeight });
  fontWeightsRef.current = { weight: fontWeight, boldWeight };
  const fontWeightReadyRef = useRef(fontWeightReady);
  fontWeightReadyRef.current = fontWeightReady;
  const { terminalFontFamily } = useFontSettings();
  const terminalFontFamilyRef = useRef<FontFamilyPreference>(terminalFontFamily);
  terminalFontFamilyRef.current = terminalFontFamily;
  const [hover, setHover] = useState<HoverPreviewState | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // When the PTY exits (early launch failure, user ran `exit`, binary crashed)
  // we show a React-state overlay with the exit code + a Re-launch button. The
  // overlay lives outside the xterm buffer so a late-arriving snapshot that
  // calls term.reset() can't wipe it. `null` while running.
  const [exitInfo, setExitInfo] = useState<{ code: number | null } | null>(null);
  const [relaunching, setRelaunching] = useState(false);
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
      fontFamily: buildFontFamilyStack(terminalFontFamilyRef.current, TERMINAL_FONT_FALLBACK),
      fontSize: fontSizeRef.current,
      ...terminalFontWeightOptions(fontWeightsRef.current),
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

    const synchronizeGeometry = createTerminalGeometrySynchronizer({
      terminal: term,
      fit,
      dimensions: () => {
        const host = termHostRef.current;
        if (!opened || !host) return null;
        return { width: host.clientWidth, height: host.clientHeight };
      },
      resize: (cols, rows) => {
        void api.invoke('shells:resize', { projectId, shellIndex, cols, rows });
      },
    });
    geometrySyncRef.current = synchronizeGeometry;
    const fontUpdater = createTerminalFontUpdater({
      terminal: term,
      synchronize: synchronizeGeometry,
      loadFont: (specification, text) => document.fonts.load(specification, text),
      timeoutMs: TERMINAL_FONT_READY_TIMEOUT_MS,
    });
    fontUpdaterRef.current = fontUpdater;
    appliedFontFamilyRef.current = terminalFontFamilyRef.current;
    const initialFontUpdate = fontUpdater.apply(terminalFontFamilyRef.current);

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
      requestAnimationFrame(() => synchronizeGeometry());
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
      await initialFontUpdate;
      try { await document.fonts.ready; }
      catch { /* fine — best-effort */ }
      // Poll (via rAF) until the host has real dimensions and the shared
      // font size and weight have loaded, so we never open at the defaults. Bail after
      // ~2s so we don't hold up the terminal forever if a parent layout
      // is stuck; fallback opens against whatever's there.
      const startedAt = performance.now();
      while (!disposed) {
        const host = termHostRef.current;
        if (host && host.clientWidth >= 20 && host.clientHeight >= 20 && fontSizeReadyRef.current && fontWeightReadyRef.current) break;
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
      synchronizeGeometry();
      // Snapshot may already be back — write it into the correctly-sized
      // terminal. If not yet, the .then() below picks up.
      if (cachedSnapshot != null) writeSnapshotAndFlush();
      else void snapshotPromise.then(writeSnapshotAndFlush);
    }
    void openWhenReady();

    // Fit follow-ups catch flex parents that settle after our open, plus
    // any late-arriving font-metric changes. The ResizeObserver below
    // handles genuine size changes during the terminal's lifetime.
    // Passive syncs skip while a pane fold holds geometry; its release runs the one refit.
    const passiveSync = () => { if (!isTerminalGeometryHeld()) synchronizeGeometry(); };
    const offHoldRelease = onTerminalGeometryRelease(() => synchronizeGeometry());
    const late1 = window.setTimeout(passiveSync, 150);
    const late2 = window.setTimeout(passiveSync, 400);
    window.addEventListener('focus', passiveSync);

    const ro = new ResizeObserver(passiveSync);
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
    // Both appearance and palette changes must refresh existing terminals.
    const themeObserver = new MutationObserver(() => { term.options.theme = buildTheme(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette'] });

    return () => {
      fontUpdater.dispose();
      disposed = true;
      opened = false;
      window.clearTimeout(late1);
      window.clearTimeout(late2);
      window.removeEventListener('focus', passiveSync);
      offHoldRelease();
      ro.disconnect();
      media.removeEventListener('change', onScheme);
      themeObserver.disconnect();
      copyHost?.removeEventListener('copy', onCopy);
      linkProviderDisposable.dispose();
      focusReg.unregister();
      term.dispose();
      if (termRef.current === term) termRef.current = null;
      if (fontUpdaterRef.current === fontUpdater) fontUpdaterRef.current = null;
      if (geometrySyncRef.current === synchronizeGeometry) geometrySyncRef.current = null;
      searchRef.current = null;
    };
    // Font metric changes must not recreate the terminal. Dedicated effects below
    // apply font size, weight and family updates to the live instance instead.
  }, [projectId, shellIndex]);

  const findNext = useCallback((q: string) => {
    if (!q || !searchRef.current) return;
    searchRef.current.findNext(q, { caseSensitive: false, wholeWord: false, regex: false });
  }, []);
  const findPrev = useCallback((q: string) => {
    if (!q || !searchRef.current) return;
    searchRef.current.findPrevious(q, { caseSensitive: false, wholeWord: false, regex: false });
  }, []);

  // Push font-size changes into the running instance and immediately remeasure its geometry.
  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.fontSize = fontSize;
    geometrySyncRef.current?.({ forceResize: true });
  }, [fontSize]);

  // Weight changes repaint without remeasuring: xterm's cell size ignores weight, so the PTY keeps its geometry.
  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options = terminalFontWeightOptions({ weight: fontWeight, boldWeight });
  }, [fontWeight, boldWeight]);

  useEffect(() => {
    const updater = fontUpdaterRef.current;
    if (!updater || appliedFontFamilyRef.current === terminalFontFamily) return;
    appliedFontFamilyRef.current = terminalFontFamily;
    void updater.apply(terminalFontFamily);
  }, [terminalFontFamily]);

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
        setFontSize(stepTerminalFontSize(fontSize, 'in'));
      } else if (mod && e.key === '-') {
        e.preventDefault();
        setFontSize(stepTerminalFontSize(fontSize, 'out'));
      } else if (mod && e.key === '0') {
        e.preventDefault();
        setFontSize(stepTerminalFontSize(fontSize, 'reset'));
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [fontSize, setFontSize]);

  useShellStream(
    projectId,
    shellIndex,
    (data) => {
      // Any new data means we're alive again — clear a stale exit overlay.
      if (exitInfo) setExitInfo(null);
      if (snapshotReady.current) termRef.current?.write(data);
      else pendingLive.current += data;
    },
    (code) => {
      termRef.current?.write('\r\n[shell exited]\r\n');
      setExitInfo({ code });
    },
  );

  const relaunch = useCallback(async () => {
    if (relaunching) return;
    setRelaunching(true);
    try {
      await api.invoke('shells:launch', { projectId });
      setExitInfo(null);
    } catch (e) {
      toast('Re-launch failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    } finally {
      setRelaunching(false);
    }
  }, [projectId, relaunching]);

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
      {exitInfo && (
        <div className="absolute inset-x-0 bottom-3 flex items-center justify-center pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-3 bg-[--panel-strong] border border-[--border] rounded-md shadow-xl px-3 py-2 text-xs text-[--text]">
            <span className="font-medium">
              Shell exited{typeof exitInfo.code === 'number' ? ` (code ${exitInfo.code})` : ''}
            </span>
            <button
              onClick={relaunch}
              disabled={relaunching}
              className="pressable bg-[color:var(--accent)] text-[--accent-text] rounded-md px-2.5 py-1 font-medium hover:brightness-110 disabled:opacity-50 flex items-center gap-1.5"
              data-testid="shell-relaunch"
            >
              {relaunching && <span className="mp-spinner" aria-hidden />}
              <span>{relaunching ? 'Re-launching…' : 'Re-launch'}</span>
            </button>
            <button
              onClick={() => setExitInfo(null)}
              title="Dismiss"
              className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel]"
              data-testid="shell-exit-dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      )}
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
      <AnimatePresence>
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
          return <ContextMenu key="context-menu" x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />;
        })()}
      </AnimatePresence>
    </div>
  );
}
