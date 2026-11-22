import type { Appearance, GhosttyView } from './ghostty-view-engine';
import { openRecoverableTerminal, type RecoveryState } from './terminal-engine-recovery';
import { createXtermStandbyOutput } from './xterm-standby-output';
import { untilAbort } from './terminal-abort';
import { captureTerminalFocusHandoff } from './terminal-focus-handoff';

const MAX_PENDING_CODE_UNITS = 8 * 1024 * 1024;

interface CompositionOptions {
  readonly host: HTMLElement;
  readonly standby: Pick<GhosttyView, 'write'>;
  readonly standbyAvailable: () => boolean;
  readonly snapshot: string;
  readonly enableClipboard: () => void;
  readonly appearance: () => Appearance;
  readonly send: (data: string) => void;
  readonly alignGrid: (cols: number, rows: number) => void;
  readonly canRefit: () => boolean;
  readonly enableXterm: (restoreFocus: boolean) => void;
  readonly onState: (state: RecoveryState, candidate?: GhosttyView) => void;
}

interface Composition {
  write(data: string): void;
  fit(): void;
  dispose(): void;
}

/** Both engines consume the same FIFO. Standby owns clipboard effects; only the active engine sends PTY input. */
export function openGhosttyWithStandby(options: CompositionOptions): Composition {
  const standby = createXtermStandbyOutput(options.standby);
  let candidate: GhosttyView | undefined;
  let fitting: GhosttyView | undefined;
  let phase: RecoveryState['kind'] = 'loading';
  let pendingReplay = options.snapshot;
  let pending = '';
  let overflow = false;
  let fault: (() => void) | undefined;
  let standbyPrimed = false;
  let lastGrid: ReturnType<GhosttyView['fit']>;
  let fitQueued = false;

  function primeStandby() {
    if (standbyPrimed) return;
    standbyPrimed = true;
    // CAN ends any unfinished replay escape sequence before the live-only OSC handler is installed.
    if (options.snapshot) standby.write(`${options.snapshot}\x18`, options.enableClipboard);
    else options.enableClipboard();
    if (pending) standby.write(pending);
  }

  function syncGrid() {
    const grid = fitting?.fit();
    if (!grid || (grid.cols === lastGrid?.cols && grid.rows === lastGrid.rows)) return;
    lastGrid = grid;
    options.alignGrid(grid.cols, grid.rows);
  }

  function scheduleFit() {
    if (fitQueued) return;
    fitQueued = true;
    queueMicrotask(() => {
      fitQueued = false;
      if (options.canRefit()) syncGrid();
    });
  }

  const recovery = openRecoverableTerminal({
    async openGhostty(signal, onFault) {
      fault = onFault;
      if (overflow || pendingReplay.length > MAX_PENDING_CODE_UNITS) throw new Error('Ghostty replay backlog exceeded');
      const { openGhosttyView } = await import('./ghostty-view-engine');
      signal.throwIfAborted();
      const view = await openGhosttyView(options.host, options.appearance(), signal, {
        fault: onFault,
        layoutChanged: scheduleFit,
        input: data => { if (phase === 'ghostty') options.send(data); },
      });
      signal.throwIfAborted();
      fitting = view;
      syncGrid();
      primeStandby();
      if (pendingReplay) {
        const replay = pendingReplay;
        pendingReplay = '';
        await writeCandidate(view, replay, signal);
      }
      while (pending) {
        const data = pending;
        pending = '';
        await writeCandidate(view, data, signal);
      }
      candidate = view;
      return view;
    },
    async promoteXterm(signal, restoreFocus) {
      if (!options.standbyAvailable()) throw new Error('xterm.js display unavailable');
      await standby.promote(signal, () => options.enableXterm(restoreFocus()));
      return { dispose() {} }; // The view, not recovery, owns the already-open xterm.
    },
    captureFocus: signal => captureTerminalFocusHandoff(options.host, signal),
    onState(state) {
      phase = state.kind;
      if (phase === 'recovering') primeStandby();
      if (phase === 'recovering' || phase === 'failed') fitting = undefined;
      if (phase !== 'loading') { pending = ''; pendingReplay = ''; }
      if (phase !== 'ghostty') candidate = undefined;
      options.onState(state, candidate);
    },
  });

  return {
    write(data) {
      if (phase === 'failed') return;
      if (standbyPrimed) standby.write(data);
      if (candidate) candidate.write(data);
      else if (phase === 'loading' && !overflow) {
        if (pendingReplay.length + pending.length + data.length <= MAX_PENDING_CODE_UNITS) pending += data;
        else {
          if (!standbyPrimed) { primeStandby(); standby.write(data); }
          overflow = true;
          pending = '';
          fault?.();
        }
      }
    },
    fit: syncGrid,
    dispose() { phase = 'failed'; pending = ''; pendingReplay = ''; candidate = undefined; fitting = undefined; recovery.dispose(); },
  };
}

async function writeCandidate(view: GhosttyView, data: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await untilAbort(new Promise<void>(resolve => view.write(data, resolve)), signal);
  signal.throwIfAborted();
}
