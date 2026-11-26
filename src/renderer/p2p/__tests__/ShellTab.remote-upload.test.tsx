// @vitest-environment jsdom
/**
 * Wiring tests for remote uploads in the real ShellTab with the real paste and drop hooks
 * (AC-D5..D8, AC-D11, AC-I1, AC-L1). The IPC bridge is mocked at `api.invoke`/`api.on`, xterm is a
 * fake whose `paste` emits a bracketed `onData`, and the remote shell handle records its callbacks.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, act, cleanup, fireEvent, screen } from '@testing-library/react';
import { REMOTE_UPLOAD_COPY, type UploadResult } from '@shared/remote-upload-contract';
import { DROP_COPY } from '@shared/terminal-drop-contract';

const invoke = vi.fn();
vi.mock('@renderer/api', () => ({
  api: { invoke: (...a: unknown[]) => invoke(...a), on: () => () => {}, platform: 'darwin', pathForFile: () => '/Users/me/a.txt' },
}));

const fake = { dataCb: null as null | ((d: string) => void) };

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    unicode = { activeVersion: '' }; cols = 80; rows = 24; options: Record<string, unknown> = {};
    buffer = { active: { getLine: () => undefined, type: 'normal', baseY: 0 }, onBufferChange: () => ({ dispose() {} }) };
    parser = { registerOscHandler: () => ({ dispose() {} }) };
    loadAddon(addon: { activate?: (t: unknown) => void }) { addon.activate?.(this); }
    open() {} reset() {} dispose() {} focus() {} refresh() {} scrollToBottom() {} clearSelection() {}
    write(_d: string, cb?: () => void) { cb?.(); }
    paste(text: string) { fake.dataCb?.(`\x1b[200~${text}\x1b[201~`); }
    attachCustomKeyEventHandler() {} registerLinkProvider = vi.fn(() => ({ dispose() {} }));
    onData(cb: (d: string) => void) { fake.dataCb = cb; return { dispose() {} }; }
    onResize() { return { dispose() {} }; } onSelectionChange() { return { dispose() {} }; }
    onRender() { return { dispose() {} }; }
    hasSelection() { return false; } getSelection() { return ''; }
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
vi.mock('@renderer/hooks/useWindowTerminalFocus', () => ({ terminalFocus: { register: () => ({ unregister() {}, opened() {}, used() {} }) } }));
vi.mock('@renderer/terminal-geometry-hold', () => ({ isTerminalGeometryHeld: () => false, onTerminalGeometryRelease: () => () => {} }));

const toast = vi.fn();
vi.mock('@renderer/hooks/useToasts', () => ({ toast: (...a: unknown[]) => toast(...a) }));

const handle = {
  exit: [] as Array<(c: number | null) => void>,
  close: [] as Array<(r: string) => void>,
  onInputError() {},
  onData() {},
  onExit(cb: (c: number | null) => void) { handle.exit.push(cb); },
  onClose(cb: (r: string) => void) { handle.close.push(cb); },
  send: vi.fn(), resize: vi.fn(),
  closeHandle: vi.fn(),
};
vi.mock('@renderer/p2p/remoteShellBridge', () => ({
  openRemoteShell: () => ({ ...handle, close: () => { handle.closeHandle(); for (const cb of handle.close) cb('closed'); } }),
}));

import { ShellTab } from '../../components/ShellTab';

let pendingUpload: { id: string; resolve: (r: UploadResult) => void } | null = null;

beforeEach(() => {
  cleanup();
  invoke.mockReset();
  invoke.mockImplementation((channel: string, req: { uploadId?: string }) => {
    if (channel === 'p2p:upload') {
      return new Promise<UploadResult>((resolve) => { pendingUpload = { id: req.uploadId ?? '', resolve }; });
    }
    if (channel === 'p2p:upload-cancel') return Promise.resolve({ ok: true });
    return Promise.resolve({ output: '', profiles: [] });
  });
  pendingUpload = null;
  handle.send.mockClear();
  handle.closeHandle.mockClear();
  handle.exit = [];
  handle.close = [];
  toast.mockClear();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} };
  (window as unknown as { matchMedia?: unknown }).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});

const fileDrop = () => ({
  dataTransfer: {
    types: ['Files'],
    files: [{ name: 'a.txt', type: 'text/plain', size: 3, arrayBuffer: async () => new ArrayBuffer(3) }],
    items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }) }],
    dropEffect: 'none',
    getData: () => '',
  },
});

function renderTab(remote = true) {
  const source = remote ? { kind: 'remote' as const, deviceId: 'tower-id', deviceName: 'tower' } : undefined;
  const r = render(<ShellTab projectId={3} shellIndex={1} primary source={source} />);
  return { ...r, tab: r.getByTestId('shell-tab') };
}

async function dropAndWaitForUpload(tab: HTMLElement) {
  fireEvent.drop(tab, fileDrop());
  await vi.waitFor(() => expect(pendingUpload).not.toBeNull());
}

const sentText = () => handle.send.mock.calls.map((c) => c[0] as string).join('');

describe('remote ShellTab uploads', () => {
  test('AC-D1/AC-D7: typing flows during an upload and the host path is pasted when it lands', async () => {
    const { tab } = renderTab();
    await dropAndWaitForUpload(tab);
    act(() => fake.dataCb?.('ls\r'));
    expect(handle.send).toHaveBeenLastCalledWith('ls\r');
    await act(async () => pendingUpload?.resolve({ kind: 'staged', path: '/tmp/d/a.txt', style: 'posix' }));
    await vi.waitFor(() => expect(handle.send).toHaveBeenLastCalledWith('\x1b[200~/tmp/d/a.txt\x1b[201~'));
    expect(sentText()).not.toContain('/Users/me');
  });

  test('AC-D8: unmount during an upload cancels it and pastes nothing', async () => {
    const { tab, unmount } = renderTab();
    await dropAndWaitForUpload(tab);
    const id = pendingUpload?.id;
    unmount();
    expect(invoke).toHaveBeenCalledWith('p2p:upload-cancel', { uploadId: id });
    await act(async () => pendingUpload?.resolve({ kind: 'staged', path: '/tmp/d/a.txt', style: 'posix' }));
    expect(sentText()).not.toContain('/tmp/d/a.txt');
  });

  test('AC-D8: the remote shell exiting during an upload cancels it and pastes nothing', async () => {
    const { tab } = renderTab();
    await dropAndWaitForUpload(tab);
    act(() => { for (const cb of handle.exit) cb(0); });
    expect(invoke).toHaveBeenCalledWith('p2p:upload-cancel', { uploadId: pendingUpload?.id });
    await act(async () => pendingUpload?.resolve({ kind: 'cancelled' }));
    expect(sentText()).toBe('');
    expect(toast).not.toHaveBeenCalled();
  });

  test('AC-D8: the remote stream closing during an upload cancels it', async () => {
    const { tab } = renderTab();
    await dropAndWaitForUpload(tab);
    act(() => { for (const cb of handle.close) cb('remote_ended'); });
    expect(invoke).toHaveBeenCalledWith('p2p:upload-cancel', { uploadId: pendingUpload?.id });
  });

  test('AC-D5/AC-D6: the progress indicator appears after 500 ms and its Cancel stops the drop silently', async () => {
    const { tab } = renderTab();
    await dropAndWaitForUpload(tab);
    expect(screen.queryByTestId('upload-progress')).toBeNull();
    const status = await screen.findByRole('status', {}, { timeout: 2000 });
    expect(status.textContent).toBe(REMOTE_UPLOAD_COPY.progressLabel('a.txt', 1, 1, 0));
    fireEvent.click(screen.getByRole('button', { name: REMOTE_UPLOAD_COPY.cancel }));
    expect(invoke).toHaveBeenCalledWith('p2p:upload-cancel', { uploadId: pendingUpload?.id });
    expect(screen.queryByTestId('upload-progress')).toBeNull();
    await act(async () => pendingUpload?.resolve({ kind: 'cancelled' }));
    expect(sentText()).toBe('');
    expect(toast).not.toHaveBeenCalled();
  });

  test('AC-D11: a file drag reads "Drop to send to <host>", a text drag keeps its copy', () => {
    const { tab } = renderTab();
    fireEvent.dragEnter(tab, { dataTransfer: { types: ['Files'] } });
    expect(screen.getByText(REMOTE_UPLOAD_COPY.overlaySend('tower'))).toBeTruthy();
    fireEvent.dragLeave(tab);
    fireEvent.dragEnter(tab, { dataTransfer: { types: ['text/plain'] } });
    expect(screen.getByText(DROP_COPY.overlayText)).toBeTruthy();
  });

  test('AC-I1: an image-only paste on a remote terminal uploads the clipboard image', async () => {
    const { tab } = renderTab();
    const host = tab.firstElementChild as HTMLElement;
    const ev = Object.assign(new Event('paste', { bubbles: true, cancelable: true }), { clipboardData: { getData: () => '' } });
    await act(async () => { host.dispatchEvent(ev); });
    await vi.waitFor(() => expect(pendingUpload).not.toBeNull());
    expect(invoke).toHaveBeenCalledWith('p2p:upload', expect.objectContaining({ deviceId: 'tower-id', source: { kind: 'clipboard-image' } }));
    expect(invoke).not.toHaveBeenCalledWith('drops:stage-clipboard-image', undefined);
    await act(async () => pendingUpload?.resolve({ kind: 'staged', path: '/tmp/d/pasted.png', style: 'posix' }));
    await vi.waitFor(() => expect(handle.send).toHaveBeenLastCalledWith('\x1b[200~/tmp/d/pasted.png\x1b[201~'));
  });
});

describe('local ShellTab (AC-L1)', () => {
  test('a file drop never uploads and keeps the local overlay copy', async () => {
    const { tab } = renderTab(false);
    fireEvent.dragEnter(tab, { dataTransfer: { types: ['Files'] } });
    expect(screen.getByText(DROP_COPY.overlayPath)).toBeTruthy();
    fireEvent.drop(tab, fileDrop());
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('shells:write', expect.objectContaining({ data: expect.stringContaining('/Users/me/a.txt') })));
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain('p2p:upload');
    expect(screen.queryByTestId('upload-progress')).toBeNull();
  });
});
