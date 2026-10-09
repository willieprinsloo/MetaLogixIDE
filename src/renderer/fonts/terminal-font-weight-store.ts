/** Framework-free, per-window store for the shared terminal weight pair (normal and bold), kept in sync with the main-process settings store through injected ports. */
import { FONT_COPY } from '@renderer/fonts/font-contract';
import {
  TERMINAL_BOLD_WEIGHT_DEFAULT,
  TERMINAL_BOLD_WEIGHT_KEY,
  TERMINAL_FONT_WEIGHT_DEFAULT,
  TERMINAL_FONT_WEIGHT_KEY,
  derivedBoldWeight,
  isValidBoldWeight,
  resolveTerminalWeights,
  type TerminalFontWeight,
  type TerminalWeights,
} from '@shared/terminal-font-weight';

export interface TerminalFontWeightSnapshot extends TerminalWeights {
  readonly ready: boolean;
}

/** The raw stored values, unvalidated. */
export interface StoredTerminalWeights {
  readonly weight: unknown;
  readonly boldWeight: unknown;
}

/** IO the store needs; the provider adapts the IPC api and toasts to these. */
export interface TerminalFontWeightPorts {
  loadStored(): Promise<StoredTerminalWeights>;
  saveWeight(value: TerminalFontWeight): Promise<unknown>;
  saveBoldWeight(value: TerminalFontWeight): Promise<unknown>;
  onSettingsChanged(listener: (key: string) => void): () => void;
  notifySaveFailed(message: string): void;
  reportError(context: string, error: unknown): void;
}

export interface TerminalFontWeightStore {
  getSnapshot(): TerminalFontWeightSnapshot;
  subscribe(listener: () => void): () => void;
  setWeight(next: TerminalFontWeight): void;
  setBoldWeight(next: TerminalFontWeight): void;
  connect(): () => void;
}

const WATCHED_KEYS: readonly string[] = [TERMINAL_FONT_WEIGHT_KEY, TERMINAL_BOLD_WEIGHT_KEY];

/**
 * Creates the store. `connect` loads the stored pair, resolving it with `resolveTerminalWeights`
 * (each invalid value is reported once and left untouched; nothing is ever written on load), and
 * re-syncs on `settings:changed` for either key; it returns the disconnect. `setWeight` applies the
 * weight with its derived bold optimistically and saves the weight; `setBoldWeight` applies a bold
 * heavier than the weight and saves it. A failed save reports once, toasts its own copy, and reverts
 * to the re-read stored pair. Every async publish is version-guarded so a stale read never wins.
 */
export function createTerminalFontWeightStore(ports: TerminalFontWeightPorts): TerminalFontWeightStore {
  let snapshot: TerminalFontWeightSnapshot = {
    weight: TERMINAL_FONT_WEIGHT_DEFAULT,
    boldWeight: TERMINAL_BOLD_WEIGHT_DEFAULT,
    ready: false,
  };
  let version = 0;
  let connected = false;
  const listeners = new Set<() => void>();

  function publish(next: TerminalFontWeightSnapshot): void {
    if (next.weight === snapshot.weight && next.boldWeight === snapshot.boldWeight && next.ready === snapshot.ready) return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  }

  async function sync(): Promise<void> {
    const syncVersion = ++version;
    try {
      const stored = await ports.loadStored();
      const { weight, boldWeight, errors } = resolveTerminalWeights(stored.weight, stored.boldWeight);
      errors.forEach((error) => ports.reportError('terminal font weight load', new Error(error)));
      if (connected && syncVersion === version) publish({ weight, boldWeight, ready: true });
    } catch (error) {
      if (connected && syncVersion === version) publish({ ...snapshot, ready: true });
      ports.reportError('terminal font weight load failed', error);
    }
  }

  function apply(next: TerminalWeights, save: () => Promise<unknown>, failedCopy: string): void {
    version += 1;
    publish({ ...next, ready: true });
    save().catch((error: unknown) => {
      ports.reportError('terminal font weight save failed', error);
      ports.notifySaveFailed(failedCopy);
      return sync();
    });
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setWeight(next) {
      if (!snapshot.ready || next === snapshot.weight) return;
      apply({ weight: next, boldWeight: derivedBoldWeight(next) }, () => ports.saveWeight(next), FONT_COPY.terminalWeightSaveFailed);
    },
    setBoldWeight(next) {
      if (!snapshot.ready || next === snapshot.boldWeight || !isValidBoldWeight(snapshot.weight, next)) return;
      apply({ weight: snapshot.weight, boldWeight: next }, () => ports.saveBoldWeight(next), FONT_COPY.terminalBoldSaveFailed);
    },
    connect() {
      connected = true;
      const off = ports.onSettingsChanged((key) => {
        if (WATCHED_KEYS.includes(key)) void sync();
      });
      void sync();
      return () => {
        connected = false;
        version += 1;
        off();
      };
    },
  };
}
