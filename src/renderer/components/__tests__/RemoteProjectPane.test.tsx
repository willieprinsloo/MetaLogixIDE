// @vitest-environment jsdom
/** RemoteProjectPane: the main-area pane for a project on a paired machine (moved unchanged from Sidebar.machines.test.tsx). */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@renderer/api', () => ({ api: { invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} } }));
vi.mock('../ShellTab', () => ({ ShellTab: (p: { source: unknown; shellIndex: number }) => <div data-testid="shell-tab" data-shell={p.shellIndex}>{JSON.stringify(p.source)}</div> }));
vi.mock('../FilesTab', () => ({ FilesTab: ({ openRelPath }: { openRelPath?: string }) => <div data-testid="files-panel">
  {openRelPath}<textarea aria-label="Remote draft" />
</div> }));
const focus = vi.hoisted(() => ({ requestFocus: vi.fn(), requestProjectFocus: vi.fn(), cancelRequest: vi.fn() }));
vi.mock('@renderer/hooks/useWindowTerminalFocus', () => ({ terminalFocus: focus }));
const toastSpy = vi.hoisted(() => vi.fn());
vi.mock('@renderer/hooks/useToasts', async (importOriginal) => ({ ...(await importOriginal<object>()), toast: toastSpy }));
vi.mock('../ActivityTab', () => ({ ActivityTab: ({ onOpenTarget }: { onOpenTarget?: (path: string) => void }) =>
  <button type="button" onClick={() => onOpenTarget?.('remote.txt')}>Open remote activity file</button> }));

import { RemoteProjectPane } from '../RemoteProjectPane';
import { WorkspaceDestinations } from '../WorkspaceDestinations';
import { WorkspaceHeaderSlotContext } from '../WorkspaceHeaderSlot';
import { SHELL_TAB_TEST_ID } from '@shared/agent-state';
import { RemoteShellCommandsContext, type RemoteShellCommands } from '../RemoteShellCommands';

/** The shell tab chips (the same ShellTabsBar chips local projects use). */
const chips = (): HTMLElement[] => screen.queryAllByTestId(SHELL_TAB_TEST_ID);
const findChips = (): Promise<HTMLElement[]> => screen.findAllByTestId(SHELL_TAB_TEST_ID);
const findChip = async (name: string | RegExp): Promise<HTMLElement> => waitFor(() => {
  const found = chips().find((c) => (typeof name === 'string' ? c.textContent === name : name.test(c.textContent ?? '')));
  if (!found) throw new Error(`no chip ${String(name)}`);
  return found;
});
const isActive = (c: HTMLElement): boolean => c.className.includes('bg-[--surface-active]');

let alive: unknown[] = [];

beforeEach(() => {
  cleanup();
  // The shell tab strip (ShellTabsBar) reads prefers-reduced-motion; jsdom has no matchMedia.
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false }));
  // ChipStrip fades chips in and out with the Web Animations API, which jsdom lacks.
  Element.prototype.animate = function animate() {
    return { finished: Promise.resolve(), cancel() {}, finish() {}, onfinish: null, addEventListener() {} } as unknown as Animation;
  };
  alive = [];
  focus.requestFocus.mockReset();
  focus.requestProjectFocus.mockReset();
  focus.cancelRequest.mockReset();
  toastSpy.mockReset();
  invoke.mockReset();
  invoke.mockImplementation(async (_ch: string, a: { method?: string }) => {
    if (a?.method === 'shells.launch') return { result: { shellIndex: 2 } };
    if (a?.method === 'shells.alive') return { result: alive };
    if (a?.method === 'workspace.info') throw new Error('unknown_method');
    return {};
  });
});

