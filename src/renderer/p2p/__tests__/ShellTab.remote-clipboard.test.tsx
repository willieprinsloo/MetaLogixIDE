// @vitest-environment jsdom
/**
 * Diagnosis repro for "paste / copy do not work in a fleet (remote) terminal". Drives the real
 * ShellTab + real useTerminalPaste against a remote source, with a fake xterm that models the
 * pieces under test: `paste` -> bracketed `onData`, selection, and an OSC dispatcher that only
 * calls handlers registered through `parser.registerOscHandler`.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@renderer/api', () => ({ api: { invoke: (...a: unknown[]) => invoke(...a), on: () => () => {}, platform: 'darwin' } }));

const fake = {
  dataCb: null as null | ((d: string) => void),
  osc: new Map<number, (data: string) => boolean | Promise<boolean>>(),
  selection: '',
  writes: [] as string[],
  opts: null as null | Record<string, unknown>,
};

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(opts: Record<string, unknown>) { fake.opts = opts; }
    unicode = { activeVersion: '' }; cols = 80; rows = 24; options: Record<string, unknown> = {};
    buffer = { active: { getLine: () => undefined, type: 'normal', baseY: 0 }, onBufferChange: () => ({ dispose() {} }) };
    parser = {
      registerOscHandler: (id: number, cb: (data: string) => boolean | Promise<boolean>) => {
        fake.osc.set(id, cb);
        return { dispose() { fake.osc.delete(id); } };
      },
    };
    loadAddon(addon: { activate?: (t: unknown) => void }) { addon.activate?.(this); }
    open() {} reset() {} dispose() {} focus() {} refresh() {} scrollToBottom() {} clearSelection() {}
    write(data: string, cb?: () => void) {
      fake.writes.push(data);
      for (const m of data.matchAll(/\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) void fake.osc.get(Number(m[1]))?.(m[2] ?? '');
      cb?.();
    }
    paste(text: string) { fake.dataCb?.(`\x1b[200~${text}\x1b[201~`); }
    attachCustomKeyEventHandler() {} registerLinkProvider = vi.fn(() => ({ dispose() {} }));
    onData(cb: (d: string) => void) { fake.dataCb = cb; return { dispose() {} }; }
    onResize() { return { dispose() {} }; } onSelectionChange() { return { dispose() {} }; }
    onRender() { return { dispose() {} }; }
    hasSelection() { return fake.selection !== ''; } getSelection() { return fake.selection; }
    element = document.createElement('div');
  },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} proposeDimensions() { return { cols: 80, rows: 24 }; } dispose() {} } }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class { dispose() {} } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { dispose() {} } }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { findNext() {} findPrevious() {} clearDecorations() {} dispose() {} } }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
vi.mock('@renderer/terminal-font-update', () => ({
  createTerminalFontUpdater: () => ({ apply: async () => {}, dispose() {} }),
  createTerminalGeometrySynchronizer: () => Object.assign(() => {}, {}),
}));
vi.mock('@renderer/fonts/font-settings-context', () => ({ useFontSettings: () => ({ terminalFontFamily: null }) }));
vi.mock('@renderer/fonts/terminal-font-size-context', () => ({ useTerminalFontSize: () => ({ size: 13, ready: true, setSize: () => {} }) }));
vi.mock('@renderer/fonts/terminal-font-weight-context', () => ({ useTerminalFontWeight: () => ({ weight: 400, boldWeight: 700, ready: true }) }));
vi.mock('@renderer/shortcut-platform', () => ({ useShortcutPlatform: () => 'mac' }));
vi.mock('@renderer/hooks/useTerminalDrop', () => ({ useTerminalDrop: () => ({ overlay: null, handlers: {} }) }));
vi.mock('@renderer/hooks/useWindowTerminalFocus', () => ({ terminalFocus: { register: () => ({ unregister() {}, opened() {}, used() {} }) } }));
vi.mock('@renderer/terminal-geometry-hold', () => ({ isTerminalGeometryHeld: () => false, onTerminalGeometryRelease: () => () => {} }));

const toast = vi.fn();
vi.mock('@renderer/hooks/useToasts', () => ({ toast: (...a: unknown[]) => toast(...a) }));

const handle = {
  data: undefined as undefined | ((d: string) => void),
  inputErr: undefined as undefined | ((e: unknown) => void),
  onInputError(cb: (e: unknown) => void) { handle.inputErr = cb; },
  onData(cb: (d: string) => void) { handle.data = cb; },
  onExit: vi.fn(), onClose: vi.fn(), send: vi.fn(), resize: vi.fn(), close: vi.fn(),
};
vi.mock('@renderer/p2p/remoteShellBridge', () => ({ openRemoteShell: () => handle }));

import { ShellTab } from '../../components/ShellTab';

const writeText = vi.fn(async () => {});

beforeEach(() => {
  cleanup();
  invoke.mockReset();
  invoke.mockResolvedValue({ output: '', profiles: [] });
  handle.send.mockClear();
  toast.mockClear();
  writeText.mockClear();
  fake.selection = '';
  fake.writes = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText, readText: async () => '' } });
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} };
  (window as unknown as { matchMedia?: unknown }).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});

function renderRemote(deviceName?: string) {
  const r = render(<ShellTab projectId={3} shellIndex={1} primary source={{ kind: 'remote', deviceId: 'tower', deviceName }} />);
  const host = r.getByTestId('shell-tab').firstElementChild as HTMLElement;
  return { ...r, host };
}

function clipboardEvent(type: 'paste' | 'copy', text = '') {
  const store = new Map<string, string>([['text/plain', text]]);
  const ev = new Event(type, { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
  Object.defineProperty(ev, 'clipboardData', { value: { getData: (t: string) => store.get(t) ?? '', setData: (t: string, v: string) => store.set(t, v) } });
  return { ev, store };
}

async function waitForStockEffects(): Promise<void> {
  await vi.waitFor(() => expect(fake.osc.has(52)).toBe(true));
}

describe('remote ShellTab clipboard (diagnosis)', () => {
  test('control: a DOM paste on the remote terminal host reaches the remote PTY as a bracketed paste', async () => {
    const { host } = renderRemote();
    await waitForStockEffects();
    const { ev } = clipboardEvent('paste', 'echo hi');
    await act(async () => { host.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
    expect(handle.send).toHaveBeenCalledWith('\x1b[200~echo hi\x1b[201~');
  });

  test('control: a DOM copy of an xterm selection in the remote terminal fills the local clipboard event', async () => {
    const { host } = renderRemote();
    await waitForStockEffects();
    fake.selection = 'remote output';
    const { ev, store } = clipboardEvent('copy');
    act(() => { host.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
    expect(store.get('text/plain')).toBe('remote output');
  });

  async function osc(arg: string): Promise<void> {
    await waitForStockEffects();
    await act(async () => { await fake.osc.get(52)?.(arg); });
  }
  const b64 = (t: string) => btoa(String.fromCharCode(...new TextEncoder().encode(t)));

  test('AC-T6: an OSC 52 clipboard write from the remote program lands on the local clipboard', async () => {
    renderRemote();
    await osc(`c;${b64('copied on the remote é🎉')}`);
    expect(writeText).toHaveBeenCalledWith('copied on the remote é🎉');
  });

  test('AC-T6: the same handler is registered for a local terminal', async () => {
    render(<ShellTab projectId={3} shellIndex={1} primary />);
    await osc(`c;${b64('local copy')}`);
    expect(writeText).toHaveBeenCalledWith('local copy');
  });

  test('S1: an OSC 52 read query gets no write and no reply', async () => {
    const { host } = renderRemote();
    void host;
    await osc('c;?');
    expect(writeText).not.toHaveBeenCalled();
    expect(handle.send).not.toHaveBeenCalled();
  });

  test('a clipboard rejection surfaces as a copy-failed toast', async () => {
    writeText.mockRejectedValueOnce(new Error('Document is not focused'));
    renderRemote();
    await osc(`c;${b64('x')}`);
    expect(toast).toHaveBeenCalledWith('Copy failed', expect.objectContaining({ kind: 'error', detail: 'Document is not focused' }));
  });

  test('repeated OSC 52 clipboard rejections within 5 s give one toast', async () => {
    writeText.mockRejectedValue(new Error('Document is not focused'));
    renderRemote();
    for (let i = 0; i < 3; i++) await osc(`c;${b64('x')}`);
    expect(toast.mock.calls.filter((c) => c[0] === 'Copy failed')).toHaveLength(1);
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
  });

  test('the OSC 52 handler is disposed on unmount', async () => {
    const { unmount } = renderRemote();
    await waitForStockEffects();
    expect(fake.osc.has(52)).toBe(true);
    unmount();
    expect(fake.osc.has(52)).toBe(false);
  });

  test('AC-T7: the terminal forces selection with Option+click', () => {
    renderRemote();
    expect(fake.opts?.macOptionClickForcesSelection).toBe(true);
  });

  test('AC-T8: repeated input failures within 5 s give one toast naming the host', () => {
    vi.useFakeTimers();
    try {
      renderRemote('Tower');
      for (let i = 0; i < 3; i++) handle.inputErr?.({ kind: 'failed', message: 'closed' });
      expect(toast).toHaveBeenCalledTimes(1);
      expect(toast).toHaveBeenCalledWith('Could not send input to Tower', expect.objectContaining({ detail: 'closed' }));
      vi.advanceTimersByTime(5001);
      handle.inputErr?.({ kind: 'failed', message: 'closed' });
      expect(toast).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  test('AC-T8: without a device name the toast falls back to "the remote machine"', () => {
    renderRemote();
    handle.inputErr?.({ kind: 'failed', message: 'x' });
    expect(toast).toHaveBeenCalledWith('Could not send input to the remote machine', expect.anything());
  });

  test('AC-T5: a too-large refusal toasts the 4 MB limit', () => {
    renderRemote('Tower');
    handle.inputErr?.({ kind: 'too-large', limitBytes: 4 * 1024 * 1024 });
    expect(toast).toHaveBeenCalledWith('Paste too large for Tower', expect.objectContaining({ detail: 'Pastes into a remote terminal are limited to 4 MB.' }));
  });

  test('AC-T3: one paste event gives exactly one send', async () => {
    const { host } = renderRemote();
    await waitForStockEffects();
    const { ev } = clipboardEvent('paste', 'one');
    await act(async () => { host.dispatchEvent(ev); });
    expect(handle.send).toHaveBeenCalledTimes(1);
  });

  test('AC-T2: local and remote receive the same bytes for the same clipboard text', async () => {
    const text = 'line1\nline2 é🎉';
    const remote = renderRemote();
    await waitForStockEffects();
    await act(async () => { remote.host.dispatchEvent(clipboardEvent('paste', text).ev); });
    const remoteBytes = handle.send.mock.calls.map((c) => c[0]).join('');
    remote.unmount();
    invoke.mockClear();
    const local = render(<ShellTab projectId={3} shellIndex={1} primary />);
    const lhost = local.getByTestId('shell-tab').firstElementChild as HTMLElement;
    await waitForStockEffects();
    await act(async () => { lhost.dispatchEvent(clipboardEvent('paste', text).ev); });
    const localBytes = invoke.mock.calls.filter((c) => c[0] === 'shells:write').map((c) => (c[1] as { data: string }).data).join('');
    expect(remoteBytes).not.toBe('');
    expect(localBytes).toBe(remoteBytes);
  });
});
