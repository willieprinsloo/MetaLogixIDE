// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@renderer/api', () => ({ api: { invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} } }));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    unicode = { activeVersion: '' }; cols = 80; rows = 24; options: Record<string, unknown> = {};
    buffer = { active: { getLine: () => undefined } };
    loadAddon() {} open() {} write() {} reset() {} dispose() {} focus() {} paste() {} refresh() {}
    attachCustomKeyEventHandler() {} registerLinkProvider = vi.fn(() => ({ dispose() {} }));
    onData() { return { dispose() {} }; } onResize() { return { dispose() {} }; } onSelectionChange() { return { dispose() {} }; }
    hasSelection() { return false; } getSelection() { return ''; } element = document.createElement('div');
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
vi.mock('@renderer/hooks/useShellStream', () => ({ useShellStream: () => {} }));
vi.mock('@renderer/hooks/useTerminalDrop', () => ({ useTerminalDrop: () => ({ overlay: null, handlers: {} }) }));
vi.mock('@renderer/hooks/useTerminalPaste', () => ({ useTerminalPaste: () => () => {} }));
vi.mock('@renderer/hooks/useWindowTerminalFocus', () => ({ terminalFocus: { register: () => ({ unregister() {} }) } }));
vi.mock('@renderer/terminal-geometry-hold', () => ({ isTerminalGeometryHeld: () => false, onTerminalGeometryRelease: () => () => {} }));

const handle = {
  exit: undefined as undefined | ((c: number | null) => void),
  onData: vi.fn(), onClose: vi.fn(), send: vi.fn(), resize: vi.fn(), close: vi.fn(),
  onExit(cb: (c: number | null) => void) { handle.exit = cb; },
};
const openRemoteShell = vi.fn(() => handle);
vi.mock('@renderer/p2p/remoteShellBridge', () => ({ openRemoteShell: (...a: unknown[]) => (openRemoteShell as any)(...a) }));

import { ShellTab } from '../../components/ShellTab';

beforeEach(() => {
  cleanup();
  invoke.mockReset();
  invoke.mockResolvedValue({ output: '', profiles: [] });
  openRemoteShell.mockClear();
  handle.exit = undefined;
  (globalThis as any).ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} };
  (window as any).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});

describe('ShellTab remote source', () => {
  test('remote: attaches through the bridge, hides relaunch / launch-fix, no local snapshot or write IPC', async () => {
    const { queryByTestId, findByText } = render(
      <ShellTab projectId={3} shellIndex={1} source={{ kind: 'remote', deviceId: 'tower' }} onOpenLaunchSettings={() => {}} />,
    );
    expect(openRemoteShell).toHaveBeenCalledWith('tower', 3, 1);
    act(() => handle.exit?.(0));
    await findByText(/Shell exited/);
    expect(queryByTestId('shell-relaunch')).toBeNull();
    expect(queryByTestId('shell-fix-launch')).toBeNull();
    expect(queryByTestId('shell-exit-dismiss')).not.toBeNull();
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain('shells:snapshot');
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain('shells:cli-profiles-list');
  });

  test('local (default): does not use the bridge', () => {
    render(<ShellTab projectId={3} shellIndex={1} />);
    expect(openRemoteShell).not.toHaveBeenCalled();
    expect(invoke.mock.calls.map((c) => c[0])).toContain('shells:snapshot');
  });
});