describe('RemoteProjectPane', () => {
  test('fills a provided workspace header row with its destinations, centred shell strip and identity, like the local header', async () => {
    alive = [{ projectId: 7, shellIndex: 2, launchArgv: ['claude'] }, { projectId: 7, shellIndex: 3, launchArgv: ['opencode'] }];
    const header = document.createElement('header');
    header.className = 'workspace-header-row';
    document.body.appendChild(header);
    try {
      render(<WorkspaceHeaderSlotContext.Provider value={header}>
        <RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />
      </WorkspaceHeaderSlotContext.Provider>);
      await screen.findByTestId('shell-tab');
      const pane = screen.getByTestId('remote-project-pane');
      const strip = await waitFor(() => { const el = header.querySelector<HTMLElement>('.shell-tabs-bar'); if (!el) throw new Error('no strip'); return el; });
      // Positive control: everything still renders, just in the header row rather than inside the pane.
      expect(within(header.querySelector<HTMLElement>('.workspace-destinations')!).getByRole('button', { name: 'Shell' }).getAttribute('aria-current')).toBe('page');
      expect(header.querySelector('.workspace-project-actions')?.textContent).toContain('alpha @ Tower');
      expect(strip.parentElement).toBe(header);
      await waitFor(() => expect(strip.querySelectorAll(`[data-testid="${SHELL_TAB_TEST_ID}"]`)).toHaveLength(2));
      expect(pane.contains(strip)).toBe(false);
      expect(pane.querySelector('.workspace-destinations')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Files' }));
      expect(header.querySelector('.shell-tabs-bar')).toBeNull();
      expect(await screen.findByTestId('files-panel')).toBeTruthy();
    } finally {
      cleanup();
      header.remove();
    }
  });

  test('reports whether its Shell tab shows, so the host sheet can take the shell styling', async () => {
    const onSheet = vi.fn();
    render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" onSheetContentChange={onSheet} />);
    await screen.findByTestId('shell-tab');
    expect(onSheet).toHaveBeenLastCalledWith('shell');
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    await waitFor(() => expect(onSheet).toHaveBeenLastCalledWith('other'));
    fireEvent.click(screen.getByRole('button', { name: 'Shell' }));
    await waitFor(() => expect(onSheet).toHaveBeenLastCalledWith('shell'));
  });

  test('renders its header inline when no header row is provided', async () => {
    render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
    await screen.findByTestId('shell-tab');
    const pane = screen.getByTestId('remote-project-pane');
    expect(pane.querySelector('.workspace-destinations')).not.toBeNull();
    expect(pane.textContent).toContain('alpha @ Tower');
  });

  test('offers workspace destinations independently of shell session tabs', async () => {
    render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
    await screen.findByTestId('shell-tab');
    expect(screen.getByRole('button', { name: 'Shell' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Files' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Diff' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Activity' })).toBeNull();
    expect(await screen.findByText(/Workspace access unavailable/)).toBeTruthy();
  });

  test('the shared destinations keep local diff and unsaved markers', () => {
    const onSelect = vi.fn();
    render(<WorkspaceDestinations active="settings" activityEnabled={false} diffCount={2} envDirty onSelect={onSelect} />);
    const diff = screen.getByRole('button', { name: 'Diff, 2 changed files' });
    expect(screen.getByTestId('main-tab-diff-count').textContent).toBe('2');
    expect(screen.getByTestId('project-settings-tab').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('project-settings-tab').getAttribute('aria-label')).toMatch(/unsaved/i);
    fireEvent.click(diff);
    expect(onSelect).toHaveBeenCalledWith('diff');
  });

  test('reports a remote Diff failure and retries against that same host', async () => {
    invoke.mockImplementation(async (_ch: string, input: { deviceId?: string; method?: string }) => {
      if (input?.method === 'workspace.info') return { result: { activityEnabled: false } };
      if (input?.method === 'workspace.diffStatus') throw new Error('temporarily unavailable');
      if (input?.method === 'shells.launch') return { result: { shellIndex: 2 } };
      return { result: [] };
    });
    render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
    fireEvent.click(screen.getByRole('button', { name: 'Diff' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not read git status');
    invoke.mockResolvedValueOnce({
      result: { isRepo: false, branch: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Not a git repository.')).toBeTruthy();
    expect(invoke.mock.calls.filter(([, input]) => input?.method === 'workspace.diffStatus')).toEqual([
      ['p2p:rpc-call', { deviceId: 'tower', method: 'workspace.diffStatus', params: { projectId: 7 } }],
      ['p2p:rpc-call', { deviceId: 'tower', method: 'workspace.diffStatus', params: { projectId: 7 } }],
    ]);
    expect(invoke).not.toHaveBeenCalledWith('git:panel-status', expect.anything());
  });

  test('returning from Files restores the picked remote session and does not relaunch it', async () => {
    alive = [{ projectId: 7, shellIndex: 2, launchArgv: ['claude'] }, { projectId: 7, shellIndex: 3, launchArgv: ['opencode'] }];
    render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
    fireEvent.click(await findChip('Opencode'));
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(screen.getByTestId('files-panel')).toBeTruthy();
    expect(screen.queryByTestId('shell-tab')).toBeNull();
    expect(screen.getByRole('button', { name: 'Files' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('button', { name: 'Shell' }));
    expect((await screen.findByTestId('shell-tab')).getAttribute('data-shell')).toBe('3');
    expect(invoke.mock.calls.filter(([, input]) => input?.method === 'shells.launch')).toHaveLength(1);
  });

  test('uses the selected host Activity capability and routes its file link within that workspace', async () => {
    invoke.mockImplementation(async (_ch: string, input: { deviceId?: string; method?: string }) => {
      if (input?.method === 'workspace.info') return { result: { activityEnabled: input.deviceId === 'tower' } };
      if (input?.method === 'shells.launch') return { result: { shellIndex: 2 } };
      return { result: [] };
    });
    const { rerender } = render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Activity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open remote activity file' }));
    expect(screen.getByTestId('files-panel').textContent).toBe('remote.txt');

    rerender(<RemoteProjectPane deviceId="laptop" deviceName="Laptop" projectId={7} projectName="alpha" />);
    expect((await screen.findByTestId('shell-tab')).textContent).toContain('"deviceId":"laptop"');
    expect(screen.queryByRole('button', { name: 'Activity' })).toBeNull();
    expect(screen.queryByTestId('files-panel')).toBeNull();
  });

  test('a repeated notice for the same shell returns from Files to Shell', async () => {
    alive = [{ projectId: 7, shellIndex: 2, launchArgv: ['claude'] }, { projectId: 7, shellIndex: 3, launchArgv: ['opencode'] }];
    const project = { deviceId: 'tower', deviceName: 'Tower', projectId: 7, projectName: 'alpha' };
    const { rerender } = render(<RemoteProjectPane {...project} openRequest={{ shellIndex: 3 }} />);
    await waitFor(() => expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('3'));
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(screen.getByTestId('files-panel')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Remote draft' }), { target: { value: 'unsaved' } });
    rerender(<RemoteProjectPane {...project} openRequest={{ shellIndex: 3 }} />);
    expect((await screen.findByTestId('shell-tab')).getAttribute('data-shell')).toBe('3');
    expect(screen.queryByRole('textbox', { name: 'Remote draft' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Remote draft' }).value).toBe('unsaved');
  });

  test('ignores a prior machine reporting Activity after a same-ID project switch', async () => {
    let finishTower: (value: { result: { activityEnabled: boolean } }) => void = () => {};
    const towerInfo = new Promise<{ result: { activityEnabled: boolean } }>((resolve) => { finishTower = resolve; });
    invoke.mockImplementation(async (_ch: string, input: { deviceId?: string; method?: string }) => {
      if (input?.method === 'workspace.info') {
        return input.deviceId === 'tower' ? towerInfo : { result: { activityEnabled: false } };
      }
      if (input?.method === 'shells.launch') return { result: { shellIndex: 2 } };
      return { result: [] };
    });
    const { rerender } = render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
    expect(invoke).toHaveBeenCalledWith('p2p:rpc-call', { deviceId: 'tower', method: 'workspace.info', params: { projectId: 7 } });
    rerender(<RemoteProjectPane deviceId="laptop" deviceName="Laptop" projectId={7} projectName="alpha" />);
    expect((await screen.findByTestId('shell-tab')).textContent).toContain('"deviceId":"laptop"');
    await act(async () => { finishTower({ result: { activityEnabled: true } }); });
    expect(screen.queryByRole('button', { name: 'Activity' })).toBeNull();
  });

  test('a lost workspace grant removes Activity but keeps the selected Shell usable', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let granted = true;
    try {
      invoke.mockImplementation(async (_ch: string, input: { method?: string }) => {
        if (input?.method === 'workspace.info') {
          if (!granted) throw new Error('workspace access requires a grant from the host');
          return { result: { activityEnabled: true } };
        }
        if (input?.method === 'shells.launch') return { result: { shellIndex: 2 } };
        return { result: [] };
      });
      render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
      expect(await screen.findByRole('button', { name: 'Activity' })).toBeTruthy();
      granted = false;
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(screen.getByText(/Workspace access unavailable/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Activity' })).toBeNull();
      expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('2');
    } finally {
      vi.useRealTimers();
    }
  });

  test('header shows Project @ Machine with a P2P badge and a remote ShellTab', async () => {
    render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
    expect(screen.getByText('alpha @ Tower')).toBeTruthy();
    expect(screen.getByText('P2P')).toBeTruthy();
    const tab = await screen.findByTestId('shell-tab');
    await waitFor(() => expect(tab.textContent).toContain('"deviceId":"tower"'));
  });

  test('shows one tab per shell the project runs on that machine, and switches the terminal to the one picked', async () => {
    alive = [
      { projectId: 7, shellIndex: 3, launchArgv: ['opencode'], agentState: 'busy', agent: 'opencode' },
      { projectId: 7, shellIndex: 2, launchArgv: ['/usr/local/bin/claude', '--continue'], agentState: 'idle', agent: 'claude' },
      { projectId: 7, shellIndex: 4, launchArgv: ['$SHELL'], agentState: null, agent: null },
      { projectId: 9, shellIndex: 0, launchArgv: ['codex'] }, // another project: not a tab here
    ];
    render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
    await waitFor(() => expect(chips()).toHaveLength(3));
    const tabs = chips();
    expect(tabs.map((t) => t.textContent)).toEqual(['Claude', 'Opencode', 'Terminal']);
    // The launched shell is selected first.
    expect(tabs.map(isActive)).toEqual([true, false, false]);
    expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('2');

    fireEvent.click(await findChip(/Opencode/));
    expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('3');
    expect(isActive(await findChip(/Opencode/))).toBe(true);
  });

  test('a terminal where an agent was started by hand is labelled as that agent; repeats are numbered', async () => {
    alive = [
      { projectId: 7, shellIndex: 2, launchArgv: ['claude'], agent: 'claude', agentState: 'idle' },
      { projectId: 7, shellIndex: 3, launchArgv: ['$SHELL'], agent: 'opencode', agentState: 'busy' },
      { projectId: 7, shellIndex: 5, launchArgv: ['claude'], agent: null },
    ];
    render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
    await waitFor(() => expect(chips()).toHaveLength(3));
    expect(chips().map((t) => t.textContent)).toEqual(['Claude 1', 'opencode', 'Claude 2']);
  });

  test('falls back to the launched shell when the picked one is gone; no chips (only +) before the host lists shells', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
      await screen.findByTestId('shell-tab');
      expect(chips()).toHaveLength(0);
      expect(screen.getByTestId('tabbar-new-shell')).toBeTruthy();

      alive = [{ projectId: 7, shellIndex: 2, launchArgv: ['claude'] }, { projectId: 7, shellIndex: 3, launchArgv: ['opencode'] }];
      await vi.advanceTimersByTimeAsync(3000);
      fireEvent.click(await findChip('Opencode'));
      expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('3');

      alive = [{ projectId: 7, shellIndex: 2, launchArgv: ['claude'] }];
      await vi.advanceTimersByTimeAsync(3000);
      await waitFor(() => expect(chips()).toHaveLength(1));
      expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('2');
    } finally {
      vi.useRealTimers();
    }
  });

  test('tells main which remote shell is on screen, follows tab switches, and clears it on unmount', async () => {
    alive = [{ projectId: 7, shellIndex: 2, launchArgv: ['claude'] }, { projectId: 7, shellIndex: 3, launchArgv: ['opencode'] }];
    const viewing = () => invoke.mock.calls.filter((c) => c[0] === 'p2p:viewing').map((c) => (c[1] as { shell: unknown }).shell);
    const { unmount } = render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
    await screen.findByTestId('shell-tab');
    expect(viewing().at(-1)).toEqual({ deviceId: 'tower', projectId: 7, shellIndex: 2 });
    fireEvent.click(await findChip('Opencode'));
    await waitFor(() => expect(viewing().at(-1)).toEqual({ deviceId: 'tower', projectId: 7, shellIndex: 3 }));
    unmount();
    expect(viewing().at(-1)).toBeNull();
  });

  test('opens on the tab a fleet notice names, and on another when a later notice names that', async () => {
    alive = [{ projectId: 7, shellIndex: 2, launchArgv: ['claude'] }, { projectId: 7, shellIndex: 3, launchArgv: ['opencode'] }, { projectId: 7, shellIndex: 4, launchArgv: ['$SHELL'] }];
    const { rerender } = render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" initialShellIndex={3} />);
    await findChips();
    await waitFor(() => expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('3'));
    rerender(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" initialShellIndex={4} />);
    await waitFor(() => expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('4'));
  });

  describe('terminal tab controls on the host', () => {
    /** Host fixture: alive shells, saved profiles, and every tab RPC recorded. */
    function host(opts: { profilesFail?: boolean } = {}) {
      alive = [{ projectId: 7, shellIndex: 2, launchArgv: ['claude'] }, { projectId: 7, shellIndex: 3, launchArgv: ['opencode'] }];
      let next = 6;
      let defaultName: string | null = 'claude';
      let saved = [{ name: 'claude', scope: 'global', icon: '🤖' }, { name: 'mine', scope: 'project' }];
      invoke.mockImplementation(async (_ch: string, a: { method?: string; params?: Record<string, unknown> }) => {
        switch (a?.method) {
          case 'shells.launch': return { result: { shellIndex: 2 } };
          case 'shells.alive': return { result: alive };
          case 'workspace.info': throw new Error('unknown_method');
          case 'shells.cliProfiles':
            if (opts.profilesFail) throw new Error('unknown_method');
            return { result: { profiles: saved, defaultName } };
          case 'shells.launchProfile': case 'shells.launchPlain': return { result: { shellIndex: next++ } };
          case 'shells.kill': return { result: { ok: true } };
          case 'shells.setDefaultCli': defaultName = (a.params?.name as string | null) ?? null; return { result: { defaultName } };
          case 'shells.removeCliProfile': saved = saved.filter((p) => p.name !== a.params?.name); return { result: { ok: true } };
          default: return {};
        }
      });
    }
    const rpc = (method: string) => invoke.mock.calls.filter(([, a]) => a?.method === method).map(([, a]) => a.params);

    async function openMenu() {
      render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
      await waitFor(() => expect(chips()).toHaveLength(2));
      fireEvent.click(screen.getByTestId('tabbar-new-shell'));
    }

    test('the + menu lists the host\'s saved profiles, offers no custom command, and opens a profile as a new selected tab', async () => {
      host();
      await openMenu();
      const mine = await screen.findByText('mine');
      expect(screen.getByText('claude')).toBeTruthy();
      expect(screen.queryByText(/custom command/i)).toBeNull();
      fireEvent.click(mine);
      await waitFor(() => expect(rpc('shells.launchProfile')).toEqual([{ projectId: 7, profileName: 'mine' }]));
      // Selected at once, before the next poll lists it.
      await waitFor(() => expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('6'));
      expect(chips()).toHaveLength(3);
    });

    test('Terminal in the + menu opens the host login shell', async () => {
      host();
      await openMenu();
      fireEvent.click(await screen.findByText('Terminal'));
      await waitFor(() => expect(rpc('shells.launchPlain')).toEqual([{ projectId: 7 }]));
      await waitFor(() => expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('6'));
    });

    test('the star sets and clears the host default, and × on a project profile removes it on the host', async () => {
      host();
      await openMenu();
      fireEvent.click(await screen.findByRole('button', { name: 'Set mine as folder default' }));
      await waitFor(() => expect(rpc('shells.setDefaultCli')).toEqual([{ projectId: 7, name: 'mine' }]));
      fireEvent.click(await screen.findByRole('button', { name: 'Clear folder default' }));
      await waitFor(() => expect(rpc('shells.setDefaultCli')).toEqual([{ projectId: 7, name: 'mine' }, { projectId: 7, name: null }]));
      fireEvent.click(screen.getByRole('button', { name: 'Remove mine from this project' }));
      await waitFor(() => expect(rpc('shells.removeCliProfile')).toEqual([{ projectId: 7, name: 'mine' }]));
      await waitFor(() => expect(screen.queryByText('mine')).toBeNull());
    });

    test('an older host without profile support shows the menu error and still offers Terminal', async () => {
      host({ profilesFail: true });
      await openMenu();
      expect(await screen.findByRole('alert')).toBeTruthy();
      expect(screen.getByText('Terminal')).toBeTruthy();
    });

    test('× on a tab kills that shell on the host, drops it at once and shows a remaining tab', async () => {
      host();
      render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
      await waitFor(() => expect(chips()).toHaveLength(2));
      expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('2');
      fireEvent.click(screen.getByRole('button', { name: 'Close Claude' }));
      await waitFor(() => expect(rpc('shells.kill')).toEqual([{ projectId: 7, shellIndex: 2 }]));
      await waitFor(() => expect(chips().map((c) => c.textContent)).toEqual(['Opencode']));
      expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('3');
    });

    test('closing the last tab leaves no terminal attached and points at +', async () => {
      host();
      alive = [{ projectId: 7, shellIndex: 2, launchArgv: ['claude'] }];
      invoke.mockImplementation(async (_ch: string, a: { method?: string }) => {
        if (a?.method === 'shells.launch') return { result: { shellIndex: 2 } };
        if (a?.method === 'shells.alive') return { result: alive };
        if (a?.method === 'shells.kill') { alive = []; return { result: { ok: true } }; }
        if (a?.method === 'workspace.info') throw new Error('unknown_method');
        return {};
      });
      render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
      await waitFor(() => expect(chips()).toHaveLength(1));
      fireEvent.click(screen.getByRole('button', { name: 'Close Claude' }));
      expect(await screen.findByTestId('remote-no-shells')).toBeTruthy();
      expect(screen.queryByTestId('shell-tab')).toBeNull();
      expect(screen.getByTestId('tabbar-new-shell')).toBeTruthy();
    });

    test('App\'s ⌘T / ⌘W reach the shown remote tab through the commands context, only while Shell is showing', async () => {
      host();
      const commands = { current: null as RemoteShellCommands | null };
      render(<RemoteShellCommandsContext.Provider value={commands}>
        <RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />
      </RemoteShellCommandsContext.Provider>);
      await waitFor(() => expect(chips()).toHaveLength(2));
      act(() => commands.current!.closeActive());
      await waitFor(() => expect(rpc('shells.kill')).toEqual([{ projectId: 7, shellIndex: 2 }]));
      act(() => commands.current!.newTab());
      await waitFor(() => expect(rpc('shells.launchPlain')).toEqual([{ projectId: 7 }]));
      fireEvent.click(screen.getByRole('button', { name: 'Files' }));
      await waitFor(() => expect(commands.current).toBeNull());
    });
  });

  describe('parity with the local tabs (AC7, AC9–AC11, AC14–AC21, AC27, AC29)', () => {
    type Handler = (params: Record<string, unknown>) => unknown;
    const LOCAL_IPC = ['shells:launch-plain', 'shells:kill', 'windows:popout-shell'];
    const rpc = (method: string) => invoke.mock.calls.filter(([, a]) => a?.method === method).map(([, a]) => a.params);
    const localIpc = () => invoke.mock.calls.filter(([ch]) => LOCAL_IPC.includes(ch as string));
    const chipAt = (i: number) => chips().find((c) => c.getAttribute('data-shell-index') === String(i));
    const shown = () => screen.queryByTestId('shell-tab')?.getAttribute('data-shell') ?? null;
    const row = (shellIndex: number, launchArgv: string[], extra: Record<string, unknown> = {}) => ({ projectId: 7, shellIndex, launchArgv, ...extra });
    function deferred<T>() {
      let resolve!: (v: T) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    }
    const PROFILES = { profiles: [{ name: 'claude', scope: 'global' }, { name: 'mine', scope: 'project' }], defaultName: 'claude' };
    function fakeHost(handlers: Record<string, Handler> = {}) {
      invoke.mockImplementation(async (ch: string, a: { method?: string; params?: Record<string, unknown> }) => {
        if (ch !== 'p2p:rpc-call') return {};
        const handler = a.method ? handlers[a.method] : undefined;
        if (handler) return { result: await handler(a.params ?? {}) };
        if (a.method === 'shells.launch') return { result: { shellIndex: 2 } };
        if (a.method === 'shells.alive') return { result: alive };
        if (a.method === 'shells.cliProfiles') return { result: PROFILES };
        if (a.method === 'workspace.info') throw new Error('unknown_method');
        return { result: { ok: true } };
      });
    }
    function renderPane(extra: { deviceName?: string; projectName?: string; commands?: { current: RemoteShellCommands | null } } = {}) {
      const pane = <RemoteProjectPane deviceId="tower" deviceName={extra.deviceName ?? 'Tower'} projectId={7} projectName={extra.projectName ?? 'alpha'} />;
      return render(extra.commands ? <RemoteShellCommandsContext.Provider value={extra.commands}>{pane}</RemoteShellCommandsContext.Provider> : pane);
    }

    test('the identity truncates and carries the full "<project> @ <machine>" as its title (AC29)', async () => {
      const long = 'a-very-long-project-name-that-would-push-the-tabs-out-of-the-header-row';
      renderPane({ projectName: long, deviceName: 'Tower' });
      const label = screen.getByTitle(`${long} @ Tower`);
      expect(label.textContent).toBe(`${long} @ Tower`);
      expect(label.classList.contains('truncate')).toBe(true);
      expect(label.classList.contains('min-w-0')).toBe(true);
    });

    test.each(['', '  '])('a blank machine name (%j) shows as "The other machine" (AC29)', async (deviceName) => {
      fakeHost();
      alive = [];
      renderPane({ deviceName });
      expect(screen.getByTitle('alpha @ The other machine')).toBeTruthy();
    });

    test('standalone, the shell view root carries the shell sheet; in a header slot no pane element does (AC7)', async () => {
      fakeHost();
      const standalone = renderPane();
      await screen.findByTestId('shell-tab');
      expect(screen.getByTestId('remote-project-pane').querySelector('[data-sheet-content]')?.getAttribute('data-sheet-content')).toBe('shell');
      standalone.unmount();
      const header = document.createElement('header');
      document.body.appendChild(header);
      try {
        render(<WorkspaceHeaderSlotContext.Provider value={header}>
          <RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />
        </WorkspaceHeaderSlotContext.Provider>);
        await screen.findByTestId('shell-tab');
        expect(screen.getByTestId('remote-project-pane').querySelector('[data-sheet-content]')).toBeNull();
      } finally {
        cleanup();
        header.remove();
      }
    });

    test('chips show the host status dot only when the host reports a state, and no error otherwise (AC9)', async () => {
      fakeHost();
      alive = [row(2, ['claude'], { agent: 'claude', agentState: 'busy' }), row(3, ['opencode'])];
      renderPane();
      await waitFor(() => expect(chips()).toHaveLength(2));
      expect(chipAt(2)!.querySelectorAll('[data-testid="claude-dot"]')).toHaveLength(1);
      expect(chipAt(3)!.querySelectorAll('[data-testid="claude-dot"]')).toHaveLength(0);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByText(/Could not/)).toBeNull();
    });

    test('the menu never shows a command or environment the host sends with its profiles (AC10 viewer)', async () => {
      fakeHost({ 'shells.cliProfiles': () => ({ profiles: [{ name: 'mine', scope: 'project', argv: ['rm', '--dangerous'], env: { TOKEN: 's3cret' } }], defaultName: null }) });
      alive = [row(2, ['claude'])];
      renderPane();
      await waitFor(() => expect(chips()).toHaveLength(1));
      fireEvent.click(screen.getByTestId('tabbar-new-shell'));
      const mine = await screen.findByText('mine');
      expect(mine.closest('button')?.getAttribute('title')).toBe('mine');
      expect(document.body.innerHTML).not.toMatch(/dangerous|s3cret|TOKEN/);
      expect(screen.queryByText(/custom command/i)).toBeNull();
    });

    test('a tab opened from + shows at once as a selected "Terminal" chip and asks for focus on that host (AC11)', async () => {
      fakeHost({ 'shells.launchPlain': () => ({ shellIndex: 6 }) });
      alive = [row(2, ['claude']), row(3, ['opencode'])];
      renderPane();
      await waitFor(() => expect(chips()).toHaveLength(2));
      fireEvent.click(screen.getByTestId('tabbar-new-shell'));
      fireEvent.click(await screen.findByText('Terminal'));
      await waitFor(() => expect(shown()).toBe('6'));
      expect(chipAt(6)?.textContent).toBe('Terminal');
      expect(isActive(chipAt(6)!)).toBe(true);
      expect(focus.requestFocus).toHaveBeenLastCalledWith({ projectId: 7, shellIndex: 6, machine: 'tower' });
      expect(rpc('shells.launchPlain')).toEqual([{ projectId: 7 }]);
    });

    test('a failed launch on a current host toasts and changes no chip, selection or focus (AC11)', async () => {
      fakeHost({ 'shells.launchProfile': () => { throw new Error('unknown_profile: mine'); } });
      alive = [row(2, ['claude']), row(3, ['opencode'])];
      renderPane();
      await waitFor(() => expect(chips()).toHaveLength(2));
      fireEvent.click(screen.getByTestId('tabbar-new-shell'));
      fireEvent.click(await screen.findByText('mine'));
      await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Could not open a terminal on the remote machine', expect.objectContaining({ kind: 'error', detail: 'unknown_profile: mine' })));
      expect(rpc('shells.launchProfile')).toEqual([{ projectId: 7, profileName: 'mine' }]);
      expect(chips()).toHaveLength(2);
      expect(shown()).toBe('2');
      expect(focus.requestFocus).not.toHaveBeenCalled();
    });

    test('clicking a chip shows it and requests focus for that machine\'s terminal; the Shell destination requests that host\'s primary (AC18, AC19)', async () => {
      fakeHost();
      alive = [row(2, ['claude']), row(3, ['opencode'])];
      renderPane();
      fireEvent.click(await findChip('Opencode'));
      expect(shown()).toBe('3');
      expect(focus.cancelRequest).toHaveBeenCalled();
      expect(focus.requestFocus).toHaveBeenCalledWith({ projectId: 7, shellIndex: 3, machine: 'tower' });
      fireEvent.click(screen.getByRole('button', { name: 'Files' }));
      expect(focus.requestProjectFocus).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Shell' }));
      expect(focus.requestProjectFocus).toHaveBeenCalledWith(7, 'tower');
    });

    test('closing the shown picked tab falls back to the first-launched tab without a focus request (AC14)', async () => {
      fakeHost();
      alive = [row(2, ['claude']), row(3, ['opencode']), row(4, ['$SHELL'])];
      renderPane();
      fireEvent.click(await findChip('Terminal'));
      expect(shown()).toBe('4');
      focus.requestFocus.mockClear();
      focus.requestProjectFocus.mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'Close Terminal' }));
      expect(shown()).toBe('2');
      await waitFor(() => expect(rpc('shells.kill')).toEqual([{ projectId: 7, shellIndex: 4 }]));
      expect(focus.requestFocus).not.toHaveBeenCalled();
      expect(focus.requestProjectFocus).not.toHaveBeenCalled();
    });

    test('closing a tab that is not shown leaves the shown tab alone (AC14)', async () => {
      fakeHost();
      alive = [row(2, ['claude']), row(3, ['opencode']), row(4, ['$SHELL'])];
      renderPane();
      fireEvent.click(await findChip('Opencode'));
      fireEvent.click(screen.getByRole('button', { name: 'Close Terminal' }));
      await waitFor(() => expect(chips().map((c) => c.textContent)).toEqual(['Claude', 'Opencode']));
      expect(shown()).toBe('3');
    });

    test('the tab shown by fallback becomes the picked tab, so a later lower host shell does not take over (AC14)', async () => {
      fakeHost({ 'shells.kill': () => { alive = [row(1, ['codex']), row(3, ['opencode'])]; return { ok: true }; } });
      alive = [row(3, ['opencode']), row(4, ['$SHELL'])];
      renderPane();
      fireEvent.click(await findChip('Terminal'));
      fireEvent.click(screen.getByRole('button', { name: 'Close Terminal' }));
      expect(shown()).toBe('3');
      await findChip('Codex');
      expect(shown()).toBe('3');
    });

    test('a failed kill brings the chip back and toasts (AC14)', async () => {
      fakeHost({ 'shells.kill': () => { throw new Error('not connected'); } });
      alive = [row(2, ['claude']), row(3, ['opencode'])];
      renderPane();
      await waitFor(() => expect(chips()).toHaveLength(2));
      fireEvent.click(screen.getByRole('button', { name: 'Close Opencode' }));
      await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Could not close the remote terminal', expect.objectContaining({ kind: 'error', detail: 'not connected' })));
      await waitFor(() => expect(chips().map((c) => c.textContent)).toEqual(['Claude', 'Opencode']));
    });

    test('after the last tab closes nothing relaunches, and a shell the host lists later appears and shows (AC15)', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        fakeHost({ 'shells.kill': () => { alive = []; return { ok: true }; } });
        alive = [row(2, ['claude'])];
        renderPane();
        await waitFor(() => expect(chips()).toHaveLength(1));
        fireEvent.click(screen.getByRole('button', { name: 'Close Claude' }));
        expect((await screen.findByTestId('remote-no-shells')).textContent).toBe('No terminals open on Tower. Use + to open one.');
        await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
        expect(shown()).toBeNull();
        expect(rpc('shells.launch')).toHaveLength(1);
        expect(rpc('shells.launchPlain')).toHaveLength(0);
        alive = [row(5, ['opencode'])];
        await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
        await waitFor(() => expect(shown()).toBe('5'));
        expect(chips().map((c) => c.textContent)).toEqual(['Opencode']);
        expect(screen.queryByTestId('remote-no-shells')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    test('a poll that lists the new shell before its launch returns leaves exactly one chip, selected on return (AC17)', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const launch = deferred<{ shellIndex: number }>();
        fakeHost({ 'shells.launchPlain': () => launch.promise });
        alive = [row(2, ['claude'])];
        const commands = { current: null as RemoteShellCommands | null };
        renderPane({ commands });
        await waitFor(() => expect(chips()).toHaveLength(1));
        act(() => commands.current!.newTab());
        alive = [row(2, ['claude']), row(6, ['opencode'])];
        await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
        await waitFor(() => expect(chips()).toHaveLength(2));
        expect(shown()).toBe('2');
        await act(async () => { launch.resolve({ shellIndex: 6 }); });
        await waitFor(() => expect(shown()).toBe('6'));
        expect(chips().map((c) => c.getAttribute('data-shell-index'))).toEqual(['2', '6']);
        expect(chipAt(6)?.textContent).toBe('Opencode');
        alive = [row(2, ['claude'])];
        await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
        await waitFor(() => expect(chips().map((c) => c.getAttribute('data-shell-index'))).toEqual(['2']));
      } finally {
        vi.useRealTimers();
      }
    });

    test('two quick new tabs make two calls and two chips; the call that returned last is selected (AC17)', async () => {
      const calls = [deferred<{ shellIndex: number }>(), deferred<{ shellIndex: number }>()];
      let n = 0;
      fakeHost({ 'shells.launchPlain': () => calls[n++]!.promise });
      alive = [row(2, ['claude'])];
      const commands = { current: null as RemoteShellCommands | null };
      renderPane({ commands });
      await waitFor(() => expect(chips()).toHaveLength(1));
      act(() => { commands.current!.newTab(); commands.current!.newTab(); });
      await waitFor(() => expect(rpc('shells.launchPlain')).toHaveLength(2));
      await act(async () => { calls[1]!.resolve({ shellIndex: 7 }); });
      await waitFor(() => expect(shown()).toBe('7'));
      await act(async () => { calls[0]!.resolve({ shellIndex: 6 }); });
      await waitFor(() => expect(shown()).toBe('6'));
      expect(chips().map((c) => c.getAttribute('data-shell-index'))).toEqual(['2', '6', '7']);
    });

    test('a poll that still lists a shell whose kill was sent does not bring its chip back (AC17)', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const kill = deferred<{ ok: boolean }>();
        fakeHost({ 'shells.kill': () => kill.promise });
        alive = [row(2, ['claude']), row(3, ['opencode'])];
        renderPane();
        await waitFor(() => expect(chips()).toHaveLength(2));
        fireEvent.click(screen.getByRole('button', { name: 'Close Opencode' }));
        await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
        await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
        expect(chips().map((c) => c.textContent)).toEqual(['Claude']);
        alive = [row(2, ['claude'])];
        await act(async () => { kill.resolve({ ok: true }); });
        await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
        expect(chips().map((c) => c.textContent)).toEqual(['Claude']);
      } finally {
        vi.useRealTimers();
      }
    });

    test('a new notice switches to its shell even over a tab picked since, and p2p:viewing names it (AC17)', async () => {
      fakeHost();
      alive = [row(2, ['claude']), row(3, ['opencode']), row(4, ['$SHELL'])];
      const viewing = () => invoke.mock.calls.filter((c) => c[0] === 'p2p:viewing').map((c) => (c[1] as { shell: unknown }).shell);
      const project = { deviceId: 'tower', deviceName: 'Tower', projectId: 7, projectName: 'alpha' };
      const { rerender } = render(<RemoteProjectPane {...project} openRequest={{ shellIndex: 3 }} />);
      await waitFor(() => expect(shown()).toBe('3'));
      fireEvent.click(await findChip('Terminal'));
      expect(shown()).toBe('4');
      rerender(<RemoteProjectPane {...project} openRequest={{ shellIndex: 3 }} />);
      await waitFor(() => expect(shown()).toBe('3'));
      await waitFor(() => expect(viewing().at(-1)).toEqual({ deviceId: 'tower', projectId: 7, shellIndex: 3 }));
    });

    test('against an older host, chips still list, switch and close; opening a terminal toasts and adds no chip (AC21)', async () => {
      const older = (m: string): Handler => () => { throw new Error(`unknown method: ${m}`); };
      fakeHost(Object.fromEntries(['shells.cliProfiles', 'shells.launchProfile', 'shells.launchPlain', 'shells.removeCliProfile', 'shells.setDefaultCli'].map((m) => [m, older(m)])));
      alive = [row(2, ['claude']), row(3, ['opencode'])];
      const commands = { current: null as RemoteShellCommands | null };
      renderPane({ commands });
      fireEvent.click(await findChip('Opencode'));
      expect(shown()).toBe('3');
      expect(document.querySelectorAll('[data-testid="claude-dot"]')).toHaveLength(0);
      fireEvent.click(screen.getByTestId('tabbar-new-shell'));
      expect((await screen.findByRole('alert')).textContent).toBe('Tower needs a newer version of MetaLogix IDE to open terminals from here. Update it on that machine, then open this menu again.');
      fireEvent.click(screen.getByText('Terminal'));
      await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Could not open a terminal on the remote machine', expect.objectContaining({ kind: 'error' })));
      act(() => commands.current!.newTab());
      await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(2));
      expect(chips()).toHaveLength(2);
      fireEvent.click(screen.getByRole('button', { name: 'Close Opencode' }));
      await waitFor(() => expect(rpc('shells.kill')).toEqual([{ projectId: 7, shellIndex: 3 }]));
      await waitFor(() => expect(chips().map((c) => c.textContent)).toEqual(['Claude']));
      expect(localIpc()).toEqual([]);
    });

    test.each([
      ['forbidden', 'workspace access requires a grant from the host'],
      ['custom_command', 'custom_command: the project has a custom launch command'],
      ['unknown_profile', 'unknown_profile: mine'],
      ['a timeout', 'rpc timeout'],
    ])('a failed star (%s) toasts "Could not set default" with a detail and leaves the star as it was (AC27)', async (_label, message) => {
      fakeHost({ 'shells.setDefaultCli': () => { throw new Error(message); } });
      alive = [row(2, ['claude'])];
      renderPane();
      await waitFor(() => expect(chips()).toHaveLength(1));
      fireEvent.click(screen.getByTestId('tabbar-new-shell'));
      fireEvent.click(await screen.findByRole('button', { name: 'Set mine as folder default' }));
      await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Could not set default', expect.objectContaining({ kind: 'error', detail: message })));
      expect(screen.getByRole('button', { name: 'Set mine as folder default' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Clear folder default' })).toBeTruthy();
    });

    test('a refused remove stays silent and keeps the profile listed (AC27)', async () => {
      fakeHost({ 'shells.removeCliProfile': () => { throw new Error('workspace access requires a grant from the host'); } });
      alive = [row(2, ['claude'])];
      renderPane();
      await waitFor(() => expect(chips()).toHaveLength(1));
      fireEvent.click(screen.getByTestId('tabbar-new-shell'));
      fireEvent.click(await screen.findByRole('button', { name: 'Remove mine from this project' }));
      await waitFor(() => expect(rpc('shells.removeCliProfile')).toEqual([{ projectId: 7, name: 'mine' }]));
      await act(async () => {});
      expect(screen.getByText('mine')).toBeTruthy();
      expect(toastSpy).not.toHaveBeenCalled();
    });

    test('after a remove the menu shows the host\'s list again, so a global profile of that name takes its place (AC27)', async () => {
      let removed = false;
      fakeHost({
        'shells.removeCliProfile': () => { removed = true; return { ok: true }; },
        'shells.cliProfiles': () => ({ profiles: [{ name: 'claude', scope: 'global' }, { name: 'mine', scope: removed ? 'global' : 'project' }], defaultName: null }),
      });
      alive = [row(2, ['claude'])];
      renderPane();
      await waitFor(() => expect(chips()).toHaveLength(1));
      fireEvent.click(screen.getByTestId('tabbar-new-shell'));
      fireEvent.click(await screen.findByRole('button', { name: 'Remove mine from this project' }));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove mine from this project' })).toBeNull());
      expect(screen.getByText('mine')).toBeTruthy();
    });

    test('if the host list cannot be read again after a remove, the removed profile still leaves the menu (AC27)', async () => {
      let reads = 0;
      fakeHost({ 'shells.cliProfiles': () => { if (reads++ > 0) throw new Error('rpc timeout'); return PROFILES; } });
      alive = [row(2, ['claude'])];
      renderPane();
      await waitFor(() => expect(chips()).toHaveLength(1));
      fireEvent.click(screen.getByTestId('tabbar-new-shell'));
      fireEvent.click(await screen.findByRole('button', { name: 'Remove mine from this project' }));
      await waitFor(() => expect(screen.queryByText('mine')).toBeNull());
      expect(screen.getByText('claude')).toBeTruthy();
    });
  });

  test('the close button calls onClose', () => {
    const onClose = vi.fn();
    render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" onClose={onClose} />);
    fireEvent.click(screen.getByTestId('remote-pane-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
