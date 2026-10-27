import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal, type IDisposable, type ITheme, type ILinkProvider, type IBufferCellPosition } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { api } from '@renderer/api';
import { FROST_ATTR } from '@renderer/frosted-chrome-contract';
import { openRemoteShell, type RemoteShellHandle } from '@renderer/p2p/remoteShellBridge';
import { useShellStream } from '@renderer/hooks/useShellStream';
import { useTerminalDrop } from '@renderer/hooks/useTerminalDrop';
import { useTerminalPaste } from '@renderer/hooks/useTerminalPaste';
import { DROP_COPY } from '@shared/terminal-drop-contract';
import { terminalFocus } from '@renderer/hooks/useWindowTerminalFocus';
import { detectPaths } from '@shared/detect-paths';
import { sanitizeTerminalCopy } from '@shared/sanitize-terminal-copy';
import { HoverPreview, type HoverPreviewOpen, type HoverPreviewState } from './HoverPreview';
import { resolvePathClick } from '@renderer/peek-open';
import { createHoverHold } from '@renderer/hover-hold';
import { AnimatePresence } from 'motion/react';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { XIcon } from './shell-icons';
import { ICON_SIZE } from './icon-size';
import { isTerminalGeometryHeld, onTerminalGeometryRelease } from '@renderer/terminal-geometry-hold';
import { toast } from '@renderer/hooks/useToasts';
import { createTerminalKeyHandler, terminalTabAction } from '@renderer/terminal-keys';
import type { TerminalTabAction } from '@renderer/shortcut-contract';
import { SHORTCUT_COPY } from '@renderer/shortcut-copy';
import { useShortcutPlatform } from '@renderer/shortcut-platform';
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

const ZOOM_STEP: Readonly<Record<Exclude<TerminalTabAction, 'find'>, 'in' | 'out' | 'reset'>> = {
  'zoom-in': 'in',
  'zoom-out': 'out',
  'zoom-reset': 'reset',
};

