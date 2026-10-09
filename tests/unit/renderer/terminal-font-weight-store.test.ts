/** Contract tests for the per-window terminal weight store (normal + bold pair): load with default and invalid fallback, optimistic sets with derived bold, bold validity, refresh ordering, cross-window sync and failure revert. */
import { describe, expect, it, vi } from 'vitest';
import { FONT_COPY } from '@renderer/fonts/font-contract';
import {
  createTerminalFontWeightStore,
  type StoredTerminalWeights,
  type TerminalFontWeightPorts,
  type TerminalFontWeightSnapshot,
} from '@renderer/fonts/terminal-font-weight-store';
import type { TerminalFontWeight } from '@shared/terminal-font-weight';

const WEIGHT_KEY = 'terminal_font_weight';
const BOLD_KEY = 'terminal_bold_weight';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type SaveFn = (value: TerminalFontWeight) => Promise<unknown>;

interface Harness {
  readonly ports: TerminalFontWeightPorts;
  readonly loadStored: ReturnType<typeof vi.fn<() => Promise<StoredTerminalWeights>>>;
  readonly saveWeight: ReturnType<typeof vi.fn<SaveFn>>;
  readonly saveBoldWeight: ReturnType<typeof vi.fn<SaveFn>>;
  readonly notifySaveFailed: ReturnType<typeof vi.fn<(message: string) => void>>;
  readonly reportError: ReturnType<typeof vi.fn<(context: string, error: unknown) => void>>;
  setStored(weight: unknown, boldWeight: unknown): void;
  emitChanged(key: string): void;
  listenerCount(): number;
}

