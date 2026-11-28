// @vitest-environment jsdom

/** Exercises the Ghostty adapter using the vendor's public terminal and event boundary. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GespenstTerminalOptions } from '@gespenst/xterm';
import type { ILink, ILinkProvider } from '@xterm/xterm';
import type { Appearance, GhosttyView } from '@renderer/terminal/ghostty-view-engine';
import { GHOSTTY_HOST_ATTRIBUTE } from '@shared/terminal-engine';

const vendor = vi.hoisted(() => ({
  create: vi.fn<(options: GespenstTerminalOptions) => ReturnType<typeof fakeTerminal>['terminal']>(),
  preload: vi.fn(),
  vt: new Uint8Array([1]),
  callbacks: new Uint8Array([2]),
}));

vi.mock('@gespenst/xterm', () => ({
  Terminal: function Terminal(options: GespenstTerminalOptions) { return vendor.create(options); },
  preloadXtermRuntime: vendor.preload,
}));
vi.mock('@gespenst/xterm/css/xterm.css', () => ({}));
vi.mock('virtual:metaide-ghostty-vt', () => ({ default: vendor.vt }));
vi.mock('virtual:metaide-ghostty-callbacks', () => ({ default: vendor.callbacks }));

const appearance: Appearance = { cols: 80, rows: 24, fontSize: 13, cursorStyle: 'bar' };
const runtime = { wasm: { module: 'VT' }, callbacksWasm: { module: 'callbacks' } };

type InputHandler = Parameters<typeof import('@renderer/terminal/ghostty-view-engine').openGhosttyView>[3]['input'];
interface NativeEvents {
  error: Error;
  renderer: { backend: string };
  font: undefined;
  input: { data: Uint8Array; source: Parameters<InputHandler>[1] };
  viewportChange: undefined;
}

function channel<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    subscribe: vi.fn((listener: (value: T) => void) => {
      listeners.add(listener);
      return { dispose: vi.fn(() => { listeners.delete(listener); }) };
    }),
    emit(value: T) { listeners.forEach(listener => listener(value)); },
  };
}

function textRow(text: string) {
  return {
    isWrapped: false,
    length: text.length,
    translateToString: () => text,
    getCell(col: number) {
      const chars = text[col];
      return chars === undefined ? undefined : { getChars: () => chars, getWidth: () => 1 };
    },
  };
}

function fakeTerminal(delayMount: boolean) {
  const element = document.createElement('div');
  const textarea = document.createElement('textarea');
  const events: { [K in keyof NativeEvents]: ReturnType<typeof channel<NativeEvents[K]>> } = {
    error: channel<Error>(), renderer: channel<NativeEvents['renderer']>(), font: channel<undefined>(),
    input: channel<NativeEvents['input']>(), viewportChange: channel<undefined>(),
  };
  const bufferChanges = channel<undefined>();
  const renders = channel<{ start: number; end: number }>();
  const lines: string[] = [];
  const backdrop: { index?: number } = {};
  const active = {
    type: 'normal', viewportY: 0,
    get length() { return lines.length; },
    getLine(row: number) {
      const index = backdrop.index;
      if (index !== undefined) return {
        ...textRow(''),
        getCell: () => ({ isInverse: () => 0, isBgRGB: () => false, isBgPalette: () => true, getBgColor: () => index }),
      };
      const text = lines[row];
      return text === undefined ? undefined : textRow(text);
    },
  };
  const native = {
    element,
    renderer: { backend: 'webgl2' },
    geometry: { cols: 80, rows: 24, cellWidthPx: 8, cellHeightPx: 16, widthPx: 640, heightPx: 384 },
    writeAsync: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
    readViewport: vi.fn<() => Promise<{ colors: { palette: Readonly<Record<number, { r: number; g: number; b: number }>> } }>>(),
    fit: vi.fn(), paste: vi.fn(), focus: vi.fn(), sendPointer: vi.fn(),
    on<T extends keyof NativeEvents>(type: T, listener: (value: NativeEvents[T]) => void) {
      return events[type].subscribe(listener);
    },
  };
  const linkRegistration = { dispose: vi.fn() };
  const terminal = {
    buffer: { active, onBufferChange: bufferChanges.subscribe },
    cols: 80, rows: 24, onRender: renders.subscribe,
    ready: Promise.resolve(),
    native: Promise.resolve(native),
    textarea,
    options: {} satisfies GespenstTerminalOptions,
    open: vi.fn((host: HTMLElement) => {
      host.append(element);
      if (!delayMount) element.append(textarea);
    }),
    dispose: vi.fn(() => { element.remove(); }),
    focus: vi.fn(),
    scrollToBottom: vi.fn(),
    scrollToLine: vi.fn<(row: number) => void>(),
    hasSelection: vi.fn(() => true),
    getSelection: vi.fn(() => 'selection'),
    clearSelection: vi.fn(),
    write: vi.fn((_data: string, parsed?: () => void) => { parsed?.(); }),
    attachCustomKeyEventHandler: vi.fn<(handler: (event: KeyboardEvent) => boolean) => void>(),
    registerLinkProvider: vi.fn<(provider: ILinkProvider) => typeof linkRegistration>(() => linkRegistration),
  };
  return { terminal, native, textarea, lines, active, events, bufferChanges, linkRegistration, renders, backdrop };
}

const cleanup: Array<() => void> = [];

function setup(delayMount = false) {
  const host = document.body.appendChild(document.createElement('div'));
  const size = { width: 640, height: 384 };
  Object.defineProperties(host, {
    clientWidth: { get: () => size.width }, clientHeight: { get: () => size.height },
  });
  const controller = new AbortController();
  cleanup.push(() => { controller.abort(); host.remove(); });
  const fake = fakeTerminal(delayMount);
  vendor.create.mockImplementationOnce((options) => { fake.terminal.options = options; return fake.terminal; });
  const handlers = { fault: vi.fn(), layoutChanged: vi.fn(), input: vi.fn<InputHandler>() };
  async function open(): Promise<GhosttyView> {
    const { openGhosttyView } = await import('@renderer/terminal/ghostty-view-engine');
    return openGhosttyView(host, appearance, controller.signal, handlers);
  }
  return { ...fake, host, size, controller, handlers, open };
}

function observeFrame() {
  const next = Promise.withResolvers<FrameRequestCallback>();
  const request = vi.fn((callback: FrameRequestCallback) => { next.resolve(callback); return 5; });
  const cancel = vi.fn();
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', cancel);
  return { next: next.promise, cancel };
}

function interaction(platform: 'mac' | 'linux' = 'linux') {
  return {
    platform, keys: vi.fn(() => false), openWebLink: vi.fn(), openHyperlink: vi.fn(),
    focused: vi.fn(), paintBackdrop: vi.fn(),
  };
}

beforeEach(() => {
  vi.resetModules();
  vendor.create.mockReset();
  vendor.preload.mockReset().mockResolvedValue(runtime);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('terminal unit tests must not fetch'); }));
});

afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Ghostty view startup and shutdown', () => {
  it('uses the two preloads, reuses the compiled runtime and waits for connected DOM and first paint', async () => {
    const first = setup(true);
    const frame = observeFrame();
    const paint = Promise.withResolvers<undefined>();
    const painting = Promise.withResolvers<undefined>();
    first.native.writeAsync.mockImplementationOnce(() => { painting.resolve(undefined); return paint.promise; });
    const opening = first.open();
    const opened = vi.fn();
    void opening.then(opened, opened);
    const mount = await frame.next;
    expect(first.host.getAttribute(GHOSTTY_HOST_ATTRIBUTE)).toBe('ghostty');
    expect(first.terminal.open.mock.calls).toEqual([[first.host]]);
    expect(first.native.writeAsync).not.toHaveBeenCalled();
    expect(vendor.preload.mock.calls).toEqual([[{ wasm: vendor.vt, callbacksWasm: vendor.callbacks }]]);
    expect(vendor.create).toHaveBeenCalledWith(expect.objectContaining({
      ...appearance, allowTransparency: true, scrollback: 12_000,
      gespenst: { ...runtime, worker: false, renderer: 'webgl2' },
      linkHandler: expect.objectContaining({ allowNonHttpProtocols: false }),
    }));

    first.native.element.append(first.textarea);
    mount(16);
    await painting.promise;
    expect(first.native.writeAsync.mock.calls).toEqual([['']]);
    expect(opened).not.toHaveBeenCalled();
    paint.resolve(undefined);
    const view = await opening;
    expect(view.surface.buffer).toBe(first.terminal.buffer);
    await setup().open();
    expect(vendor.preload).toHaveBeenCalledOnce();
  });

  it.each(['backend', 'cell width', 'cell height', 'host width', 'host height'])('rejects an invalid first paint (%s) and cleans up', async (invalid) => {
    const { native, size, host, terminal, events, bufferChanges, handlers, open } = setup();
    if (invalid === 'backend') native.renderer.backend = 'canvas';
    if (invalid === 'cell width') native.geometry.cellWidthPx = 0;
    if (invalid === 'cell height') native.geometry.cellHeightPx = 0;
    if (invalid === 'host width') size.width = 0;
    if (invalid === 'host height') size.height = 0;
    await expect(open()).rejects.toThrow('Ghostty renderer failed its mount or paint check');
    expect(native.writeAsync).toHaveBeenCalledWith('');
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(host.hasAttribute(GHOSTTY_HOST_ATTRIBUTE)).toBe(false);
    events.font.emit(undefined);
    bufferChanges.emit(undefined);
    expect(handlers.layoutChanged).not.toHaveBeenCalled();
  });

  it('does not construct a terminal when already aborted or aborted during runtime preload', async () => {
    const first = setup();
    first.controller.abort();
    await expect(first.open()).rejects.toBe(first.controller.signal.reason);
    expect(vendor.preload).not.toHaveBeenCalled();

    const second = setup();
    const preload = Promise.withResolvers<typeof runtime>();
    const started = Promise.withResolvers<undefined>();
    vendor.preload.mockImplementationOnce(() => { started.resolve(undefined); return preload.promise; });
    const opening = second.open();
    await started.promise;
    second.controller.abort();
    await expect(opening).rejects.toBe(second.controller.signal.reason);
    preload.resolve(runtime);
    expect(vendor.create).not.toHaveBeenCalled();
    expect(second.host.hasAttribute(GHOSTTY_HOST_ATTRIBUTE)).toBe(false);
  });

  it('cancels a scheduled mount frame and disposes when aborted before the textarea connects', async () => {
    const { terminal, native, controller, host, open } = setup(true);
    const frame = observeFrame();
    const opening = open();
    await frame.next;
    controller.abort();
    await expect(opening).rejects.toBe(controller.signal.reason);
    expect(frame.cancel.mock.calls).toEqual([[5]]);
    expect(native.writeAsync).not.toHaveBeenCalled();
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(host.hasAttribute(GHOSTTY_HOST_ATTRIBUTE)).toBe(false);
  });

  it('rejects a setup fault even if the initial write resolves with a valid renderer', async () => {
    const { native, events, terminal, handlers, host, open } = setup();
    native.writeAsync.mockImplementationOnce(async () => { events.error.emit(new Error('setup fault')); });
    await expect(open()).rejects.toThrow('Ghostty renderer faulted during setup');
    expect(handlers.fault).toHaveBeenCalledOnce();
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(host.hasAttribute(GHOSTTY_HOST_ATTRIBUTE)).toBe(false);
  });
});

describe('Ghostty view adapter', () => {
  it('coalesces Ghostty renders and resolves the edge color from its native palette', async () => {
    const { native, renders, active, backdrop, open } = setup();
    const view = await open();
    const interactionHandlers = interaction();
    view.reveal(interactionHandlers);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    native.readViewport.mockResolvedValue({ colors: { palette: { 232: { r: 13, g: 13, b: 14 } } } });
    active.type = 'alternate';
    backdrop.index = 232;
    renders.emit({ start: 0, end: 23 });
    renders.emit({ start: 0, end: 23 });
    expect(native.readViewport).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(125);
    expect(native.readViewport).toHaveBeenCalledOnce();
    expect(interactionHandlers.paintBackdrop.mock.calls).toEqual([['#0d0d0e']]);

    backdrop.index = 233;
    native.readViewport.mockRejectedValueOnce(new Error('viewport no longer available'));
    renders.emit({ start: 0, end: 23 });
    await vi.advanceTimersByTimeAsync(125);
    expect(interactionHandlers.paintBackdrop.mock.calls).toEqual([['#0d0d0e'], [undefined]]);
  });

  it('does not apply a Ghostty palette read after the view has been disposed', async () => {
    const { native, active, backdrop, open } = setup();
    const view = await open();
    const interactionHandlers = interaction();
    const palette = Promise.withResolvers<Awaited<ReturnType<typeof native.readViewport>>>();
    native.readViewport.mockReturnValue(palette.promise);
    active.type = 'alternate';
    backdrop.index = 232;
    view.reveal(interactionHandlers);
    expect(native.readViewport).toHaveBeenCalledOnce();
    view.dispose();
    palette.resolve({ colors: { palette: { 232: { r: 13, g: 13, b: 14 } } } });
    await palette.promise;
    await Promise.resolve();
    expect(interactionHandlers.paintBackdrop.mock.calls).toEqual([[undefined]]);
  });

  it('preserves input provenance and parser completion, and normalizes paste without reading a clipboard', async () => {
    const { terminal, native, events, bufferChanges, handlers, open } = setup();
    const view = await open();
    const encoder = new TextEncoder();
    const parsed = vi.fn();
    terminal.write.mockImplementationOnce((_data, complete) => {
      events.input.emit({ source: 'reply', data: encoder.encode('\u001b[?1;2c') });
      events.input.emit({ source: 'text', data: encoder.encode('界💡') });
      complete?.();
    });
    view.write('output', parsed);
    expect(terminal.write.mock.calls).toEqual([['output', parsed]]);
    expect(parsed).toHaveBeenCalledOnce();
    expect(handlers.input.mock.calls).toEqual([['\u001b[?1;2c', 'reply'], ['界💡', 'text']]);

    expect(view.surface.hasSelection()).toBe(true);
    expect(view.surface.getSelection()).toBe('selection');
    view.surface.clearSelection();
    view.surface.focus();
    view.focus();
    expect(terminal.focus).toHaveBeenCalledTimes(2);
    terminal.clearSelection.mockClear();
    view.surface.paste('line 1\r\nline 2\nline 3\r');
    expect(terminal.scrollToBottom).not.toHaveBeenCalled();
    Object.assign(terminal.options, { scrollOnUserInput: true });
    view.surface.paste('line 4\n');
    expect(native.paste.mock.calls).toEqual([['line 1\rline 2\rline 3\r'], ['line 4\r']]);
    expect(terminal.clearSelection).toHaveBeenCalledTimes(2);
    expect(terminal.scrollToBottom).toHaveBeenCalledOnce();
    events.font.emit(undefined);
    bufferChanges.emit(undefined);
    expect(handlers.layoutChanged).toHaveBeenCalledTimes(2);
  });

  it('fits only measurable panes, publishes alternate-buffer state and applies live appearance', async () => {
    const { size, native, active, host, terminal, open } = setup();
    const view = await open();
    size.width = 19;
    expect(view.fit()).toBeUndefined();
    size.width = 20;
    size.height = 19;
    expect(view.fit()).toBeUndefined();
    expect(native.fit).not.toHaveBeenCalled();

    size.height = 20;
    active.type = 'alternate';
    native.fit.mockImplementationOnce(() => { native.geometry.cols = 5; native.geometry.rows = 2; });
    expect(view.fit()).toMatchObject({ cols: 5, rows: 2 });
    expect(host.hasAttribute('data-terminal-alternate')).toBe(true);
    active.type = 'normal';
    expect(view.fit()).toMatchObject({ cols: 5, rows: 2 });
    expect(host.hasAttribute('data-terminal-alternate')).toBe(false);
    expect(native.fit).toHaveBeenCalledTimes(2);

    const changed: Appearance = { fontSize: 18, fontFamily: 'monospace', cursorBlink: true };
    view.applyAppearance(changed);
    expect(terminal.options).toMatchObject(changed);
  });

  it('connects keyboard, focus, web and optional file links only on reveal; disconnects on abort', async () => {
    const { native, terminal, textarea, lines, linkRegistration, host, controller, handlers, open } = setup();
    const text = 'https://example.test/demo, ./a.txt';
    lines.push(text, 'plain');
    const view = await open();
    expect(terminal.registerLinkProvider).not.toHaveBeenCalled();
    const onFile = vi.fn();
    const start = text.indexOf('./');
    const pathLinks = vi.fn((line: string) => line === text ? [{ start, end: text.length, text: './a.txt', activate: onFile }] : []);
    const handlersMac = interaction('mac');
    const addPointerListener = vi.spyOn(native.element, 'addEventListener');
    view.reveal({ ...handlersMac, pathLinks });
    expect(addPointerListener).toHaveBeenCalledWith('pointerdown', expect.any(Function), expect.objectContaining({ capture: true }));
    expect(terminal.attachCustomKeyEventHandler.mock.calls).toEqual([[handlersMac.keys]]);
    textarea.dispatchEvent(new FocusEvent('focus'));
    expect(handlersMac.focused).toHaveBeenCalledOnce();

    const provider = terminal.registerLinkProvider.mock.calls[0]?.[0];
    const links = vi.fn<(result: ILink[] | undefined) => void>();
    provider?.provideLinks(1, links);
    expect(pathLinks.mock.calls).toEqual([[text]]);
    const [web, file] = links.mock.calls[0]?.[0] ?? [];
    expect(web?.text).toBe('https://example.test/demo');
    expect(file?.range).toEqual({ start: { x: start + 1, y: 1 }, end: { x: text.length, y: 1 } });
    expect(handlersMac.openWebLink).not.toHaveBeenCalled();
    const click = new MouseEvent('click');
    if (!web || !file) throw new Error('expected web and file links');
    web.activate(click, web.text);
    file.activate(click, file.text);
    expect(handlersMac.openWebLink.mock.calls).toEqual([['https://example.test/demo']]);
    expect(onFile.mock.calls).toEqual([[click, './a.txt']]);
    provider?.provideLinks(2, links);
    expect(links).toHaveBeenLastCalledWith(undefined);

    view.find.step('demo', 1);
    expect(host.querySelector('[data-terminal-find] span')).not.toBeNull();
    controller.abort();
    view.dispose();
    textarea.dispatchEvent(new FocusEvent('focus'));
    host.dispatchEvent(new Event('webglcontextlost'));
    await Promise.resolve();
    expect(handlersMac.focused).toHaveBeenCalledOnce();
    expect(handlers.fault).not.toHaveBeenCalled();
    expect(linkRegistration.dispose).toHaveBeenCalledOnce();
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-terminal-find]')).toBeNull();
    expect(host.hasAttribute(GHOSTTY_HOST_ATTRIBUTE)).toBe(false);
  });

  it('routes OSC-8 hyperlink clicks through the interaction handler attached on reveal', async () => {
    const { open, host } = setup();
    const view = await open();
    const handlers = interaction();
    view.reveal(handlers);
    const options = vendor.create.mock.calls[0]?.[0];
    expect(options?.linkHandler?.activate).toBeTypeOf('function');
    const range = { start: { x: 1, y: 1 }, end: { x: 7, y: 1 } };
    options?.linkHandler?.activate(new MouseEvent('click'), 'https://example.test/preview', range);
    expect(handlers.openHyperlink.mock.calls).toEqual([['https://example.test/preview']]);
    view.dispose();
    options?.linkHandler?.activate(new MouseEvent('click'), 'https://after-dispose', range);
    expect(handlers.openHyperlink.mock.calls).toEqual([['https://example.test/preview']]);
    expect(host.hasAttribute(GHOSTTY_HOST_ATTRIBUTE)).toBe(false);
  });

  it('uses the live viewport to repaint find highlights without requesting pointer selection', async () => {
    const { active, native, events, host, lines, terminal, open } = setup();
    const view = await open();
    native.geometry.rows = 1;
    lines.push('plain', 'a hit');
    const other = interaction();
    const addPointerListener = vi.spyOn(native.element, 'addEventListener');
    view.reveal(other);
    expect(addPointerListener).not.toHaveBeenCalled();
    const links = vi.fn();
    terminal.registerLinkProvider.mock.calls[0]?.[0].provideLinks(1, links);
    expect(links.mock.calls).toEqual([[undefined]]);

    view.find.step('hit', 1);
    expect(terminal.scrollToLine.mock.calls).toEqual([[1]]);
    expect(host.querySelector('[data-terminal-find] span')).toBeNull();
    active.viewportY = 1;
    events.viewportChange.emit(undefined);
    const mark = host.querySelector<HTMLElement>('[data-terminal-find] span');
    expect(mark?.style.left).toBe('16px');
    expect(mark?.style.width).toBe('24px');
    expect(native.sendPointer).not.toHaveBeenCalled();
    expect(terminal.clearSelection).not.toHaveBeenCalled();
    view.find.clear();
    expect(host.querySelector('[data-terminal-find]')).toBeNull();
  });

  it.each(['write', 'fit', 'renderer fallback', 'context loss', 'logger'])('defers and deduplicates fault recovery from %s', async (source) => {
    const { active, native, events, terminal, handlers, host, open } = setup();
    const view = await open();
    events.renderer.emit({ backend: 'webgl2' });
    expect(handlers.fault).not.toHaveBeenCalled();
    if (source === 'write') {
      terminal.write.mockImplementationOnce(() => { throw new Error('write fault'); });
      view.write('live output');
    }
    if (source === 'fit') {
      active.type = 'alternate';
      native.fit.mockImplementationOnce(() => { throw new Error('fit fault'); });
      expect(view.fit()).toBeUndefined();
      expect(host.hasAttribute('data-terminal-alternate')).toBe(true);
    }
    if (source === 'renderer fallback') events.renderer.emit({ backend: 'canvas' });
    if (source === 'context loss') native.element.dispatchEvent(new Event('webglcontextlost'));
    if (source === 'logger') vendor.create.mock.calls[0]?.[0].logger?.error('native logger fault');

    expect(handlers.fault).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(handlers.fault).toHaveBeenCalledOnce();
    events.error.emit(new Error('secondary error'));
    events.input.emit({ source: 'key', data: new Uint8Array([120]) });
    vendor.create.mock.calls[0]?.[0].logger?.error('secondary logger error');
    const previousOptions = terminal.options;
    terminal.write.mockClear();
    native.fit.mockClear();
    view.write('blocked');
    view.surface.paste('blocked');
    expect(view.fit()).toBeUndefined();
    view.applyAppearance({ fontSize: 97 });
    view.reveal(interaction());
    view.focus();
    await Promise.resolve();
    expect(handlers.fault).toHaveBeenCalledOnce();
    expect(handlers.input).not.toHaveBeenCalled();
    expect(terminal.write).not.toHaveBeenCalled();
    expect(native.paste).not.toHaveBeenCalled();
    expect(native.fit).not.toHaveBeenCalled();
    expect(terminal.options).toBe(previousOptions);
    expect(terminal.registerLinkProvider).not.toHaveBeenCalled();
    expect(terminal.focus).not.toHaveBeenCalled();
    view.dispose();
    expect(host.hasAttribute('data-terminal-alternate')).toBe(false);
  });

  it('suppresses a queued fault after disposal and ignores later work', async () => {
    const { terminal, native, host, events, handlers, open } = setup();
    const view = await open();
    events.error.emit(new Error('unmounted before recovery'));
    view.dispose();
    view.dispose();
    await Promise.resolve();
    expect(handlers.fault).not.toHaveBeenCalled();
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(host.hasAttribute(GHOSTTY_HOST_ATTRIBUTE)).toBe(false);
    view.write('ignored');
    view.surface.paste('ignored');
    expect(view.fit()).toBeUndefined();
    expect(terminal.write).not.toHaveBeenCalled();
    expect(native.paste).not.toHaveBeenCalled();
  });
});
