// @vitest-environment jsdom
/** The remote + menu: older-host detection and copy (AC21, AC21a), and the viewer-side profile allow-list (AC10). */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';

vi.mock('@renderer/api', () => ({ api: { invoke: vi.fn(async () => ({})), on: () => () => {} } }));

import { NewShellMenu, type RemoteShellMenu } from '@renderer/components/ShellTabsBar';
import { isOlderHostError } from '@renderer/p2p/err-message';
import { useRemoteShellMenu } from '@renderer/p2p/useRemoteTabs';
import { REMOTE_MENU_COPY } from '@renderer/remote-pane-contract';

beforeEach(() => {
  cleanup();
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false }));
});

const WRAPPED = "Error invoking remote method 'p2p:rpc-call': RpcError: unknown method: shells.cliProfiles";

describe('isOlderHostError', () => {
  it.each([
    ['the host reply', new Error('unknown method: shells.cliProfiles')],
    ['the viewer guard', new Error('unknown_method: shells.cliProfiles')],
    ['the Electron-wrapped reply', new Error(WRAPPED)],
    ['a plain string rejection', 'unknown method: shells.cliProfiles'],
  ])('is true for %s', (_label, err) => {
    expect(isOlderHostError(err)).toBe(true);
  });

  it.each([
    ['the words mid-message', new Error('handler failed: unknown method: x')],
    ['a timeout', new Error('rpc timeout')],
    ['a bare unknown_method code with no colon', new Error('unknown_method')],
    ['a host error', new Error('forbidden')],
  ])('is false for %s', (_label, err) => {
    expect(isOlderHostError(err)).toBe(false);
  });
});

function remoteMenu(hostName: string, failures: unknown[]): RemoteShellMenu {
  return {
    hostName,
    profiles: async () => {
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      return [{ name: 'claude', scope: 'global' }];
    },
    remove: async () => {},
    setDefault: async () => {},
  };
}

const noop = (): void => {};
function openMenu(menu: RemoteShellMenu) {
  return render(<NewShellMenu projectId={7} remoteMenu={menu} defaultCliName={null}
    onLaunchProfile={noop} onLaunchPlainTab={noop} onLaunchCustom={noop} onClose={noop} />);
}

describe('remote + menu load failures', () => {
  it.each([
    ['unknown method:', new Error('unknown method: shells.cliProfiles')],
    ['unknown_method:', new Error('unknown_method: shells.cliProfiles')],
    ['the Electron-wrapped RpcError', new Error(WRAPPED)],
  ])('an older host (%s) names the machine and still offers Terminal', async (_label, err) => {
    openMenu(remoteMenu('Tower', [err]));
    expect((await screen.findByRole('alert')).textContent).toBe(REMOTE_MENU_COPY.olderHost('Tower'));
    expect(screen.getByText('Terminal')).toBeTruthy();
    expect(screen.queryByText('claude')).toBeNull();
  });

  it.each(['', '   '])('a blank host name (%j) reads "The other machine"', async (name) => {
    openMenu(remoteMenu(name, [new Error('unknown method: shells.cliProfiles')]));
    expect((await screen.findByRole('alert')).textContent).toBe(REMOTE_MENU_COPY.olderHost('The other machine'));
  });

  it.each([
    ['a timeout', new Error('rpc timeout')],
    ['a disconnect', new Error('not connected')],
    ['the words mid-message', new Error('handler failed: unknown method: x')],
  ])('any other failure (%s) shows exactly the load-failed copy and still offers Terminal', async (_label, err) => {
    openMenu(remoteMenu('Tower', [err]));
    expect((await screen.findByRole('alert')).textContent).toBe(REMOTE_MENU_COPY.loadFailed);
    expect(screen.getByText('Terminal')).toBeTruthy();
  });

  it('judges each open on its own: older host, then a timeout, then success', async () => {
    const menu = remoteMenu('Tower', [new Error('unknown method: shells.cliProfiles'), new Error('rpc timeout')]);
    const first = openMenu(menu);
    expect((await screen.findByRole('alert')).textContent).toBe(REMOTE_MENU_COPY.olderHost('Tower'));
    first.unmount();
    const second = openMenu(menu);
    expect((await screen.findByRole('alert')).textContent).toBe(REMOTE_MENU_COPY.loadFailed);
    second.unmount();
    openMenu(menu);
    expect(await screen.findByText('claude')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('useRemoteShellMenu', () => {
  it('hands the menu only name, scope and icon, whatever extra fields the host sends', async () => {
    const call = vi.fn(async () => ({
      result: {
        profiles: [
          { name: 'claude', scope: 'global', icon: '🤖', argv: ['claude', '--dangerous'], env: { TOKEN: 's3cret' } },
          { name: 'mine', scope: 'project', argv: ['rm', '-rf'], cmd: 'rm -rf /', save: true },
        ],
        defaultName: 'mine',
      },
    }));
    const { result } = renderHook(() => useRemoteShellMenu(call, 'Tower'));
    const profiles = await result.current.menu.profiles();
    expect(profiles).toEqual([{ name: 'claude', scope: 'global', icon: '🤖' }, { name: 'mine', scope: 'project' }]);
    expect(JSON.stringify(profiles)).not.toMatch(/dangerous|s3cret|TOKEN|rm -rf/);
    expect(call).toHaveBeenCalledWith('shells.cliProfiles', {});
    await waitFor(() => expect(result.current.defaultName).toBe('mine'));
    expect(result.current.menu.hostName).toBe('Tower');
  });

  it('drops malformed entries rather than passing them to the menu', async () => {
    const call = vi.fn(async () => ({ result: { profiles: [{ name: 'ok', scope: 'project' }, { name: 3, scope: 'global' }, { name: 'x', scope: 'root' }, null] } }));
    const { result } = renderHook(() => useRemoteShellMenu(call, 'Tower'));
    expect(await result.current.menu.profiles()).toEqual([{ name: 'ok', scope: 'project' }]);
  });
});
