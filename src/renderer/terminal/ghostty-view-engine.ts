import { Terminal, preloadXtermRuntime, type GespenstTerminalOptions, type PreloadedXtermRuntime } from '@gespenst/xterm';
import '@gespenst/xterm/css/xterm.css';
import { GHOSTTY_HOST_ATTRIBUTE } from '@shared/terminal-engine';
import vt from 'virtual:metaide-ghostty-vt';
import callbacks from 'virtual:metaide-ghostty-callbacks';
import type { TerminalRenderer } from './terminal-engine-recovery';
import { untilAbort } from './terminal-abort';
import type { IBuffer, ILink, Terminal as StockTerminal } from '@xterm/xterm';
import { registerClipboardOsc, type ClipboardOscDeps } from '../osc52';
import { createTerminalFind, type TerminalFind } from './terminal-view-find';
import { createGhosttyFindPaint } from './ghostty-find-paint';
import { terminalWebLinks, type TerminalFileLink, fileLinksInRow } from './terminal-view-links';

export type TerminalViewSurface = Pick<StockTerminal, 'focus' | 'paste' | 'hasSelection' | 'getSelection' | 'clearSelection'> & {
  readonly buffer: { readonly active: Pick<IBuffer, 'length' | 'getLine'> };
};

export interface GhosttyView extends TerminalRenderer {
  readonly surface: TerminalViewSurface;
  readonly find: TerminalFind;
  write(data: string, parsed?: () => void): void;
  fit(): { readonly cols: number; readonly rows: number } | undefined;
  applyAppearance(appearance: Appearance): void;
  reveal(handlers: GhosttyInteraction): void;
  focus(): void;
}

interface GhosttyInteraction {
  readonly keys: (event: KeyboardEvent) => boolean;
  readonly pathLinks?: (text: string) => readonly TerminalFileLink[];
  readonly openWebLink: (url: string) => void;
  readonly clipboard: ClipboardOscDeps;
  readonly focused: () => void;
}

interface GhosttyHandlers {
  readonly fault: () => void;
  readonly layoutChanged: () => void;
  // Parser replies are tagged independently of genuine input, even during writes.
  readonly input: (data: string, source: 'key' | 'text' | 'paste' | 'mouse' | 'focus' | 'reply') => void;
}

export type Appearance = Pick<GespenstTerminalOptions, 'cols' | 'rows' | 'fontFamily' | 'fontSize' | 'fontWeight' |
  'fontWeightBold' | 'lineHeight' | 'letterSpacing' | 'theme' | 'cursorBlink' | 'cursorStyle'>;

let compiled: PreloadedXtermRuntime | undefined;

async function compileRuntime(): Promise<PreloadedXtermRuntime> {
  if (compiled) return compiled;
  const runtime = await preloadXtermRuntime({ wasm: vt, callbacksWasm: callbacks });
  return compiled ??= runtime;
}

function waitForMount(term: Terminal, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let frame = 0;
    function stop() {
      cancelAnimationFrame(frame);
      reject(signal.reason);
    }
    function check() {
      // Gespenst assigns textarea after the async DOM mount and initial fit, not at terminal.ready.
      if (term.textarea?.isConnected) {
        signal.removeEventListener('abort', stop);
        resolve();
      } else frame = requestAnimationFrame(check);
    }
    if (signal.aborted) { stop(); return; }
    signal.addEventListener('abort', stop, { once: true });
    check();
  });
}

async function checkFirstPaint(terminal: Terminal, host: HTMLElement, signal: AbortSignal): Promise<void> {
  await waitForMount(terminal, signal);
  signal.throwIfAborted();
  const native = await terminal.native;
  signal.throwIfAborted();
  await untilAbort(native.writeAsync(''), signal);
  const { cellWidthPx, cellHeightPx } = native.geometry;
  if (native.renderer.backend !== 'webgl2' || cellWidthPx <= 0 || cellHeightPx <= 0 ||
      host.clientWidth <= 0 || host.clientHeight <= 0) {
    throw new Error('Ghostty renderer failed its mount or paint check');
  }
}

