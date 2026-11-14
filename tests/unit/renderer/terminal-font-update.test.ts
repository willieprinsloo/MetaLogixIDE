/** Contract tests for in-place terminal font updates and geometry synchronization. */
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { TERMINAL_FONT_FALLBACK, TERMINAL_SYMBOL_FONT } from '@shared/font-settings';
import {
  createTerminalFontUpdater,
  createTerminalGeometrySynchronizer,
  type TerminalFontUpdatePort,
  type TerminalGeometrySynchronizer,
} from '@renderer/terminal-font-update';

interface Deferred {
  readonly promise: Promise<unknown>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  // ES2022 and Electron's Node 20 runtime do not provide Promise.withResolvers().
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

interface Harness {
  readonly terminal: TerminalFontUpdatePort;
  readonly events: string[];
  readonly reset: Mock;
  readonly dispose: Mock;
  readonly write: Mock;
  readonly clearSelection: Mock;
  readonly synchronize: TerminalGeometrySynchronizer;
}

function createHarness(): Harness {
  const events: string[] = [];
  let fontFamily = '';
  const reset = vi.fn();
  const dispose = vi.fn();
  const write = vi.fn();
  const clearSelection = vi.fn();
  const options = {
    get fontFamily(): string {
      return fontFamily;
    },
    set fontFamily(value: string) {
      fontFamily = value;
      events.push(`option:${value}`);
    },
    fontSize: 14,
  };
  const terminal = {
    options,
    cols: 80,
    rows: 24,
    clearTextureAtlas: () => events.push('atlas'),
    refresh: (start: number, end: number) => events.push(`refresh:${start}-${end}`),
    reset,
    dispose,
    write,
    clearSelection,
  };
  const synchronize = createTerminalGeometrySynchronizer({
    terminal,
    fit: { fit: () => events.push('fit') },
    dimensions: () => ({ width: 800, height: 480 }),
    resize: (cols, rows) => events.push(`resize:${cols}x${rows}`),
  });
  return {
    terminal,
    events,
    reset,
    dispose,
    write,
    clearSelection,
    synchronize,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createTerminalFontUpdater', () => {
  it('waits for readiness, then updates option, fit, refresh, and PTY dimensions in order', async () => {
    const harness = createHarness();
    const readiness = deferred();
    const updater = createTerminalFontUpdater({
      terminal: harness.terminal,
      synchronize: harness.synchronize,
      loadFont: () => readiness.promise,
      timeoutMs: 100,
    });

    const applied = updater.apply('Fira Code Nerd Font');
    expect(harness.events).toEqual([
      `option:"Fira Code Nerd Font", ${TERMINAL_FONT_FALLBACK}`,
    ]);

    readiness.resolve();
    await applied;

    expect(harness.events).toEqual([
      `option:"Fira Code Nerd Font", ${TERMINAL_FONT_FALLBACK}`,
      'fit',
      'atlas',
      'refresh:0-23',
      'resize:80x24',
    ]);
    expect(harness.reset).not.toHaveBeenCalled();
    expect(harness.dispose).not.toHaveBeenCalled();
    expect(harness.write).not.toHaveBeenCalled();
    expect(harness.clearSelection).not.toHaveBeenCalled();
  });

  it('fits with the selected stack after font readiness rejects', async () => {
    const harness = createHarness();
    const updater = createTerminalFontUpdater({
      terminal: harness.terminal,
      synchronize: harness.synchronize,
      loadFont: () => Promise.reject(new Error('font unavailable')),
      timeoutMs: 100,
    });

    await expect(updater.apply('Missing Font')).resolves.toBeUndefined();

    expect(harness.events).toEqual([
      `option:"Missing Font", ${TERMINAL_FONT_FALLBACK}`,
      'fit',
      'atlas',
      'refresh:0-23',
      'resize:80x24',
    ]);
  });

  it('bounds a font readiness wait and still fits on timeout', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const readiness = deferred();
    const updater = createTerminalFontUpdater({
      terminal: harness.terminal,
      synchronize: harness.synchronize,
      loadFont: () => readiness.promise,
      timeoutMs: 25,
    });

    const applied = updater.apply('Slow Font');
    await vi.advanceTimersByTimeAsync(24);
    expect(harness.events).toEqual([
      `option:"Slow Font", ${TERMINAL_FONT_FALLBACK}`,
    ]);

    await vi.advanceTimersByTimeAsync(1);
    await applied;

    expect(harness.events.slice(1)).toEqual([
      'fit',
      'atlas',
      'refresh:0-23',
      'resize:80x24',
    ]);
  });

  it('drops stale readiness completion during rapid family changes', async () => {
    const harness = createHarness();
    const first = deferred();
    const second = deferred();
    const loads = [first, second];
    const updater = createTerminalFontUpdater({
      terminal: harness.terminal,
      synchronize: harness.synchronize,
      loadFont: (specification) => specification.includes(TERMINAL_SYMBOL_FONT)
        ? Promise.resolve() : loads.shift()?.promise ?? Promise.resolve(),
      timeoutMs: 100,
    });

    const firstApply = updater.apply('First Font');
    const secondApply = updater.apply('Second Font');
    first.resolve();
    await firstApply;

    expect(harness.events).toEqual([
      `option:"First Font", ${TERMINAL_FONT_FALLBACK}`,
      `option:"Second Font", ${TERMINAL_FONT_FALLBACK}`,
    ]);

    second.resolve();
    await secondApply;
    expect(harness.events.slice(2)).toEqual([
      'fit',
      'atlas',
      'refresh:0-23',
      'resize:80x24',
    ]);
  });

  it('does not mutate terminal geometry after disposal', async () => {
    const harness = createHarness();
    const readiness = deferred();
    const updater = createTerminalFontUpdater({
      terminal: harness.terminal,
      synchronize: harness.synchronize,
      loadFont: () => readiness.promise,
      timeoutMs: 100,
    });

    const applied = updater.apply('Unmounted Font');
    updater.dispose();
    readiness.resolve();
    await applied;

    expect(harness.events).toEqual([
      `option:"Unmounted Font", ${TERMINAL_FONT_FALLBACK}`,
    ]);
    expect(harness.reset).not.toHaveBeenCalled();
    expect(harness.dispose).not.toHaveBeenCalled();
    expect(harness.write).not.toHaveBeenCalled();
    expect(harness.clearSelection).not.toHaveBeenCalled();
  });

  it('waits for bundled icon readiness on the default stack before fitting and repainting', async () => {
    const harness = createHarness();
    const icons = deferred();
    const updater = createTerminalFontUpdater({
      terminal: harness.terminal,
      synchronize: harness.synchronize,
      loadFont: () => icons.promise,
      timeoutMs: 100,
    });

    const applied = updater.apply(null);
    expect(harness.events).toEqual([`option:${TERMINAL_FONT_FALLBACK}`]);
    icons.resolve();
    await applied;
    expect(harness.events.slice(1)).toEqual([
      'fit',
      'atlas',
      'refresh:0-23',
      'resize:80x24',
    ]);
  });
});

