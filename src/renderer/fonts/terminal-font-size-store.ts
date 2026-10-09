/** Framework-free, per-window store for the shared terminal font size, kept in sync with the main-process settings store through injected ports. */
import { FONT_COPY } from '@renderer/fonts/font-contract';
import {
  TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_KEY,
  clampTerminalFontSize,
  migratedTerminalFontSize,
  parseTerminalFontSize,
} from '@shared/terminal-font-size';

export interface TerminalFontSizeSnapshot {
  readonly size: number;
  readonly ready: boolean;
}

export interface TerminalFontSizeSaveRequest {
  readonly value: number;
  readonly onlyIfUnset?: boolean;
}

/** IO the store needs; the provider adapts the IPC api, localStorage and toasts to these. */
export interface TerminalFontSizePorts {
  loadStored(): Promise<unknown>;
  save(request: TerminalFontSizeSaveRequest): Promise<{ value: number; changed: boolean }>;
  onSettingsChanged(listener: (key: string) => void): () => void;
  readLegacy(): string | null;
  notifySaveFailed(message: string): void;
  reportError(context: string, error: unknown): void;
}

export interface TerminalFontSizeStore {
  getSnapshot(): TerminalFontSizeSnapshot;
  subscribe(listener: () => void): () => void;
  setSize(next: number): void;
  connect(): () => void;
}

/**
 * Creates the store. `connect` loads the stored size (migrating the legacy value once when nothing is
 * stored) and follows `settings:changed`; it returns the disconnect. `setSize` clamps, applies
 * optimistically and persists; a failed save reports once and reverts to the re-read stored value.
 * Every async publish is version-guarded so a stale read can never step the size backwards.
 */
export function createTerminalFontSizeStore(ports: TerminalFontSizePorts): TerminalFontSizeStore {
  let snapshot: TerminalFontSizeSnapshot = { size: TERMINAL_FONT_SIZE.default, ready: false };
  let version = 0;
  let connected = false;
  const listeners = new Set<() => void>();

  function publish(next: TerminalFontSizeSnapshot): void {
    if (next.size === snapshot.size && next.ready === snapshot.ready) return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  }

  async function resolveStored(): Promise<number> {
    const stored = await ports.loadStored();
    if (stored === null) {
      const migrated = migratedTerminalFontSize(ports.readLegacy());
      return (await ports.save({ value: migrated, onlyIfUnset: true })).value;
    }
    const parsed = parseTerminalFontSize(stored);
    if (!parsed.ok) throw new Error(`invalid persisted ${TERMINAL_FONT_SIZE_KEY}: ${parsed.error}`);
    return parsed.value;
  }

  async function sync(): Promise<void> {
    const syncVersion = ++version;
    try {
      const size = await resolveStored();
      if (connected && syncVersion === version) publish({ size, ready: true });
    } catch (error) {
      if (connected && syncVersion === version) publish({ ...snapshot, ready: true });
      ports.reportError('terminal font size load failed', error);
    }
  }

  function persist(value: number): void {
    ports.save({ value }).catch((error: unknown) => {
      ports.reportError('terminal font size save failed', error);
      ports.notifySaveFailed(FONT_COPY.terminalSizeSaveFailed);
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
    setSize(next) {
      if (!snapshot.ready) return;
      const size = clampTerminalFontSize(next);
      if (size === snapshot.size) return;
      version += 1;
      publish({ size, ready: true });
      persist(size);
    },
    connect() {
      connected = true;
      const off = ports.onSettingsChanged((key) => {
        if (key === TERMINAL_FONT_SIZE_KEY) void sync();
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