function harness(weight: unknown, boldWeight: unknown = null): Harness {
  let stored: StoredTerminalWeights = { weight, boldWeight };
  const listeners = new Set<(key: string) => void>();
  const loadStored = vi.fn(async (): Promise<StoredTerminalWeights> => stored);
  const saveWeight = vi.fn(async (value: TerminalFontWeight): Promise<unknown> => {
    stored = { weight: value, boldWeight: Math.min(value + 200, 900) };
    return undefined;
  });
  const saveBoldWeight = vi.fn(async (value: TerminalFontWeight): Promise<unknown> => {
    stored = { ...stored, boldWeight: value };
    return undefined;
  });
  const notifySaveFailed = vi.fn<(message: string) => void>();
  const reportError = vi.fn<(context: string, error: unknown) => void>();
  const ports: TerminalFontWeightPorts = {
    loadStored,
    saveWeight,
    saveBoldWeight,
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
    saveWeight,
    saveBoldWeight,
    notifySaveFailed,
    reportError,
    setStored: (w, b) => {
      stored = { weight: w, boldWeight: b };
    },
    emitChanged: (key) => listeners.forEach((listener) => listener(key)),
    listenerCount: () => listeners.size,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function track(store: { subscribe(listener: () => void): () => void; getSnapshot(): TerminalFontWeightSnapshot }): TerminalFontWeightSnapshot[] {
  const seen: TerminalFontWeightSnapshot[] = [];
  store.subscribe(() => seen.push(store.getSnapshot()));
  return seen;
}

async function connected(h: Harness): Promise<ReturnType<typeof createTerminalFontWeightStore>> {
  const store = createTerminalFontWeightStore(h.ports);
  store.connect();
  await settle();
  return store;
}

function expectNoSaves(h: Harness): void {
  expect(h.saveWeight).not.toHaveBeenCalled();
  expect(h.saveBoldWeight).not.toHaveBeenCalled();
}

describe('terminal weight store — load', () => {
  it('starts at 400/700 and not ready', () => {
    const store = createTerminalFontWeightStore(harness(800, 900).ports);
    expect(store.getSnapshot()).toEqual({ weight: 400, boldWeight: 700, ready: false });
  });

  it('becomes ready at 400/700 with no write and no error when nothing is stored (AC3)', async () => {
    const h = harness(null, null);
    const store = await connected(h);
    expect(store.getSnapshot()).toEqual({ weight: 400, boldWeight: 700, ready: true });
    expectNoSaves(h);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it('publishes a valid stored pair once, without writing', async () => {
    const h = harness(300, 600);
    const store = createTerminalFontWeightStore(h.ports);
    const seen = track(store);
    store.connect();
    await settle();
    expect(seen).toEqual([{ weight: 300, boldWeight: 600, ready: true }]);
    expectNoSaves(h);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it.each([
    ['800 with no bold', 800, null, { weight: 800, boldWeight: 900 }, 0],
    ['900 with no bold', 900, null, { weight: 900, boldWeight: 900 }, 0],
    ['invalid weight 450 with valid bold 500', 450, 500, { weight: 400, boldWeight: 500 }, 1],
    ['bold not heavier than weight', 500, 500, { weight: 500, boldWeight: 700 }, 1],
    ['both invalid', 'bold', 1000, { weight: 400, boldWeight: 700 }, 2],
    ['bold below weight 800', 800, 700, { weight: 800, boldWeight: 900 }, 1],
  ] as const)('resolves %s, reports each error once and never writes (AC9)', async (_name, weight, bold, expected, errors) => {
    const h = harness(weight, bold);
    const store = await connected(h);
    expect(store.getSnapshot()).toEqual({ ...expected, ready: true });
    expect(h.reportError).toHaveBeenCalledTimes(errors);
    expectNoSaves(h);
  });

  it('becomes ready at the defaults and reports the error when the stored pair cannot be loaded', async () => {
    const h = harness(null);
    const failure = new Error('ipc down');
    h.loadStored.mockRejectedValueOnce(failure);
    const store = await connected(h);
    expect(store.getSnapshot()).toEqual({ weight: 400, boldWeight: 700, ready: true });
    expect(h.reportError).toHaveBeenCalledWith(expect.any(String), failure);
  });
});

describe('terminal weight store — setWeight', () => {
  it('applies the weight with bold 200 heavier synchronously, then saves only the weight (AC2, AC4)', async () => {
    const h = harness(400, 700);
    const store = await connected(h);
    store.setWeight(500);
    expect(store.getSnapshot()).toEqual({ weight: 500, boldWeight: 700, ready: true });
    expect(h.saveWeight).toHaveBeenCalledTimes(1);
    expect(h.saveWeight).toHaveBeenCalledWith(500);
    expect(h.saveBoldWeight).not.toHaveBeenCalled();
  });

  it.each([[300, 500], [700, 900], [900, 900]] as const)(
    'resets a hand-set bold of 900 when the weight becomes %i (bold %i) (AC4)',
    async (weight, bold) => {
      const h = harness(400, 900);
      const store = await connected(h);
      store.setWeight(weight);
      expect(store.getSnapshot()).toEqual({ weight, boldWeight: bold, ready: true });
    },
  );

  it('is a no-op without IPC when asked for the current weight (AC2)', async () => {
    const h = harness(500, 900);
    const store = await connected(h);
    const seen = track(store);
    store.setWeight(500);
    await settle();
    expectNoSaves(h);
    expect(seen).toEqual([]);
  });

  it('ignores setWeight before the stored pair has loaded', () => {
    const h = harness(700, 900);
    const store = createTerminalFontWeightStore(h.ports);
    store.setWeight(300);
    expectNoSaves(h);
    expect(store.getSnapshot()).toEqual({ weight: 400, boldWeight: 700, ready: false });
  });

  it('drops a stale refresh that resolves after a newer setWeight', async () => {
    const h = harness(400, 700);
    const store = await connected(h);
    const stale = deferred<StoredTerminalWeights>();
    h.loadStored.mockReturnValueOnce(stale.promise);
    h.emitChanged(WEIGHT_KEY);
    store.setWeight(800);
    stale.resolve({ weight: 200, boldWeight: 400 });
    await settle();
    expect(store.getSnapshot()).toEqual({ weight: 800, boldWeight: 900, ready: true });
  });
});

describe('terminal weight store — setBoldWeight', () => {
  it('applies a heavier bold synchronously, then saves only the bold weight (AC4)', async () => {
    const h = harness(400, 700);
    const store = await connected(h);
    store.setBoldWeight(900);
    expect(store.getSnapshot()).toEqual({ weight: 400, boldWeight: 900, ready: true });
    expect(h.saveBoldWeight).toHaveBeenCalledTimes(1);
    expect(h.saveBoldWeight).toHaveBeenCalledWith(900);
    expect(h.saveWeight).not.toHaveBeenCalled();
  });

  it.each([
    ['the current bold', 400, 700, 700],
    ['a bold equal to the weight', 400, 700, 400],
    ['a bold lighter than the weight', 600, 800, 500],
    ['a lighter bold at weight 900', 900, 900, 800],
  ] as const)('is a no-op without IPC for %s (AC1, AC2)', async (_name, weight, bold, next) => {
    const h = harness(weight, bold);
    const store = await connected(h);
    const seen = track(store);
    store.setBoldWeight(next);
    await settle();
    expectNoSaves(h);
    expect(seen).toEqual([]);
  });

  it('ignores setBoldWeight before the stored pair has loaded', () => {
    const h = harness(400, 700);
    const store = createTerminalFontWeightStore(h.ports);
    store.setBoldWeight(900);
    expectNoSaves(h);
    expect(store.getSnapshot()).toEqual({ weight: 400, boldWeight: 700, ready: false });
  });

  it('drops a stale refresh that resolves after a newer setBoldWeight', async () => {
    const h = harness(400, 700);
    const store = await connected(h);
    const stale = deferred<StoredTerminalWeights>();
    h.loadStored.mockReturnValueOnce(stale.promise);
    h.emitChanged(BOLD_KEY);
    store.setBoldWeight(800);
    stale.resolve({ weight: 400, boldWeight: 600 });
    await settle();
    expect(store.getSnapshot()).toEqual({ weight: 400, boldWeight: 800, ready: true });
  });
});

describe('terminal weight store — settings:changed (AC11)', () => {
  it.each([[WEIGHT_KEY], [BOLD_KEY]])('re-reads and publishes the stored pair when %s changes in another window', async (key) => {
    const h = harness(400, 700);
    const store = await connected(h);
    h.setStored(600, 900);
    h.emitChanged(key);
    await settle();
    expect(store.getSnapshot()).toEqual({ weight: 600, boldWeight: 900, ready: true });
  });

  it('does not notify again when the broadcasts echo this window\'s own save', async () => {
    const h = harness(400, 700);
    const store = await connected(h);
    const seen = track(store);
    store.setWeight(300);
    await settle();
    h.emitChanged(WEIGHT_KEY);
    h.emitChanged(BOLD_KEY);
    await settle();
    expect(seen).toEqual([{ weight: 300, boldWeight: 500, ready: true }]);
  });

  it('ignores changes to other settings keys', async () => {
    const h = harness(400, 700);
    await connected(h);
    h.loadStored.mockClear();
    h.emitChanged('terminal_font_size');
    await settle();
    expect(h.loadStored).not.toHaveBeenCalled();
  });

  it('stops listening and publishing after disconnect', async () => {
    const h = harness(700, 900);
    const store = createTerminalFontWeightStore(h.ports);
    const seen = track(store);
    const disconnect = store.connect();
    disconnect();
    h.emitChanged(WEIGHT_KEY);
    await settle();
    expect(h.listenerCount()).toBe(0);
    expect(seen).toEqual([]);
  });

  it('does not publish the revert of a save that fails after disconnect', async () => {
    const h = harness(400, 700);
    const store = createTerminalFontWeightStore(h.ports);
    const disconnect = store.connect();
    await settle();
    const save = deferred<unknown>();
    h.saveWeight.mockReturnValueOnce(save.promise.then(() => Promise.reject(new Error('disk full'))));
    store.setWeight(700);
    const seen = track(store);
    disconnect();
    save.resolve(undefined);
    await settle();
    expect(seen).toEqual([]);
    expect(store.getSnapshot()).toEqual({ weight: 700, boldWeight: 900, ready: true });
  });
});

describe('terminal weight store — failed save (AC10)', () => {
  it('reverts both values after a failed weight save, toasts the weight copy once and reports the cause', async () => {
    const h = harness(400, 700);
    const store = await connected(h);
    const failure = new Error('disk full');
    h.saveWeight.mockRejectedValueOnce(failure);
    store.setWeight(600);
    expect(store.getSnapshot()).toEqual({ weight: 600, boldWeight: 800, ready: true });
    await settle();
    expect(store.getSnapshot()).toEqual({ weight: 400, boldWeight: 700, ready: true });
    expect(h.notifySaveFailed).toHaveBeenCalledTimes(1);
    expect(h.notifySaveFailed).toHaveBeenCalledWith(FONT_COPY.terminalWeightSaveFailed);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledWith(expect.any(String), failure);
    expect(h.saveWeight).toHaveBeenCalledTimes(1);
  });

  it('reverts the bold weight after a failed bold save, toasts the bold copy once and reports the cause', async () => {
    const h = harness(400, 700);
    const store = await connected(h);
    const failure = new Error('disk full');
    h.saveBoldWeight.mockRejectedValueOnce(failure);
    store.setBoldWeight(800);
    expect(store.getSnapshot().boldWeight).toBe(800);
    await settle();
    expect(store.getSnapshot()).toEqual({ weight: 400, boldWeight: 700, ready: true });
    expect(h.notifySaveFailed).toHaveBeenCalledTimes(1);
    expect(h.notifySaveFailed).toHaveBeenCalledWith(FONT_COPY.terminalBoldSaveFailed);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledWith(expect.any(String), failure);
    expect(h.saveBoldWeight).toHaveBeenCalledTimes(1);
  });
});