describe('createTerminalGeometrySynchronizer', () => {
  it('skips zero-sized hosts and deduplicates unchanged observer resizes', () => {
    const harness = createHarness();
    let dimensions = { width: 0, height: 0 };
    const synchronize = createTerminalGeometrySynchronizer({
      terminal: harness.terminal,
      fit: { fit: () => harness.events.push('fit') },
      dimensions: () => dimensions,
      resize: (cols, rows) => harness.events.push(`resize:${cols}x${rows}`),
    });

    synchronize();
    dimensions = { width: 800, height: 480 };
    synchronize();
    synchronize();

    expect(harness.events).toEqual([
      'fit',
      'refresh:0-23',
      'resize:80x24',
      'fit',
      'refresh:0-23',
    ]);
  });

  it('forces PTY resize when a metric change keeps the same row and column count', () => {
    const harness = createHarness();

    harness.synchronize();
    harness.synchronize({ forceResize: true });

    expect(harness.events).toEqual([
      'fit',
      'refresh:0-23',
      'resize:80x24',
      'fit',
      'refresh:0-23',
      'resize:80x24',
    ]);
  });

  it('widens to the full-width columns for a full-screen app, and only ever widens', () => {
    const terminal = { options: {}, cols: 80, rows: 24, clearTextureAtlas() {}, refresh() {}, resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; } };
    const resizes: string[] = [];
    let wide: number | null = 81;
    const synchronize = createTerminalGeometrySynchronizer({
      terminal,
      fit: { fit: () => { terminal.cols = 80; } },
      dimensions: () => ({ width: 800, height: 480 }),
      resize: (cols, rows) => resizes.push(`${cols}x${rows}`),
      fullWidthCols: () => wide,
    });
    synchronize();
    expect(resizes).toEqual(['81x24']);
    wide = 79;
    synchronize();
    wide = null;
    synchronize({ forceResize: true });
    expect(resizes, 'never narrower than the fit; null keeps the fit result').toEqual(['81x24', '80x24', '80x24']);
  });
});
