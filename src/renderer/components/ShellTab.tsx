import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Terminal, type IBufferCellPosition, type IDisposable, type ITheme, type ILinkProvider } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { api } from '@renderer/api';
import { openSafeHyperlink } from '@renderer/terminal-hyperlinks';
import { FROST_ATTR } from '@renderer/frosted-chrome-contract';
import type { RemoteShellHandle } from '@renderer/p2p/remoteShellBridge';
import { openTerminalViewSource } from '@renderer/terminal/terminal-view-source';
import { readTerminalEngine } from '@renderer/terminal/terminal-engine-setting';
import { useTerminalPadding } from '@renderer/terminal/terminal-padding-context';
import { openGhosttyWithStandby } from '@renderer/terminal/engine-composition';
import type { GhosttyView, TerminalViewSurface } from '@renderer/terminal/ghostty-view-engine';
import type { TerminalFileLink } from '@renderer/terminal/terminal-view-links';
import { useTerminalDrop } from '@renderer/hooks/useTerminalDrop';
import { useTerminalPaste } from '@renderer/hooks/useTerminalPaste';
import { dropOverlayLabel } from '@renderer/remote-upload/remote-drop';
import { uploadClient } from '@renderer/remote-upload/upload-client';
import { useUploadProgress, type RemoteTarget } from '@renderer/remote-upload/useUploadProgress';
import { UploadProgressOverlay } from './UploadProgressOverlay';
import { terminalFocus } from '@renderer/hooks/useWindowTerminalFocus';
import { terminalFocusKey } from '@renderer/terminal-focus';
import { detectPaths, detectBareFilenames } from '@shared/detect-paths';
import { sanitizeTerminalCopy } from '@shared/sanitize-terminal-copy';
import { HoverPreview, type HoverPreviewOpen, type HoverPreviewState } from './HoverPreview';
import { resolvePathClick } from '@renderer/peek-open';
import { createHoverHold } from '@renderer/hover-hold';
import { AnimatePresence } from 'motion/react';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { XIcon } from './shell-icons';
import { Tooltip } from './Tooltip';
import { ICON_SIZE } from './icon-size';
import { isTerminalGeometryHeld, onTerminalGeometryRelease } from '@renderer/terminal-geometry-hold';
import { toast } from '@renderer/hooks/useToasts';
import { createTerminalKeyHandler, terminalTabAction } from '@renderer/terminal-keys';
import type { TerminalTabAction } from '@renderer/shortcut-contract';
import { SHORTCUT_COPY, REMOTE_INPUT_COPY } from '@renderer/shortcut-copy';
import { registerClipboardOsc } from '@renderer/osc52';
import { createCopyFailedToast, subscribeRemoteInputToasts } from '@renderer/remote-toasts';
import { useShortcutPlatform } from '@renderer/shortcut-platform';
import { useFontSettings } from '@renderer/fonts/font-settings-context';
import { useTerminalFontSize } from '@renderer/fonts/terminal-font-size-context';
import { useTerminalFontWeight } from '@renderer/fonts/terminal-font-weight-context';
import { terminalFontWeightOptions } from '@renderer/terminal-font-weight-apply';
import type { TerminalWeights } from '@shared/terminal-font-weight';
import { stepTerminalFontSize } from '@shared/terminal-font-size';
import { buildFontFamilyStack } from '@renderer/fonts/font-family';
import { TERMINAL_FONT_FALLBACK, type FontFamilyPreference } from '@shared/font-settings';
import { TERMINAL_SCROLLBACK_LINES } from '@shared/terminal-scrollback';
import { DEFAULT_TERMINAL_PADDING } from '@shared/terminal-padding';
import { watchTerminalBackdrop } from '@renderer/terminal/terminal-backdrop';
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

function openTerminalWebLink(url: string): void {
  void api.invoke('app:open-external', { url }).catch(() => toast('Could not open terminal link', { kind: 'error' }));
}

type StreamHandlers = { data: (d: string) => void; exit: (code: number | null) => void };

interface RemoteShellWiring {
  readonly handlers: MutableRefObject<StreamHandlers>;
  readonly setReconnecting: (on: boolean) => void;
  readonly hostName: () => string;
  readonly cancelUploads: () => void;
}