/** This module must only be reached through the opt-in dynamic import. */
export async function openGhosttyView(
  host: HTMLElement, appearance: Appearance, signal: AbortSignal, handlers: GhosttyHandlers,
): Promise<GhosttyView> {
  signal.throwIfAborted();
  const runtime = await untilAbort(compileRuntime(), signal);
  signal.throwIfAborted();

  let disposed = false;
  let faulted = false;
  function fault() {
    if (disposed || faulted) return;
    faulted = true;
    // Let the vendor event/write stack finish before recovery disposes it.
    queueMicrotask(() => { if (!disposed) handlers.fault(); });
  }
  const quiet = () => {};
  const terminal = new Terminal({
    ...appearance,
    scrollback: 12_000,
    allowTransparency: true,
    linkHandler: { allowNonHttpProtocols: false, activate: quiet },
    logger: { trace: quiet, debug: quiet, info: quiet, warn: quiet, error: fault },
    gespenst: { ...runtime, worker: false, renderer: 'webgl2' },
  });
  const disposables: TerminalRenderer[] = [];
  function dispose() {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener('abort', dispose);
    host.removeEventListener('webglcontextlost', fault, true);
    for (const listener of disposables) listener.dispose();
    terminal.dispose();
    host.removeAttribute(GHOSTTY_HOST_ATTRIBUTE);
    delete host.dataset.terminalAlternate;
  }
  signal.addEventListener('abort', dispose, { once: true });
  host.addEventListener('webglcontextlost', fault, true);
  host.setAttribute(GHOSTTY_HOST_ATTRIBUTE, 'ghostty');
  let native: Awaited<Terminal['native']>;
  try {
    terminal.open(host);
    native = await untilAbort(Promise.all([terminal.ready, terminal.native]).then(([, native]) => native), signal);
    disposables.push(native.on('error', fault), native.on('renderer', info => { if (info.backend !== 'webgl2') fault(); }),
      native.on('font', handlers.layoutChanged), terminal.buffer.onBufferChange(handlers.layoutChanged));
    await checkFirstPaint(terminal, host, signal);
    signal.throwIfAborted();
    if (faulted) throw new Error('Ghostty renderer faulted during setup');
    const decoder = new TextDecoder();
    disposables.push(native.on('input', ({ data, source }) => {
      if (!disposed && !faulted) handlers.input(decoder.decode(data), source);
    }));
  } catch (error) {
    dispose();
    throw error;
  }
  const findPaint = createGhosttyFindPaint(host, () => ({
    ...native.geometry, viewportY: terminal.buffer.active.viewportY, devicePixelRatio: window.devicePixelRatio || 1,
  }), row => terminal.scrollToLine(row));
  const find = createTerminalFind({ buffer: () => terminal.buffer.active, show: findPaint.show, clear: findPaint.clear });
  disposables.push(native.on('viewportChange', findPaint.refresh), { dispose: findPaint.clear });
  return {
    surface: {
      get buffer() { return terminal.buffer; },
      focus: () => terminal.focus(),
      hasSelection: () => terminal.hasSelection(),
      getSelection: () => terminal.getSelection(),
      clearSelection: () => terminal.clearSelection(),
      paste(text) {
        if (disposed || faulted) return;
        terminal.clearSelection();
        if (terminal.options.scrollOnUserInput) terminal.scrollToBottom();
        native.paste(text.replace(/\r?\n/gu, '\r'));
      },
    },
    find,
    write(data, parsed) {
      if (disposed || faulted) return;
      try { terminal.write(data, parsed); } catch { fault(); }
    },
    fit() {
      if (disposed || faulted || host.clientWidth < 20 || host.clientHeight < 20) return;
      host.toggleAttribute('data-terminal-alternate', terminal.buffer.active.type === 'alternate');
      try {
        native.fit();
        return native.geometry;
      } catch { fault(); }
    },
    applyAppearance(appearance) {
      if (!disposed && !faulted) terminal.options = appearance;
    },
    reveal(interaction) {
      if (disposed || faulted) return;
      terminal.attachCustomKeyEventHandler(interaction.keys);
      disposables.push(terminal.registerLinkProvider({
        provideLinks(line, callback) {
          const buffer = terminal.buffer.active;
          const web = terminalWebLinks(buffer, line, interaction.openWebLink);
          const files: ILink[] = interaction.pathLinks ? fileLinksInRow(buffer, line, interaction.pathLinks) : [];
          const links = [...web, ...files];
          callback(links.length ? links : undefined);
        },
      }));
      disposables.push(registerClipboardOsc(terminal, interaction.clipboard));
      terminal.textarea?.addEventListener('focus', interaction.focused);
      disposables.push({ dispose: () => terminal.textarea?.removeEventListener('focus', interaction.focused) });
    },
    focus() { if (!disposed && !faulted) terminal.focus(); },
    dispose,
  };
}
