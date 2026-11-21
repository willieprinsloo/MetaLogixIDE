const GHOSTTY_LOAD_MS = 5000;
const STARTUP_DEADLINE_MS = 10_000;
const RUNTIME_RECOVERY_MS = 5000;

export interface TerminalRenderer {
  dispose(): void;
}

type RecoveryReason = 'load-timeout' | 'load-failed' | 'renderer-fault';
export type RecoveryState = { readonly kind: 'loading' | 'ghostty' } |
  { readonly kind: 'recovering' | 'xterm' | 'failed'; readonly reason: RecoveryReason };
type Phase = 'loading' | 'ghostty' | 'recovering' | 'xterm' | 'failed' | 'disposed';

interface RecoveryOptions {
  readonly openGhostty: (signal: AbortSignal, onFault: () => void) => Promise<TerminalRenderer>;
  /** Promote an already-fed standby. Neither operation may acquire a shell stream. */
  readonly promoteXterm: (signal: AbortSignal, restoreFocus: boolean) => Promise<TerminalRenderer>;
  readonly hasFocus: () => boolean;
  readonly onState: (state: RecoveryState) => void;
}

/** Owns one optional renderer attempt and its deadline. Shell I/O stays with the caller. */
export function openRecoverableTerminal(options: RecoveryOptions): TerminalRenderer {
  const startedAt = performance.now();
  const candidate = new AbortController();
  const standby = new AbortController();
  let phase: Phase = 'loading';
  let renderer: TerminalRenderer | undefined;
  let deadline: ReturnType<typeof setTimeout>;

  function accept(ready: TerminalRenderer, expected: Phase, next: RecoveryState): void {
    if (phase !== expected) { ready.dispose(); return; }
    clearTimeout(deadline);
    renderer = ready;
    phase = next.kind;
    options.onState(next);
  }

  function recover(reason: RecoveryReason): void {
    if (phase !== 'loading' && phase !== 'ghostty') return;
    const budget = phase === 'loading' ? STARTUP_DEADLINE_MS - (performance.now() - startedAt) : RUNTIME_RECOVERY_MS;
    const restoreFocus = options.hasFocus();
    phase = 'recovering';
    clearTimeout(deadline);
    candidate.abort();
    renderer?.dispose();
    renderer = undefined;
    const fail = () => {
      if (phase !== 'recovering') return;
      phase = 'failed';
      clearTimeout(deadline);
      standby.abort();
      options.onState({ kind: 'failed', reason });
    };
    deadline = setTimeout(fail, Math.max(0, budget));
    options.onState({ kind: 'recovering', reason });
    void Promise.resolve().then(() => {
      if (phase === 'recovering') return options.promoteXterm(standby.signal, restoreFocus);
    }).then(ready => { if (ready) accept(ready, 'recovering', { kind: 'xterm', reason }); }, fail);
  }

  deadline = setTimeout(() => recover('load-timeout'), GHOSTTY_LOAD_MS);
  options.onState({ kind: 'loading' });
  void Promise.resolve().then(() => {
    if (phase === 'loading') return options.openGhostty(candidate.signal, () => recover('renderer-fault'));
  }).then(ready => { if (ready) accept(ready, 'loading', { kind: 'ghostty' }); }, () => recover('load-failed'));

  return { dispose() {
    if (phase === 'disposed') return;
    phase = 'disposed';
    clearTimeout(deadline);
    candidate.abort();
    standby.abort();
    renderer?.dispose();
    renderer = undefined;
  } };
}