/** Wires a remote shell's stream, reconnect flag and input-error toasts; exit or close cancels uploads (AC-D8). */
function wireRemoteShell(remote: RemoteShellHandle, wiring: RemoteShellWiring): void {
  remote.onData((d) => { wiring.setReconnecting(false); wiring.handlers.current.data(d); });
  remote.onExit((code) => { wiring.cancelUploads(); wiring.handlers.current.exit(code); });
  remote.onClose((reason) => {
    wiring.cancelUploads();
    if (reason === 'reconnecting') wiring.setReconnecting(true);
  });
  subscribeRemoteInputToasts(remote, wiring.hostName);
}

/** The remote upload target for a remote tab, or undefined for a local one; the same object while its inputs hold. */
function useRemoteTarget(deviceId: string | null, hostName: string, uploads: RemoteTarget['uploads']): RemoteTarget | undefined {
  const ref = useRef<RemoteTarget | undefined>(undefined);
  const held = ref.current;
  if (!deviceId) ref.current = undefined;
  else if (held?.deviceId !== deviceId || held.hostName !== hostName || held.uploads !== uploads) ref.current = { deviceId, hostName, uploads };
  return ref.current;
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
  source?: 'local' | { kind: 'remote'; deviceId: string; deviceName?: string };
}) {
  const remoteDeviceId = typeof source === 'object' ? source.deviceId : null;
  const padding = useTerminalPadding();
  const horizontalPadding = (remoteDeviceId === null ? padding.horizontal : null) ?? DEFAULT_TERMINAL_PADDING.sides;
  const verticalPadding = remoteDeviceId === null ? padding.vertical : null;
  const remoteHostNameRef = useRef<string>(REMOTE_INPUT_COPY.hostFallback);
  remoteHostNameRef.current = (typeof source === 'object' && source.deviceName) || REMOTE_INPUT_COPY.hostFallback;
  // Live-data / exit handlers shared by the local pty stream and the remote bridge (assigned below).
  const streamHandlersRef = useRef<StreamHandlers>({ data: () => {}, exit: () => {} });
  const [reconnecting, setReconnecting] = useState(false);
  const platform = useShortcutPlatform();
  const platformRef = useRef(platform);
  platformRef.current = platform;
  const containerRef = useRef<HTMLDivElement>(null);
  // Whether a full-screen app (opencode, vim, …) shows the alternate screen; entering or
  // leaving it refits, so the terminal reclaims the scrollbar strip only while nothing scrolls.
  const [altScreen, setAltScreen] = useState(false);
  const termHostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const activeSurfaceRef = useRef<TerminalViewSurface | null>(null);
  const outputRef = useRef<((data: string) => void) | null>(null);
  const ghosttyRef = useRef<GhosttyView | null>(null);
  const [engineStatus, setEngineStatus] = useState<'xterm' | 'loading' | 'ghostty' | 'recovering' | 'fallback' | 'failed'>('xterm');
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const geometrySyncRef = useRef<TerminalGeometrySynchronizer | null>(null);
  const fontUpdaterRef = useRef<TerminalFontUpdater | null>(null);
  const appliedFontFamilyRef = useRef<FontFamilyPreference>(null);
  const snapshotReady = useRef(false);
  const replayDrained = useRef(false);
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
  const pasteIntoTerminal = useCallback((text: string) => { activeSurfaceRef.current?.paste(text); }, []);
  const uploads = useUploadProgress(uploadClient());
  const remoteTarget = useRemoteTarget(remoteDeviceId, remoteHostNameRef.current, uploads.tracker);
  const pasteFromText = useTerminalPaste(termHostRef, pasteIntoTerminal, remoteTarget);
  const { overlay: dropOverlay, handlers: dropHandlers } = useTerminalDrop({
    paste: pasteIntoTerminal,
    isExited: () => shellExitedRef.current,
    remote: remoteTarget,
  });

  useEffect(() => {
    const terminalHost = termHostRef.current;
    const pane = containerRef.current;
    if (!terminalHost || !pane) return;
    const paintBackdrop = (color: string | undefined) => {
      pane.style.backgroundColor = color ?? '';
      pane.toggleAttribute('data-terminal-backdrop', color !== undefined);
    };
    let backdrop: IDisposable | undefined;
    const opening = new AbortController();
    let optionalView: ReturnType<typeof openGhosttyWithStandby> | undefined;
    let ghostHost: HTMLDivElement | undefined;
    let optionalEngine = false;
    setEngineStatus('xterm');
    terminalHost.style.visibility = 'hidden';
    const term = new Terminal({
      // OSC-8 hyperlinks (ESC ] 8 ; ; URL BEL text ESC ] 8 ; ; BEL) render
      // as styled text out of the box, but clicks only dispatch when a
      // linkHandler is set. Routes through the same scheme-guarded helper
      // + app:open-external path as plain-text URLs.
      linkHandler: {
        activate: (_ev, text) => {
          void openSafeHyperlink(text, {
            invokeOpenExternal: (url) => api.invoke('app:open-external', { url }),
            invokeResolveLocal: (url) => api.invoke('app:resolve-local-file', { url }),
            openInIde: (projectId, relPath) => {
              // Broadcast to App.tsx, which owns the route switch and
              // openInFiles state. CustomEvent avoids threading a callback
              // through every shell host.
              window.dispatchEvent(new CustomEvent('metaide:open-in-files', { detail: { projectId, relPath } }));
            },
          });
        },
      },
      macOptionClickForcesSelection: true,
      scrollback: TERMINAL_SCROLLBACK_LINES,
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
      // Right-click selects the word under the cursor (and then the custom
      // context menu offers Copy with it already selected).
      rightClickSelectsWord: true,
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
    // Plain-text URL clicks route through the same scheme-guarded helper as OSC-8.
    term.loadAddon(new WebLinksAddon((_ev: MouseEvent, url: string) => {
      void openSafeHyperlink(url, {
        invokeOpenExternal: (u) => api.invoke('app:open-external', { url: u }),
        invokeResolveLocal: (u) => api.invoke('app:resolve-local-file', { url: u }),
        openInIde: (projectId, relPath) => {
          window.dispatchEvent(new CustomEvent('metaide:open-in-files', { detail: { projectId, relPath } }));
        },
      });
    }));
    // Clipboard writes from remote shells via OSC 52 (Frits #71).
    const clipboard = {
      writeText: (text) => navigator.clipboard.writeText(text),
      onError: createCopyFailedToast(),
    } satisfies Parameters<typeof registerClipboardOsc>[1];
    let oscDisposable: IDisposable | undefined;
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;
    const keys = createTerminalKeyHandler({
      platform: platformRef.current,
      hasSelection: () => activeSurfaceRef.current?.hasSelection() ?? false,
      getSelection: () => activeSurfaceRef.current?.getSelection() ?? '',
      writeClipboard: (text) => navigator.clipboard.writeText(text),
      readClipboard: () => navigator.clipboard.readText(),
      paste: (text) => { void pasteFromText(text); },
      onClipboardError: (op, err) => {
        toast(SHORTCUT_COPY.clipboardErrorTitle(op), { kind: 'error', detail: String(err).replace(/^Error:\s*/, '') });
      },
    });
    term.attachCustomKeyEventHandler(keys);

    // File-path link provider: matches things like src/main/index.ts:42
    // in terminal output, shows a hover preview, click opens in Files.
    //
    // Two detectors feed this provider:
    //   - detectPaths()         strict, path-like matches (slashes required).
    //                           Lit synchronously — the slash is a strong
    //                           enough signal that false positives are rare.
    //   - detectBareFilenames() loose, name.ext with no path prefix. Used
    //                           to catch what Codex / other TUIs print
    //                           ("Viewed image review.jpg"). English prose
    //                           looks identical to a reference, so every
    //                           bare hit is verified against files:peek
    //                           before it lights up; unresolvable words
    //                           never appear as links.
    //
    // The verification turns `provideLinks` into an async operation. xterm
    // accepts a delayed callback — it's documented to allow one-shot
    // callbacks whenever the provider is ready — so the strict hits are
    // included in the same callback as the verified bare hits, after the
    // short peek round-trip. Lines with only strict hits incur no latency
    // (Promise.all([]) resolves on the next microtask).
    //
    // The sync `pathLinks` helper below only runs the strict detector — Ghostty's
    // reveal() calls it synchronously for its own hover/click rendering, and
    // doing a files:peek round-trip from inside reveal would stall the first paint.
    // The bare-filename detector is only wired through the xterm `pathLinkProvider`.
    function pathLinks(text: string): TerminalFileLink[] {
      return detectPaths(text).map((h) => ({
        start: h.startIndex,
        end: h.endIndex,
        text: h.raw,
        activate: () => {
          hoverHold.dispose();
          setHover(null);
          void openPeekedPathRef.current(h.path, h.line);
        },
        hover: (ev: MouseEvent) => {
          hoverHold.linkEnter(() => setHover({ x: ev.clientX, y: ev.clientY, projectId, path: h.path, line: h.line }));
        },
        leave: hoverHold.linkLeave,
      }));
    }
    const pathLinkProvider: ILinkProvider = {
      provideLinks(bufferLineNumber, callback) {
        const rawLine = term.buffer.active.getLine(bufferLineNumber - 1);
        if (!rawLine) { callback(undefined); return; }
        const text = rawLine.translateToString(true);
        const strictHits = detectPaths(text);
        // Drop any bare hit whose range overlaps a strict hit — the
        // strict path owns that match and already has better context.
        const bareHits = detectBareFilenames(text).filter((b) =>
          !strictHits.some((s) => b.startIndex >= s.startIndex && b.endIndex <= s.endIndex),
        );
        if (strictHits.length === 0 && bareHits.length === 0) { callback(undefined); return; }

        const toLink = (h: typeof strictHits[number]) => ({
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
            // Dwell: the card opens only after the pointer rests on the
            // path, so sweeping the mouse across output never pops a card
            // over text the user is about to select.
            hoverHold.linkEnter(() => setHover({ x: ev.clientX, y: ev.clientY, projectId, path: h.path, line: h.line }));
          },
          leave: hoverHold.linkLeave,
        });

        void (async () => {
          // Verify bare hits in parallel. `files:peek` returns
          // `found: false` for anything not in the project, so prose like
          // "the readme.md file" doesn't light up unless a real
          // `readme.md` exists at the project root. `maxLines: 1` keeps
          // the IPC payload tiny — we only need the `found` flag.
          const verified = await Promise.all(bareHits.map(async (h) => {
            try {
              const res = await api.invoke('files:peek', { projectId, relPath: h.path, maxLines: 1 });
              return res.found ? h : null;
            } catch { return null; }
          }));
          const allHits = [
            ...strictHits,
            ...verified.filter((h): h is NonNullable<typeof h> => h !== null),
          ];
          if (allHits.length === 0) { callback(undefined); return; }
          callback(allHits.map(toLink));
        })();
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
    snapshotReady.current = false;
    replayDrained.current = false;
    pendingLive.current = '';
    termRef.current = term;
    outputRef.current = data => term.write(data);
    const viewSource = openTerminalViewSource({
      target: { projectId, shellIndex },
      remoteDeviceId,
      remoteHandlers: (remote) => wireRemoteShell(remote, { handlers: streamHandlersRef, setReconnecting, hostName: () => remoteHostNameRef.current, cancelUploads: uploads.tracker.cancel }),
      data: (data) => streamHandlersRef.current.data(data),
      exit: (code) => streamHandlersRef.current.exit(code),
    });
    function enableXtermClipboard() {
      if (!opening.signal.aborted) oscDisposable = registerClipboardOsc(term, clipboard);
    }
    const engine = readTerminalEngine(opening.signal).then(selected => {
      if (!opening.signal.aborted && selected === 'xterm') {
        activeSurfaceRef.current = term;
        term.onData(viewSource.send);
        enableXtermClipboard();
      }
      return selected;
    });
    let opened = false;
    let disposed = false;
    const focusReg = terminalFocus.register({
      key: terminalFocusKey(projectId, shellIndex, remoteDeviceId),
      primary: primaryRef.current,
      isOpen: () => snapshotReady.current,
      focus: () => activeSurfaceRef.current?.focus(),
    });

    const syncXtermGeometry = createTerminalGeometrySynchronizer({
      terminal: term,
      fit,
      dimensions: () => {
        const host = termHostRef.current;
        if (!opened || !host) return null;
        return { width: host.clientWidth, height: host.clientHeight };
      },
      resize: (cols, rows) => { if (!optionalEngine) viewSource.resize(cols, rows); },
      fullWidthCols: () => {
        if (term.buffer.active.type !== 'alternate') return null;
        const host = termHostRef.current;
        const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
        // The screen is exactly cols × cell width, so it yields the cell width.
        const cellWidth = screen && term.cols > 0 ? screen.getBoundingClientRect().width / term.cols : 0;
        return host && cellWidth > 0 ? Math.floor(host.clientWidth / cellWidth) : null;
      },
    });
    const synchronizeGeometry: TerminalGeometrySynchronizer = (options) => {
      if (optionalEngine) optionalView?.fit();
      else syncXtermGeometry(options);
    };
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
    let cachedSnapshot: string | null = null;
    const snapshotPromise = viewSource.snapshot
      .then((output) => {
        cachedSnapshot = output;
        // Existing output means the process already started — an idle Claude
        // prompt emits nothing, so don't wait for live data to drop the overlay.
        if (output && !disposed) {
          if (startingTimerRef.current) { clearTimeout(startingTimerRef.current); startingTimerRef.current = null; }
          setShowStarting(false);
        }
      });

    function writeSnapshotAndFlush() {
      if (termRef.current !== term || disposed) return;
      if (optionalEngine) { startGhosttyView(); return; }
      const output = cachedSnapshot ?? '';
      if (output) term.reset();

      const settleReplay = () => {
        if (termRef.current !== term || disposed) return;
        term.scrollToBottom();
        // xterm synchronizes the DOM scroll area in a later animation frame.
        // Keep the host hidden until that scroll area and scrollTop agree with
        // the parsed buffer, so no intermediate viewport can be painted.
        const revealWhenSettled = () => {
          if (termRef.current !== term || disposed) return;
          const host = termHostRef.current;
          const viewport = host?.querySelector<HTMLElement>('.xterm-viewport');
          const maximum = viewport ? viewport.scrollHeight - viewport.clientHeight : 0;
          if (!host || !viewport || viewport.clientHeight === 0 ||
            (term.buffer.active.baseY > 0 && (maximum <= 0 || viewport.scrollTop < maximum - 1))) {
            requestAnimationFrame(revealWhenSettled);
            return;
          }
          snapshotReady.current = true;
          backdrop = watchTerminalBackdrop(term, paintBackdrop);
          host.style.visibility = '';
          focusReg.opened();
          requestAnimationFrame(() => synchronizeGeometry());
        };
        requestAnimationFrame(revealWhenSettled);
      };
      const finishReplay = () => {
        if (termRef.current !== term || disposed) return;
        const live = pendingLive.current;
        pendingLive.current = '';
        replayDrained.current = true;
        if (live) term.write(live, settleReplay);
        else settleReplay();
      };

      const live = pendingLive.current;
      pendingLive.current = '';
      if (output && live) {
        term.write(output);
        term.write(live, finishReplay);
      } else if (output || live) {
        term.write(output || live, finishReplay);
      } else {
        finishReplay();
      }
    }

    function startGhosttyView() {
      const host = termHostRef.current;
      if (!host) return;
      const candidateHost = document.createElement('div');
      candidateHost.className = 'absolute inset-0';
      candidateHost.inert = true;
      host.append(candidateHost);
      ghostHost = candidateHost;
      const standbyElement = term.element;
      if (standbyElement) standbyElement.inert = true;
      activeSurfaceRef.current = null;
      const show = (surface: TerminalViewSurface) => {
        activeSurfaceRef.current = surface;
        snapshotReady.current = true;
        host.style.visibility = '';
      };
      optionalView = openGhosttyWithStandby({
        host: candidateHost,
        standby: term,
        standbyAvailable: () => opened,
        snapshot: cachedSnapshot ?? '',
        enableClipboard: enableXtermClipboard,
        send: viewSource.send,
        canRefit: () => !isTerminalGeometryHeld(),
        alignGrid(cols, rows) {
          if (opened && (term.cols !== cols || term.rows !== rows)) term.resize(cols, rows);
          viewSource.resize(cols, rows);
        },
        appearance: () => ({
          theme: buildTheme(), fontFamily: term.options.fontFamily,
          fontSize: term.options.fontSize, fontWeight: term.options.fontWeight, fontWeightBold: term.options.fontWeightBold,
          cursorBlink: true, cursorStyle: 'bar', lineHeight: 1.25, letterSpacing: 0,
        }),
        enableXterm(restoreFocus) {
          term.onData(viewSource.send);
          candidateHost.remove();
          if (standbyElement) { standbyElement.style.visibility = ''; standbyElement.inert = false; }
          optionalEngine = false;
          backdrop = watchTerminalBackdrop(term, paintBackdrop);
          syncXtermGeometry({ forceResize: true });
          term.scrollToBottom();
          show(term);
          focusReg.opened(restoreFocus);
        },
        onState(state, candidate) {
          setEngineStatus(state.kind === 'xterm' ? 'fallback' : state.kind);
          ghosttyRef.current = candidate ?? null;
          if (candidate) {
            candidate.reveal({ platform: platformRef.current, keys, pathLinks: remoteDeviceId ? undefined : pathLinks,
              openWebLink: openTerminalWebLink, focused: focusReg.used, paintBackdrop });
            if (standbyElement) standbyElement.style.visibility = 'hidden';
            candidateHost.inert = false;
            show(candidate.surface);
            focusReg.opened();
          } else if (state.kind === 'recovering' || state.kind === 'failed') {
            activeSurfaceRef.current = null;
            snapshotReady.current = false;
          }
        },
      });
      outputRef.current = optionalView.write;
      // Snapshot and its buffered successor enter both engines before any new live output.
      const live = pendingLive.current;
      pendingLive.current = '';
      if (live) optionalView.write(live);
      replayDrained.current = true;
    }

    /**
     * The actual open sequence: wait for fonts + a laid-out container,
     * THEN term.open, fit, and write the snapshot. This is the fix for
     * "text wraps into a vertical stripe on the right" — that only
     * happened when open+write ran before the container had real width,
     * because xterm computed a bogus cell size and every wrap landed at
     * the wrong column.
     */
    function openXterm(host: HTMLElement): boolean {
      try { term.open(host); }
      catch (error) {
        console.warn('[metaide] xterm.js display unavailable', error);
        return false;
      }
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => { try { webgl.dispose(); } catch { /* fine */ } });
        term.loadAddon(webgl);
      } catch (e) { console.warn('[metaide] webgl renderer unavailable, falling back to DOM', e); }
      term.textarea?.addEventListener('focus', focusReg.used);
      return true;
    }

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
      const selected = await engine;
      if (disposed || termRef.current !== term) return;
      const host = termHostRef.current;
      if (!host) return;
      optionalEngine = selected === 'ghostty';
      opened = openXterm(host);
      if (opened) syncXtermGeometry();
      else if (!optionalEngine) {
        activeSurfaceRef.current = null;
        outputRef.current = null;
        pendingLive.current = '';
        replayDrained.current = true;
        setEngineStatus('failed');
        return;
      }
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
    // Padding can change the fit host without changing the outer frame.
    if (termHostRef.current) ro.observe(termHostRef.current);
    const bufferChange = term.buffer.onBufferChange((buffer) => setAltScreen(buffer.type === 'alternate'));

    // Intercept every copy from the terminal (Cmd+C, right-click Copy,
    // browser Edit menu) and replace the clipboard payload with a
    // sanitized version — strips ANSI, PUA icons, zero-width chars, NBSPs,
    // and trailing-space column padding. Without this, pastes into email
    // land as "Â " for NBSP and tofu boxes for Nerd Font glyphs.
    function onCopy(e: ClipboardEvent) {
      const sel = activeSurfaceRef.current?.getSelection();
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
    const onScheme = () => {
      const theme = buildTheme();
      term.options.theme = theme;
      ghosttyRef.current?.applyAppearance({ theme });
    };
    media.addEventListener('change', onScheme);
    // Appearance, palette and frosted-glass level changes (the level-scoped --term-fg) must refresh existing terminals.
    const themeObserver = new MutationObserver(onScheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette', FROST_ATTR.platform, FROST_ATTR.chromeFrost, FROST_ATTR.terminalFrost] });

    return () => {
      fontUpdater.dispose();
      disposed = true;
      opening.abort();
      optionalView?.dispose();
      ghostHost?.remove();
      opened = false;
      window.clearTimeout(late1);
      window.clearTimeout(late2);
      window.removeEventListener('focus', passiveSync);
      offHoldRelease();
      ro.disconnect();
      bufferChange.dispose();
      backdrop?.dispose();
      media.removeEventListener('change', onScheme);
      themeObserver.disconnect();
      copyHost?.removeEventListener('copy', onCopy);
      linkProviderDisposable.dispose();
      oscDisposable?.dispose();
      focusReg.unregister();
      viewSource.close();
      term.dispose();
      if (termRef.current === term) termRef.current = null;
      activeSurfaceRef.current = null;
      outputRef.current = null;
      ghosttyRef.current = null;
      if (fontUpdaterRef.current === fontUpdater) fontUpdaterRef.current = null;
      if (geometrySyncRef.current === synchronizeGeometry) geometrySyncRef.current = null;
      searchRef.current = null;
    };
    // Font metric changes must not recreate the terminal. Dedicated effects below
    // apply font size, weight and family updates to the live instance instead.
  }, [projectId, shellIndex, remoteDeviceId, pasteFromText, hoverHold, uploads.tracker]);

  const findNext = useCallback((q: string) => {
    if (ghosttyRef.current) { ghosttyRef.current.find.step(q, 1); return; }
    if (!q || !searchRef.current) return;
    searchRef.current.findNext(q, { caseSensitive: false, wholeWord: false, regex: false });
  }, []);
  const findPrev = useCallback((q: string) => {
    if (ghosttyRef.current) { ghosttyRef.current.find.step(q, -1); return; }
    if (!q || !searchRef.current) return;
    searchRef.current.findPrevious(q, { caseSensitive: false, wholeWord: false, regex: false });
  }, []);

  const closeFind = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    if (ghosttyRef.current) ghosttyRef.current.find.clear();
    else searchRef.current?.clearDecorations();
    activeSurfaceRef.current?.focus();
  }, []);

  // Entering or leaving the alternate screen changes the usable width (scrollbar strip); refit.
  useEffect(() => {
    geometrySyncRef.current?.();
  }, [altScreen]);

  // Push font-size changes into the running instance and immediately remeasure its geometry.
  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.fontSize = fontSize;
    ghosttyRef.current?.applyAppearance({ fontSize });
    geometrySyncRef.current?.({ forceResize: true });
  }, [fontSize]);

  // Weight changes repaint without remeasuring: xterm's cell size ignores weight, so the PTY keeps its geometry.
  useEffect(() => {
    if (!termRef.current) return;
    const weights = terminalFontWeightOptions({ weight: fontWeight, boldWeight });
    termRef.current.options = weights;
    ghosttyRef.current?.applyAppearance(weights);
  }, [fontWeight, boldWeight]);

  useEffect(() => {
    const updater = fontUpdaterRef.current;
    if (!updater || appliedFontFamilyRef.current === terminalFontFamily) return;
    appliedFontFamilyRef.current = terminalFontFamily;
    void updater.apply(terminalFontFamily);
    ghosttyRef.current?.applyAppearance({ fontFamily: buildFontFamilyStack(terminalFontFamily, TERMINAL_FONT_FALLBACK) });
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
    function onGhosttyKey(e: KeyboardEvent) {
      if (!(e.target instanceof Element) || !e.target.closest('[data-terminal-engine-host="ghostty"]') || !terminalTabAction(e, platform)) return;
      // Ghostty stops rejected key events at its own capture listener.
      e.stopPropagation();
      onKey(e);
    }
    el.addEventListener('keydown', onGhosttyKey, true);
    el.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('keydown', onGhosttyKey, true);
      el.removeEventListener('keydown', onKey);
    };
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
      if (replayDrained.current) outputRef.current?.(data);
      else pendingLive.current += data;
    },
    exit: (code) => {
      shellExitedRef.current = true;
      const notice = '\r\n[shell exited]\r\n';
      if (!replayDrained.current) pendingLive.current += notice;
      else outputRef.current?.(notice);
      setExitInfo({ code });
    },
  };

  // After an exit, relaunch the normal way so the agent resumes its session.
  // A missing session falls back to a fresh start in main; a corrupted one has
  // its own overlay (repair / start fresh).
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
  // The default-path relaunch resumes the session like any other launch; the
  // corrupted-session overlay offers repair or a fresh start when that is the cause.
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
        await api.invoke('shells:launch', { projectId });
      }
    } catch (e) {
      toast('Re-launch failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    } finally {
      setRelaunching(false);
    }
  }, [projectId, shellIndex, relaunching]);

  // The full pane paints through the padding without changing either renderer's fit host.
  return (
    <div
      ref={containerRef}
      data-testid="shell-tab"
      tabIndex={-1}
      {...dropHandlers}
      // Any selection attempt clears a stuck peek card — the card is
      // pointer-events-auto beside the cursor, so left alone it would
      // swallow the mousedown and block the drag. Clicks ON the card are
      // excluded: they open the file, and must not dismiss it first.
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('[data-testid="hover-preview"]')) return;
        hoverHold.dispose();
        setHover(null);
      }}
      onContextMenu={(e) => {
        // Only intercept when the click is inside the terminal viewport.
        // Anything else (search bar, drop overlay) uses default browser menu.
        if (!(e.target as HTMLElement).closest('.xterm')) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      data-alt-screen={altScreen || undefined}
      className="terminal-pane relative w-full h-full min-h-0 focus:outline-none"
      style={{ paddingInline: horizontalPadding, paddingTop: verticalPadding ?? DEFAULT_TERMINAL_PADDING.top,
        paddingBottom: verticalPadding ?? DEFAULT_TERMINAL_PADDING.bottom }}
    >
      {/* `isolate` keeps xterm's internal z-indexes (e.g. its link layer) inside the
          host, so the exit overlay, drop hint and search bar always paint above it. */}
      <div ref={termHostRef} className="relative w-full h-full isolate" style={{ visibility: 'hidden' }} data-terminal-engine={engineStatus} />
      {(engineStatus === 'loading' || engineStatus === 'recovering' || engineStatus === 'fallback') && (
        <p role="status" className="pointer-events-none absolute right-2 top-2 z-10 rounded-md bg-[--surface-field] px-2 py-1 text-xs text-[--text]">
          {engineStatus === 'loading' ? 'Loading Ghostty…' : engineStatus === 'recovering' ? 'Switching to xterm.js…' : 'Using xterm.js after Ghostty failed'}
        </p>
      )}
       {engineStatus === 'failed' && <p className="absolute inset-x-0 top-2 text-center text-sm" role="alert" tabIndex={0}>The terminal display could not recover. Switch away and back to reconnect to the running shell.</p>}
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
            <Tooltip label="Dismiss this warning">
              <button
                onClick={() => setSessionCorrupted(false)}
                aria-label="Dismiss this warning"
                className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel]"
              >
                ✕
              </button>
            </Tooltip>
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
            <Tooltip label="Dismiss exit notice">
              <button
                onClick={() => setExitInfo(null)}
                aria-label="Dismiss exit notice"
                className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel]"
                data-testid="shell-exit-dismiss"
              >
                <XIcon size={ICON_SIZE.sm} />
              </button>
            </Tooltip>
          </div>
        </div>
      )}
      {dropOverlay && (
        <div className="absolute inset-2 pointer-events-none rounded-md border-2 border-dashed border-[color:var(--accent-mark,var(--accent))] bg-[color:var(--accent)]/10 flex items-center justify-center text-xs text-[--text] font-medium">
          {dropOverlayLabel(dropOverlay, remoteDeviceId ? remoteHostNameRef.current : null)}
        </div>
      )}
      {remoteDeviceId && <UploadProgressOverlay view={uploads.view} onCancel={uploads.cancel} />}
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
              else if (e.key === 'Escape') closeFind();
            }}
            placeholder="Find…"
            className="bg-transparent text-sm px-2 py-0.5 outline-none placeholder:text-[--text-muted] w-40"
          />
          <Tooltip label={SHORTCUT_COPY.searchPrevTitle(platform)}>
            <button onClick={() => findPrev(searchQuery)} aria-label="Previous match" className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel]">↑</button>
          </Tooltip>
          <Tooltip label={SHORTCUT_COPY.searchNextTitle(platform)}>
            <button onClick={() => findNext(searchQuery)} aria-label="Next match" className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel]">↓</button>
          </Tooltip>
          <Tooltip label="Close search" shortcut="Esc">
            <button
              onClick={closeFind}
              aria-label="Close search"
              className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel]"
            >
              <XIcon size={ICON_SIZE.sm} />
            </button>
          </Tooltip>
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
          const term = activeSurfaceRef.current;
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
                const t = activeSurfaceRef.current;
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
              onClick: () => { activeSurfaceRef.current?.clearSelection(); },
            },
          ];
          return <ContextMenu key="context-menu" x={menu.x} y={menu.y} items={items} onClose={() => { setMenu(null); activeSurfaceRef.current?.focus(); }} />;
        })()}
      </AnimatePresence>
    </div>
  );
}
