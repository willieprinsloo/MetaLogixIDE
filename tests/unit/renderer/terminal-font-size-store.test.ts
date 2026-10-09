/** Contract tests for the per-window terminal font size store: load, migration, optimistic set, refresh ordering and failure revert. */
import { describe, expect, it, vi } from 'vitest';
import { FONT_COPY } from '@renderer/fonts/font-contract';
import {
  createTerminalFontSizeStore,
  type TerminalFontSizePorts,
  type TerminalFontSizeSnapshot,
} from '@renderer/fonts/terminal-font-size-store';

vi.mock('@shared/terminal-font-size', async (orig) => {
  const actual = await orig<typeof import('@shared/terminal-font-size')>();
  const { min, max, default: fallback } = actual.TERMINAL_FONT_SIZE;
  const clamp = (value: number): number => Math.min(max, Math.max(min, Math.round(value)));
  return {
    ...actual,
    parseTerminalFontSize: (value: unknown) =>
      typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
        ? { ok: true, value }
        : { ok: false, error: 'invalid' },
    clampTerminalFontSize: clamp,
    migratedTerminalFontSize: (raw: string | null) => {
      const n = raw === null || raw === '' ? Number.NaN : Number(raw);
      return Number.isFinite(n) ? clamp(n) : fallback;
    },
  };
});

const KEY = 'terminal_font_size';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface SaveRequest {
  readonly value: number;
  readonly onlyIfUnset?: boolean;
}

interface Harness {
  readonly ports: TerminalFontSizePorts;
  readonly loadStored: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
  readonly save: ReturnType<typeof vi.fn<(request: SaveRequest) => Promise<{ value: number; changed: boolean }>>>;
  readonly readLegacy: ReturnType<typeof vi.fn<() => string | null>>;
  readonly notifySaveFailed: ReturnType<typeof vi.fn<(message: string) => void>>;
  readonly reportError: ReturnType<typeof vi.fn<(context: string, error: unknown) => void>>;
  emitChanged(key: string): void;
  listenerCount(): number;
}

function harness(stored: unknown, legacy: string | null = null): Harness {
  let current: unknown = stored;
  const listeners = new Set<(key: string) => void>();
  const loadStored = vi.fn(async (): Promise<unknown> => current);
  const save = vi.fn(async (request: SaveRequest) => {
    if (request.onlyIfUnset && current !== null) return { value: current as number, changed: false };
    current = request.value;
    return { value: request.value, changed: true };
  });
  const readLegacy = vi.fn((): string | null => legacy);
  const notifySaveFailed = vi.fn<(message: string) => void>();
  const reportError = vi.fn<(context: string, error: unknown) => void>();
  const ports: TerminalFontSizePorts = {
    loadStored,
    save,
    readLegacy,
    notifySaveFailed,
    reportError,
    onSettingsChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    ports,
    loadStored,
    save,
    readLegacy,
    notifySaveFailed,
    reportError,
    emitChanged: (key) => listeners.forEach((listener) => listener(key)),
    listenerCount: () => listeners.size,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function track(store: { subscribe(listener: () => void): () => void; getSnapshot(): TerminalFontSizeSnapshot }): TerminalFontSizeSnapshot[] {
  const seen: TerminalFontSizeSnapshot[] = [];
  store.subscribe(() => seen.push(store.getSnapshot()));
  return seen;
}

async function connected(h: Harness): Promise<ReturnType<typeof createTerminalFontSizeStore>> {
  const store = createTerminalFontSizeStore(h.ports);
  store.connect();
  await settle();
  return store;
}

describe('terminal font size store — load', () => {
  it('starts at the default size and not ready', () => {
    const store = createTerminalFontSizeStore(harness(18).ports);
    expect(store.getSnapshot()).toEqual({ size: 14, ready: false });
  });

  it('publishes a stored size once, without touching the legacy value', async () => {
    const h = harness(18, '22');
    const store = createTerminalFontSizeStore(h.ports);
    const seen = track(store);
    store.connect();
    await settle();
    expect(store.getSnapshot()).toEqual({ size: 18, ready: true });
    expect(seen).toEqual([{ size: 18, ready: true }]);
    expect(h.readLegacy).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });

  it('migrates a valid legacy value with onlyIfUnset and publishes the returned value once', async () => {
    const h = harness(null, '18');
    const store = createTerminalFontSizeStore(h.ports);
    const seen = track(store);
    store.connect();
    await settle();
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.save).toHaveBeenCalledWith({ value: 18, onlyIfUnset: true });
    expect(seen).toEqual([{ size: 18, ready: true }]);
  });

  it.each([[null], ['abc'], ['']])('migrates a missing or invalid legacy value (%j) to 14', async (legacy) => {
    const h = harness(null, legacy);
    const store = await connected(h);
    expect(h.save).toHaveBeenCalledWith({ value: 14, onlyIfUnset: true });
    expect(store.getSnapshot()).toEqual({ size: 14, ready: true });
  });

  it('rounds and clamps a legacy value before migrating it', async () => {
    const h = harness(null, '40.4');
    await connected(h);
    expect(h.save).toHaveBeenCalledWith({ value: 28, onlyIfUnset: true });
  });

  it('publishes the value another window already migrated', async () => {
    const h = harness(null, '18');
    h.save.mockResolvedValueOnce({ value: 20, changed: false });
    const store = await connected(h);
    expect(store.getSnapshot()).toEqual({ size: 20, ready: true });
  });

  it('migrates only once when the migration broadcast arrives before the setter reply', async () => {
    const h = harness(null, '18');
    const reply = deferred<{ value: number; changed: boolean }>();
    h.save.mockImplementationOnce(async (request) => {
      void request;
      h.loadStored.mockResolvedValue(18);
      h.emitChanged(KEY);
      return reply.promise;
    });
    const store = createTerminalFontSizeStore(h.ports);
    const seen = track(store);
    store.connect();
    await settle();
    reply.resolve({ value: 18, changed: true });
    await settle();
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ size: 18, ready: true }]);
  });

  it('becomes ready at the default and reports the error when the stored value cannot be loaded', async () => {
    const h = harness(null);
    const failure = new Error('ipc down');
    h.loadStored.mockRejectedValueOnce(failure);
    const store = await connected(h);
    expect(store.getSnapshot()).toEqual({ size: 14, ready: true });
    expect(h.reportError).toHaveBeenCalledWith(expect.any(String), failure);
  });

  it('rejects a corrupt stored value rather than publishing it', async () => {
    const h = harness('huge');
    const store = await connected(h);
    expect(store.getSnapshot()).toEqual({ size: 14, ready: true });
    expect(h.reportError).toHaveBeenCalledTimes(1);
  });
});

