import type { Appearance, GhosttyView } from './ghostty-view-engine';
import { openRecoverableTerminal, type RecoveryState } from './terminal-engine-recovery';
import { createXtermStandbyOutput } from './xterm-standby-output';
import { untilAbort } from './terminal-abort';

const MAX_PENDING_CODE_UNITS = 8 * 1024 * 1024;

interface CompositionOptions {
  readonly host: HTMLElement;
  readonly standby: Pick<GhosttyView, 'write'>;
  readonly appearance: () => Appearance;
  readonly send: (data: string) => void;
  readonly enableXterm: (restoreFocus: boolean) => void;
  readonly onState: (state: RecoveryState, candidate?: GhosttyView) => void;
}

interface Composition {
  write(data: string): void;
  dispose(): void;
}

/** Both engines consume one caller-owned FIFO. Only the visible engine may send effects. */
export function openGhosttyWithStandby(options: CompositionOptions): Composition {
  const standby = createXtermStandbyOutput(options.standby);
  let candidate: GhosttyView | undefined;
  let phase: RecoveryState['kind'] = 'loading';
  let pending = '';
  let overflow = false;
  let fault: (() => void) | undefined;

  const recovery = openRecoverableTerminal({
    async openGhostty(signal, onFault) {
      fault = onFault;
      if (overflow) throw new Error('Ghostty replay backlog exceeded');
      const { openGhosttyView } = await import('./ghostty-view-engine');
      signal.throwIfAborted();
      const view = await openGhosttyView(options.host, options.appearance(), signal, {
        fault: onFault,
        input: data => { if (phase === 'ghostty') options.send(data); },
      });
      const { cols, rows } = options.appearance();
      if (cols && rows) view.resize(cols, rows);
      while (pending) {
        const data = pending;
        pending = '';
        await untilAbort(new Promise<void>(resolve => view.write(data, resolve)), signal);
        signal.throwIfAborted();
      }
      candidate = view;
      return view;
    },
    async promoteXterm(signal, restoreFocus) {
      await standby.promote(signal, () => options.enableXterm(restoreFocus));
      return { dispose() {} }; // The view, not recovery, owns the already-open xterm.
    },
    hasFocus: () => options.host.contains(document.activeElement),
    onState(state) {
      phase = state.kind;
      if (phase !== 'loading') pending = '';
      if (phase !== 'ghostty') candidate = undefined;
      options.onState(state, candidate);
    },
  });

  return {
    write(data) {
      if (phase === 'failed') return;
      standby.write(data);
      if (candidate) candidate.write(data);
      else if (phase === 'loading' && !overflow) {
        if (pending.length + data.length <= MAX_PENDING_CODE_UNITS) pending += data;
        else { overflow = true; pending = ''; fault?.(); }
      }
    },
    dispose() { phase = 'failed'; pending = ''; candidate = undefined; recovery.dispose(); },
  };
}
