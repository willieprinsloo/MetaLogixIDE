// @vitest-environment jsdom
/** RemoteProjectPane: the main-area pane for a project on a paired machine (moved unchanged from Sidebar.machines.test.tsx). */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@renderer/api', () => ({ api: { invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} } }));
vi.mock('../ShellTab', () => ({ ShellTab: (p: { source: unknown; shellIndex: number }) => <div data-testid="shell-tab" data-shell={p.shellIndex}>{JSON.stringify(p.source)}</div> }));

import { RemoteProjectPane } from '../RemoteProjectPane';

let alive: unknown[] = [];

beforeEach(() => {
  cleanup();
  alive = [];
  invoke.mockReset();
  invoke.mockImplementation(async (_ch: string, a: { method?: string }) => {
    if (a?.method === 'shells.launch') return { result: { shellIndex: 2 } };
    if (a?.method === 'shells.alive') return { result: alive };
    return {};
  });
});

describe('RemoteProjectPane', () => {
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
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Claude', 'Opencode', 'Terminal']);
    // The launched shell is selected first.
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('2');

    fireEvent.click(screen.getByRole('tab', { name: /Opencode/ }));
    expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('3');
    expect(screen.getByRole('tab', { name: /Opencode/ }).getAttribute('aria-selected')).toBe('true');
  });

  test('a terminal where an agent was started by hand is labelled as that agent; repeats are numbered', async () => {
    alive = [
      { projectId: 7, shellIndex: 2, launchArgv: ['claude'], agent: 'claude', agentState: 'idle' },
      { projectId: 7, shellIndex: 3, launchArgv: ['$SHELL'], agent: 'opencode', agentState: 'busy' },
      { projectId: 7, shellIndex: 5, launchArgv: ['claude'], agent: null },
    ];
    render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Claude 1', 'opencode', 'Claude 2']);
  });

  test('falls back to the launched shell when the picked one is gone; no tab strip before the host lists shells', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
      await screen.findByTestId('shell-tab');
      expect(screen.queryByTestId('remote-shell-tabs')).toBeNull();

      alive = [{ projectId: 7, shellIndex: 2, launchArgv: ['claude'] }, { projectId: 7, shellIndex: 3, launchArgv: ['opencode'] }];
      await vi.advanceTimersByTimeAsync(3000);
      fireEvent.click(await screen.findByRole('tab', { name: 'Opencode' }));
      expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('3');

      alive = [{ projectId: 7, shellIndex: 2, launchArgv: ['claude'] }];
      await vi.advanceTimersByTimeAsync(3000);
      await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(1));
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
    fireEvent.click(await screen.findByRole('tab', { name: 'Opencode' }));
    await waitFor(() => expect(viewing().at(-1)).toEqual({ deviceId: 'tower', projectId: 7, shellIndex: 3 }));
    unmount();
    expect(viewing().at(-1)).toBeNull();
  });

  test('opens on the tab a fleet notice names, and on another when a later notice names that', async () => {
    alive = [{ projectId: 7, shellIndex: 2, launchArgv: ['claude'] }, { projectId: 7, shellIndex: 3, launchArgv: ['opencode'] }, { projectId: 7, shellIndex: 4, launchArgv: ['$SHELL'] }];
    const { rerender } = render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" initialShellIndex={3} />);
    await screen.findAllByRole('tab');
    await waitFor(() => expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('3'));
    rerender(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" initialShellIndex={4} />);
    await waitFor(() => expect(screen.getByTestId('shell-tab').getAttribute('data-shell')).toBe('4'));
  });

  test('the close button calls onClose', () => {
    const onClose = vi.fn();
    render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" onClose={onClose} />);
    fireEvent.click(screen.getByTestId('remote-pane-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