describe('terminal font size store — setSize', () => {
  it('applies the new size synchronously, then persists it', async () => {
    const h = harness(14);
    const store = await connected(h);
    store.setSize(16);
    expect(store.getSnapshot()).toEqual({ size: 16, ready: true });
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.save).toHaveBeenCalledWith({ value: 16 });
  });

  it('clamps an out-of-range size before applying and persisting it', async () => {
    const h = harness(14);
    const store = await connected(h);
    store.setSize(40);
    expect(store.getSnapshot().size).toBe(28);
    expect(h.save).toHaveBeenCalledWith({ value: 28 });
  });

  it.each([[14, 14], [9, 8], [28, 29]])('is a no-op without IPC when stored %i and asked for %i', async (stored, next) => {
    const h = harness(stored);
    const store = await connected(h);
    const seen = track(store);
    store.setSize(next);
    await settle();
    expect(h.save).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('ignores setSize before the stored size has loaded', async () => {
    const h = harness(18);
    const store = createTerminalFontSizeStore(h.ports);
    store.setSize(20);
    expect(h.save).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toEqual({ size: 14, ready: false });
  });

  it('drops a stale refresh that resolves after a newer setSize', async () => {
    const h = harness(14);
    const store = await connected(h);
    const stale = deferred<unknown>();
    h.loadStored.mockReturnValueOnce(stale.promise);
    h.emitChanged(KEY);
    store.setSize(17);
    stale.resolve(15);
    await settle();
    expect(store.getSnapshot().size).toBe(17);
  });
});

describe('terminal font size store — settings:changed', () => {
  it('re-reads and publishes the stored size when the key changes in another window', async () => {
    const h = harness(14);
    const store = await connected(h);
    h.loadStored.mockResolvedValue(22);
    h.emitChanged(KEY);
    await settle();
    expect(store.getSnapshot()).toEqual({ size: 22, ready: true });
  });

  it('does not notify again when the broadcast echoes this window\'s own save', async () => {
    const h = harness(14);
    const store = await connected(h);
    const seen = track(store);
    store.setSize(16);
    await settle();
    h.emitChanged(KEY);
    await settle();
    expect(seen).toEqual([{ size: 16, ready: true }]);
  });

  it('ignores changes to other settings keys', async () => {
    const h = harness(14);
    await connected(h);
    h.loadStored.mockClear();
    h.emitChanged('terminal_font_family');
    await settle();
    expect(h.loadStored).not.toHaveBeenCalled();
  });

  it('stops listening and publishing after disconnect', async () => {
    const h = harness(14);
    const store = createTerminalFontSizeStore(h.ports);
    const seen = track(store);
    const disconnect = store.connect();
    disconnect();
    h.emitChanged(KEY);
    await settle();
    expect(h.listenerCount()).toBe(0);
    expect(seen).toEqual([]);
  });
});

describe('terminal font size store — failed save (AC14)', () => {
  it.each([['settings stepper', 16], ['zoom key', 15]])(
    'reverts to the stored value and reports once when a %s save fails',
    async (_source, next) => {
      const h = harness(14);
      const store = await connected(h);
      const failure = new Error('disk full');
      h.save.mockRejectedValueOnce(failure);
      store.setSize(next);
      expect(store.getSnapshot().size).toBe(next);
      await settle();
      expect(store.getSnapshot()).toEqual({ size: 14, ready: true });
      expect(h.notifySaveFailed).toHaveBeenCalledTimes(1);
      expect(h.notifySaveFailed).toHaveBeenCalledWith(FONT_COPY.terminalSizeSaveFailed);
      expect(h.reportError).toHaveBeenCalledWith(expect.any(String), failure);
      expect(h.save).toHaveBeenCalledTimes(1);
    },
  );
});
