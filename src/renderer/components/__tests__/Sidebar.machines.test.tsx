// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@renderer/api', () => ({ api: { invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} } }));

let fleet: unknown[] = [];
const remoteProjects = [{ id: 7, name: 'alpha', path: '/a', rootId: 1, config: {} }];
vi.mock('@renderer/hooks/useRoots', () => ({ useRoots: () => ({ roots: [], refresh: async () => {} }) }));
vi.mock('@renderer/hooks/useProjects', () => ({ useProjects: () => ({ projects: [], refresh: async () => {} }) }));
vi.mock('@renderer/hooks/useRecents', () => ({ useRecents: () => ({ recents: [] }) }));
vi.mock('@renderer/hooks/useAliveShellIds', () => ({ useAliveShellIds: () => ({ aliveIds: new Set<number>() }) }));
vi.mock('@renderer/hooks/useAgentStates', () => ({
  useOverallAgentState: () => 'idle', useProjectAgentState: () => 'idle',
}));
vi.mock('../SidebarHeader', () => ({ SidebarHeader: () => null }));
vi.mock('../ShellTab', () => ({ ShellTab: (p: { source: unknown }) => <div data-testid="shell-tab">{JSON.stringify(p.source)}</div> }));

import { Sidebar } from '../Sidebar';
import { RemoteProjectPane } from '../RemoteProjectPane';

const base = { selectedProjectId: null, onSelect: () => {}, onEditEnv: () => {} };
const rpcMethods = () => invoke.mock.calls.filter((c) => c[0] === 'p2p:rpc-call').map((c) => (c[1] as { method: string; deviceId: string }));

beforeEach(() => {
  cleanup();
  invoke.mockReset();
  invoke.mockImplementation(async (ch: string, a: { method?: string }) => {
    if (ch === 'p2p:fleet-list') return { fleet };
    if (a?.method === 'projects.list') return { result: remoteProjects };
    if (a?.method === 'shells.list') return { result: [{ shellIndex: 0 }, { shellIndex: 1 }] };
    if (a?.method === 'shells.launch') return { result: { shellIndex: 2 } };
    return {};
  });
  localStorage.clear();
});

describe('Sidebar Machines section', () => {
  test('renders a Machines section with one row per fleet entry', async () => {
    fleet = [{ deviceId: 'tower', name: 'Tower', online: true, lastSeenAt: 1 }];
    render(<Sidebar {...base} />);
    expect(await screen.findByRole('heading', { name: /Machines/i })).toBeTruthy();
    expect(screen.getByText('Tower')).toBeTruthy();
    expect(screen.getByText('⬤')).toBeTruthy();
  });

  test('offline machines render with the ○ indicator and last-seen text', async () => {
    fleet = [{ deviceId: 'nas', name: 'NAS', online: false, lastSeenAt: Date.now() - 3 * 3600_000 }];
    render(<Sidebar {...base} />);
    expect(await screen.findByText('○')).toBeTruthy();
    expect(screen.getByText(/last seen 3h ago/)).toBeTruthy();
  });

  test('collapsed machines fire no RPCs; expanding one fetches only that device; no "0 projects" flash', async () => {
    fleet = ['a', 'b', 'c'].map((id) => ({ deviceId: id, name: id.toUpperCase(), online: true, lastSeenAt: 1 }));
    render(<Sidebar {...base} />);
    await screen.findByText('A');
    expect(rpcMethods()).toEqual([]);
    expect(invoke.mock.calls.every((c) => c[0] === 'p2p:fleet-list')).toBe(true);

    fireEvent.click(screen.getByText('B'));
    expect(screen.queryByText(/0 projects/)).toBeNull();
    await screen.findByText(/1 project · 2 live shells/);
    const projectCalls = rpcMethods().filter((m) => m.method === 'projects.list');
    expect(projectCalls).toHaveLength(1);
    expect(rpcMethods().every((m) => m.deviceId === 'b')).toBe(true);
  });

  test('clicking a project under a remote machine opens a pane with source=remote', async () => {
    fleet = [{ deviceId: 'tower', name: 'Tower', online: true, lastSeenAt: 1 }];
    const onOpenPane = vi.fn();
    render(<Sidebar {...base} onOpenPane={onOpenPane} />);
    fireEvent.click(await screen.findByText('Tower'));
    fireEvent.click(await screen.findByText('alpha'));
    expect(onOpenPane).toHaveBeenCalledWith(expect.objectContaining({
      source: { kind: 'remote', deviceId: 'tower' }, projectId: 7,
    }));
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

  test('the close button calls onClose', () => {
    const onClose = vi.fn();
    render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" onClose={onClose} />);
    fireEvent.click(screen.getByTestId('remote-pane-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