export function ShellTab({
  projectId, shellIndex, onOpenFile, onOpenLaunchSettings, primary = false, popout = false, source = 'local',
}: {
  projectId: number;
  shellIndex: number;
  /** Opens a file from terminal output; a click on the preview card or on the printed path passes `projectId` only when the peek found the file in another project. */
  onOpenFile?: HoverPreviewOpen;
  /** Opens Settings → Launch commands so the user can fix a broken launch command. */
  onOpenLaunchSettings?: () => void;
  /** Left pane or popout terminal: the window-focus fallback when none was used yet. */
  primary?: boolean;
  /** Popout window: hover previews of another project's file cannot be opened from here. */
  popout?: boolean;
  /** `'local'` (default) drives the local PTY over IPC; `{ kind: 'remote' }` attaches to a shell on a paired device over P2P. */
  source?: 'local' | { kind: 'remote'; deviceId: string };
}) {
  const remoteDeviceId = typeof source === 'object' ? source.deviceId : null;
  const remoteRef = useRef<RemoteShellHandle | null>(null);
  // Live-data / exit handlers shared by the local pty stream and the remote bridge (assigned below).
  const streamHandlersRef = useRef<{ data: (d: string) => void; exit: (code: number | null) => void }>({ data: () => {}, exit: () => {} });
  const [reconnecting, setReconnecting] = useState(false);
  const platform = useShortcutPlatform();
  const platformRef = useRef(platform);
  platformRef.current = platform;
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
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // When the PTY exits (early launch failure, user ran `exit`, binary crashed)
  // we show a React-state overlay with the exit code + a Re-launch button. The
  // overlay lives outside the xterm buffer so a late-arriving snapshot that
  // calls term.reset() can't wipe it. `null` while running.
  const [exitInfo, setExitInfo] = useState<{ code: number | null } | null>(null);
  const [relaunching, setRelaunching] = useState(false);
  // Set when Claude CLI prints an API error that indicates the saved
  // session is corrupted (invalid thinking-block signature) — we offer a
  // one-click "Start fresh session" that re-launches without --continue.
  const [sessionCorrupted, setSessionCorrupted] = useState(false);
  // Show a "Starting…" overlay after 3 s of silence so the user knows the
  // process is alive but hasn't produced output yet (slow auth / large session).
  const [showStarting, setShowStarting] = useState(false);
  const startingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [startingProfileOpen, setStartingProfileOpen] = useState(false);
  const [startingProfiles, setStartingProfiles] = useState<{ name: string; scope: 'project' | 'global' }[]>([]);
  useEffect(() => {
    setShowStarting(false);
    setStartingProfileOpen(false);
    setSessionCorrupted(false);
    startingTimerRef.current = setTimeout(() => setShowStarting(true), 3000);
    return () => { if (startingTimerRef.current) clearTimeout(startingTimerRef.current); };
  }, [projectId, shellIndex]);
  // Fetch profiles when Starting overlay becomes visible so user can pick one.
  useEffect(() => {
    if (!showStarting || remoteDeviceId) return;
    api.invoke('shells:cli-profiles-list', { projectId })
      .then(({ profiles }) => setStartingProfiles(profiles.map((p: { name: string; scope: 'project' | 'global' }) => ({ name: p.name, scope: p.scope }))))
      .catch(() => {});
  }, [showStarting, projectId, remoteDeviceId]);
  const onOpenFileRef = useRef<typeof onOpenFile>(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const [hoverHold] = useState(() => createHoverHold(() => setHover(null)));
  useEffect(() => hoverHold.dispose, [hoverHold]);
  const openPeekedPathRef = useRef<(path: string, line: number | null) => Promise<void>>(async () => undefined);
  openPeekedPathRef.current = async (path, line) => {
    const req = await resolvePathClick(path, line, {
      currentProjectId: projectId,
      popout,
      peek: (relPath) => api.invoke('files:peek', { projectId, relPath }),
    });
    if (req) onOpenFileRef.current?.(req.relPath, req.line, req.projectId);
  };
  const primaryRef = useRef(primary);
  primaryRef.current = primary;
  const shellExitedRef = useRef(false);
  const pasteIntoTerminal = useCallback((text: string) => { termRef.current?.paste(text); }, []);
  const pasteFromText = useTerminalPaste(termHostRef, pasteIntoTerminal);
  const { overlay: dropOverlay, handlers: dropHandlers } = useTerminalDrop({
    paste: pasteIntoTerminal,
    isExited: () => shellExitedRef.current,
  });

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
    term.attachCustomKeyEventHandler(createTerminalKeyHandler({
      platform: platformRef.current,
      hasSelection: () => term.hasSelection(),
      getSelection: () => term.getSelection(),
      writeClipboard: (text) => navigator.clipboard.writeText(text),
      readClipboard: () => navigator.clipboard.readText(),
      paste: (text) => { void pasteFromText(text); },
      onClipboardError: (op, err) => {
        toast(SHORTCUT_COPY.clipboardErrorTitle(op), { kind: 'error', detail: String(err).replace(/^Error:\s*/, '') });
      },
    }));

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
            hoverHold.dispose();
            setHover(null);
            void openPeekedPathRef.current(h.path, h.line);
          },
          hover: (ev: MouseEvent) => {
            hoverHold.linkEnter();
            setHover({ x: ev.clientX, y: ev.clientY, projectId, path: h.path, line: h.line });
          },
          leave: hoverHold.linkLeave,
        })));
      },
    };
    // Remote shells have no local peek/preview (paths belong to the host's filesystem).
    const linkProviderDisposable: IDisposable = remoteDeviceId ? { dispose() {} } : term.registerLinkProvider(pathLinkProvider);

    // NOTE ordering: we deliberately do NOT term.open() yet. Opening the
    // terminal against a container whose fonts haven't loaded or whose CSS
    // hasn't laid out yet means xterm measures the wrong cell width, so
    // every subsequent write lands at a mis-computed column. That produced
    // the "text wraps into a vertical column on the right" bug. We wait
    // until document.fonts is ready AND the host has real pixel dimensions
    // BEFORE opening the terminal.
    const remote = remoteDeviceId ? openRemoteShell(remoteDeviceId, projectId, shellIndex) : null;
    remoteRef.current = remote;
    if (remote) {
      remote.onData((d) => { setReconnecting(false); streamHandlersRef.current.data(d); });
      remote.onExit((code) => streamHandlersRef.current.exit(code));
      remote.onClose((reason) => { if (reason === 'reconnecting') setReconnecting(true); });
    }
    term.onData((data) => {
      if (remote) remote.send(data);
      else void api.invoke('shells:write', { projectId, shellIndex, data });
    });
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
        if (remote) remote.resize(cols, rows);
        else void api.invoke('shells:resize', { projectId, shellIndex, cols, rows });
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
    // Remote: the hub replays scrollback as the first stream events, so there is no snapshot to fetch.
    const snapshotPromise = (remote ? Promise.resolve({ output: '' }) : api.invoke('shells:snapshot', { projectId, shellIndex }))
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
    // Appearance, palette and frosted-glass level changes (the level-scoped --term-fg) must refresh existing terminals.
    const themeObserver = new MutationObserver(() => { term.options.theme = buildTheme(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette', FROST_ATTR.platform, FROST_ATTR.chromeFrost, FROST_ATTR.terminalFrost] });

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
      remote?.close();
      if (remoteRef.current === remote) remoteRef.current = null;
      term.dispose();
      if (termRef.current === term) termRef.current = null;
      if (fontUpdaterRef.current === fontUpdater) fontUpdaterRef.current = null;
      if (geometrySyncRef.current === synchronizeGeometry) geometrySyncRef.current = null;
      searchRef.current = null;
    };
    // Font metric changes must not recreate the terminal. Dedicated effects below
    // apply font size, weight and family updates to the live instance instead.
  }, [projectId, shellIndex, remoteDeviceId, pasteFromText, hoverHold]);

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

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const onKey = (e: KeyboardEvent) => {
      const action = terminalTabAction(e, platform);
      if (!action) return;
      e.preventDefault();
      if (action === 'find') {
        setSearchOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
      } else {
        setFontSize(stepTerminalFontSize(fontSize, ZOOM_STEP[action]));
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [fontSize, setFontSize, platform]);

  streamHandlersRef.current = {
    data: (data) => {
      // Any new data means we're alive again — clear stale overlays.
      shellExitedRef.current = false;
      if (exitInfo) setExitInfo(null);
      if (startingTimerRef.current) { clearTimeout(startingTimerRef.current); startingTimerRef.current = null; }
      setShowStarting(false);
      // Detect corrupted-session API error so we can offer a fresh-start overlay.
      if (!sessionCorrupted && /Invalid [`']?signature[`']? in [`']?thinking[`']? block/i.test(data)) {
        setSessionCorrupted(true);
      }
      if (snapshotReady.current) termRef.current?.write(data);
      else pendingLive.current += data;
    },
    exit: (code) => {
      shellExitedRef.current = true;
      termRef.current?.write('\r\n[shell exited]\r\n');
      setExitInfo({ code });
    },
  };
  useShellStream(
    remoteDeviceId ? null : projectId,
    shellIndex,
    (d) => streamHandlersRef.current.data(d),
    (c) => streamHandlersRef.current.exit(c),
  );

  // After an exit we always restart with the "first" launch parameters —
  // whatever broke the previous session (bad --continue, corrupt state, auth
  // drift) is most reliably avoided by a clean start.
  const relaunch = useCallback(async () => {
    if (relaunching) return;
    setRelaunching(true);
    try {
      await api.invoke('shells:launch', { projectId, forceFirst: true });
      setExitInfo(null);
    } catch (e) {
      toast('Re-launch failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    } finally {
      setRelaunching(false);
    }
  }, [projectId, relaunching]);

  // Kill the current shell and re-launch bypassing --continue so a corrupted
  // Claude session is left behind and a brand-new one is started.
  const startFreshSession = useCallback(async () => {
    if (relaunching) return;
    setRelaunching(true);
    setSessionCorrupted(false);
    try {
      try { await api.invoke('shells:kill', { projectId, shellIndex }); } catch { /* fine */ }
      await api.invoke('shells:launch', { projectId, forceFirst: true });
    } catch (e) {
      toast('Fresh session failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    } finally {
      setRelaunching(false);
    }
  }, [projectId, shellIndex, relaunching]);

  // Strip bad thinking blocks from the saved Claude session so --continue
  // works again. Backs up the original. Keeps user/assistant text + tool
  // messages — only loses the model's internal reasoning blocks.
  const repairSession = useCallback(async () => {
    if (relaunching) return;
    setRelaunching(true);
    try {
      try { await api.invoke('shells:kill', { projectId, shellIndex }); } catch { /* fine */ }
      const result = await api.invoke('claude:repair-session', { projectId });
      if (result.repaired === 0) {
        toast('Nothing to repair', { kind: 'warning', detail: (result as { reason?: string }).reason });
      } else {
        toast('Session repaired', { kind: 'success', detail: `Stripped ${result.blocksStripped} thinking block${result.blocksStripped === 1 ? '' : 's'}. Original backed up.` });
      }
      setSessionCorrupted(false);
      await api.invoke('shells:launch', { projectId });
    } catch (e) {
      toast('Repair failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    } finally {
      setRelaunching(false);
    }
  }, [projectId, shellIndex, relaunching]);

  // Kill the currently running (but stuck) shell then re-launch it, optionally with a specific profile.
  // The default-path relaunch forces the "first" variant: if the shell is stuck
  // it's almost always because --continue picked up a bad session, so starting
  // clean is the recovery that works.
  const killAndRelaunch = useCallback(async (profileName?: string) => {
    if (relaunching) return;
    setRelaunching(true);
    setShowStarting(false);
    setStartingProfileOpen(false);
    try {
      try { await api.invoke('shells:kill', { projectId, shellIndex }); } catch { /* fine — may already be dead */ }
      if (profileName) {
        await api.invoke('shells:launch-cli', { projectId, profileName, argv: [], env: {}, save: false });
      } else {
        await api.invoke('shells:launch', { projectId, forceFirst: true });
      }
    } catch (e) {
      toast('Re-launch failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    } finally {
      setRelaunching(false);
    }
  }, [projectId, shellIndex, relaunching]);

  // Outer div = padding + background. Inner div = pure terminal viewport,
  // so xterm's own geometry math sees an element with no padding or extra chrome.
  return (
    <div
      ref={containerRef}
      data-testid="shell-tab"
      tabIndex={-1}
      {...dropHandlers}
      onContextMenu={(e) => {
        // Only intercept when the click is inside the terminal viewport.
        // Anything else (search bar, drop overlay) uses default browser menu.
        if (!(e.target as HTMLElement).closest('.xterm')) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      className="relative w-full h-full min-h-0 px-3 pt-2 pb-3 bg-transparent focus:outline-none"
    >
      {/* `isolate` keeps xterm's internal z-indexes (e.g. its link layer) inside the
          host, so the exit overlay, drop hint and search bar always paint above it. */}
      <div ref={termHostRef} className="w-full h-full isolate" />
      {!remoteDeviceId && sessionCorrupted && (
        <div className="absolute inset-x-0 top-3 flex items-center justify-center pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-3 bg-[--danger]/15 border border-[--danger]/40 rounded-md shadow-xl px-3 py-2 text-xs text-[--text] max-w-[720px]">
            <span className="font-medium text-[--danger]">Claude session corrupted</span>
            <span className="text-[--text-muted]">(API rejected a saved thinking block)</span>
            <button
              onClick={repairSession}
              disabled={relaunching}
              className="pressable bg-[color:var(--accent)] text-[--accent-text] rounded-md px-2.5 py-1 font-medium hover:brightness-110 disabled:opacity-50 flex items-center gap-1.5"
              title="Strip bad thinking blocks and resume the session"
            >
              {relaunching && <span className="mp-spinner" aria-hidden />}
              <span>Repair session</span>
            </button>
            <button
              onClick={startFreshSession}
              disabled={relaunching}
              className="pressable border border-[--border] rounded-md px-2.5 py-1 font-medium hover:bg-[--surface-hover] disabled:opacity-50"
              title="Discard the saved session and start a brand-new one"
            >
              Start fresh
            </button>
            <button
              onClick={() => setSessionCorrupted(false)}
              title="Dismiss"
              className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel]"
            >
              ✕
            </button>
          </div>
        </div>
      )}
      {!remoteDeviceId && showStarting && !exitInfo && (
        <div className="absolute inset-x-0 bottom-3 flex flex-col items-center gap-1 pointer-events-none">
          {startingProfileOpen && startingProfiles.length > 0 && (
            <div className="pointer-events-auto bg-[--panel-strong] border border-[--border] rounded-md shadow-xl text-xs text-[--text] overflow-hidden min-w-[200px]">
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-[--text-muted] font-semibold border-b border-[--border]">Launch with…</div>
              {startingProfiles.map((p) => (
                <button
                  key={p.name}
                  onClick={() => void killAndRelaunch(p.name)}
                  className="w-full text-left px-3 py-1.5 hover:bg-[--surface-hover] flex items-center gap-2"
                >
                  <span className="font-medium truncate">{p.name}</span>
                  <span className="text-[--text-muted] text-[10px] ml-auto">{p.scope}</span>
                </button>
              ))}
              <div className="border-t border-[--border]">
                <button
                  onClick={() => void killAndRelaunch()}
                  className="w-full text-left px-3 py-1.5 hover:bg-[--surface-hover] text-[--text-muted]"
                >
                  Default launch command
                </button>
              </div>
            </div>
          )}
          <div className="pointer-events-auto flex items-center gap-3 bg-[--panel-strong] border border-[--border] rounded-md shadow-xl px-3 py-2 text-xs text-[--text]">
            <span className="mp-spinner" aria-hidden />
            <span className="text-[--text-muted]">Starting Claude…</span>
            <button
              onClick={() => startingProfiles.length > 0 ? setStartingProfileOpen((v) => !v) : void killAndRelaunch()}
              disabled={relaunching}
              className="pressable bg-[color:var(--accent)] text-[--accent-text] rounded-md px-2.5 py-1 font-medium hover:brightness-110 disabled:opacity-50 flex items-center gap-1.5"
            >
              {relaunching && <span className="mp-spinner" aria-hidden />}
              <span>{relaunching ? 'Re-launching…' : startingProfiles.length > 0 ? 'Re-launch ▾' : 'Re-launch'}</span>
            </button>
            {onOpenLaunchSettings && (
              <button
                onClick={onOpenLaunchSettings}
                className="pressable border border-[--border] rounded-md px-2.5 py-1 font-medium hover:bg-[--surface-hover]"
                title="Open Settings → Launch commands"
              >
                Fix launch command
              </button>
            )}
          </div>
        </div>
      )}
      {reconnecting && (
        <div data-testid="shell-reconnecting" className="absolute inset-x-0 bottom-3 flex items-center justify-center pointer-events-none">
          <div className="flex items-center gap-2 bg-[--panel-strong] border border-[--border] rounded-md shadow-xl px-3 py-2 text-xs text-[--text]">
            <span className="mp-spinner" aria-hidden />
            <span className="font-medium">Reconnecting…</span>
          </div>
        </div>
      )}
      {exitInfo && (
        <div className="absolute inset-x-0 bottom-3 flex items-center justify-center pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-3 bg-[--panel-strong] border border-[--border] rounded-md shadow-xl px-3 py-2 text-xs text-[--text]">
            <span className="font-medium">
              Shell exited{typeof exitInfo.code === 'number' ? ` (code ${exitInfo.code})` : ''}
            </span>
            {!remoteDeviceId && <button
              onClick={relaunch}
              disabled={relaunching}
              className="pressable bg-[color:var(--accent)] text-[--accent-text] rounded-md px-2.5 py-1 font-medium hover:brightness-110 disabled:opacity-50 flex items-center gap-1.5"
              data-testid="shell-relaunch"
            >
              {relaunching && <span className="mp-spinner" aria-hidden />}
              <span>{relaunching ? 'Re-launching…' : 'Re-launch'}</span>
            </button>}
            {!remoteDeviceId && onOpenLaunchSettings && (
              <button
                onClick={onOpenLaunchSettings}
                className="pressable border border-[--border] rounded-md px-2.5 py-1 font-medium hover:bg-[--surface-hover] flex items-center gap-1.5"
                data-testid="shell-fix-launch"
                title="Open Settings → Launch commands to fix the startup command"
              >
                Fix launch command
              </button>
            )}
            <button
              onClick={() => setExitInfo(null)}
              title="Dismiss"
              className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel]"
              data-testid="shell-exit-dismiss"
            >
              <XIcon size={ICON_SIZE.sm} />
            </button>
          </div>
        </div>
      )}
      {dropOverlay && (
        <div className="absolute inset-2 pointer-events-none rounded-md border-2 border-dashed border-[color:var(--accent-mark,var(--accent))] bg-[color:var(--accent)]/10 flex items-center justify-center text-xs text-[--text] font-medium">
          {dropOverlay === 'path' ? DROP_COPY.overlayPath : DROP_COPY.overlayText}
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
          <button onClick={() => findPrev(searchQuery)} title={SHORTCUT_COPY.searchPrevTitle(platform)} className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel]">↑</button>
          <button onClick={() => findNext(searchQuery)} title={SHORTCUT_COPY.searchNextTitle(platform)} className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel]">↓</button>
          <button
            onClick={() => { setSearchOpen(false); setSearchQuery(''); searchRef.current?.clearDecorations(); termRef.current?.focus(); }}
            title="Close (Esc)"
            className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel]"
          >
            <XIcon size={ICON_SIZE.sm} />
          </button>
        </div>
      )}
      <HoverPreview
        state={hover}
        popout={popout}
        hold={hoverHold}
        onOpen={(relPath, line, targetProjectId) => { hoverHold.dispose(); setHover(null); onOpenFileRef.current?.(relPath, line, targetProjectId); }}
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
                  await pasteFromText(await navigator.clipboard.readText());
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
