// @vitest-environment jsdom
/**
 * RemoteMachineList (docs/specs/machine-switcher-dots.md AC14, AC16–AC20, AC22–AC24, AC31): the
 * selected paired machine's header and project list, with RPCs mocked at the IPC bridge.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@renderer/api', () => ({ api: { invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} } }));
const toast = vi.fn();
vi.mock('@renderer/hooks/useToasts', () => ({ toast: (...a: unknown[]) => toast(...a) }));

import { RemoteMachineList } from '../RemoteMachineList';
import { MACHINE_TESTIDS } from '@renderer/sidebar-copy';
import type { MachineDot } from '@renderer/machine-switcher-contract';

const HOUR = 3600_000;
const iso = (hAgo: number) => new Date(Date.now() - hAgo * HOUR).toISOString();

const TOWER: MachineDot = { deviceId: 'tower', name: 'Tower', online: true, lastSeenAt: 1, self: false };
const OFFLINE: MachineDot = { ...TOWER, online: false, lastSeenAt: Date.now() - 3 * HOUR };

function proj(id: number, name: string, rootId: number, lastOpenedAt: string | null = null) {
  return { id, name, rootId, path: `/r${rootId}/${name}`, lastOpenedAt, config: {} };
}

let projectsReply: () => Promise<unknown>;
const PROJECTS = [
  proj(1, 'live', 1, iso(0)),
  proj(2, 'older', 1, iso(5)),
  proj(3, 'newer', 2, iso(1)),
  proj(4, 'plain', 2),
  proj(5, 'stray', 99),
];

beforeEach(() => {
  invoke.mockReset();
  toast.mockReset();
  projectsReply = async () => ({ result: PROJECTS });
  invoke.mockImplementation(async (ch: string, a: { method?: string }) => {
    if (ch === 'p2p:rpc-call' && a.method === 'projects.list') return projectsReply();
    if (ch === 'p2p:rpc-call' && a.method === 'roots.list') return { result: [{ id: 1, path: '/work' }, { id: 2, path: '/play' }] };
    if (ch === 'p2p:rpc-call' && a.method === 'shells.alive') return { result: [{ projectId: 1, shellIndex: 0 }] };
    throw new Error(`unexpected ${ch}`);
  });
});

afterEach(() => cleanup());

const rpc = () => invoke.mock.calls.filter((c) => c[0] === 'p2p:rpc-call').map((c) => c[1] as { deviceId: string; method: string });
const projectListCalls = () => rpc().filter((c) => c.method === 'projects.list').length;
const rowNames = (el: HTMLElement = document.body) =>
  within(el).queryAllByTestId(MACHINE_TESTIDS.remoteProjectRow).map((r) => r.textContent);
const show = (machine: MachineDot = TOWER, filter = '', onOpenPane = vi.fn()) =>
  render(<RemoteMachineList machine={machine} filter={filter} onOpenPane={onOpenPane} />);

describe('RemoteMachineList online (AC16, AC31)', () => {
  test('lists In use, Recents, then folders per root with orphans last, fetching only this device', async () => {
    show();
    await screen.findByTestId(MACHINE_TESTIDS.remoteInUse);
    await waitFor(() => expect(rowNames(screen.getByTestId(MACHINE_TESTIDS.remoteInUse))).toEqual(['live']));
    expect(rowNames(screen.getByTestId(MACHINE_TESTIDS.remoteRecents))).toEqual(['newer', 'older']);
    expect(rowNames(screen.getByTestId(MACHINE_TESTIDS.remoteFolders))).toEqual(['live', 'older', 'newer', 'plain', 'stray']);
    const folders = within(screen.getByTestId(MACHINE_TESTIDS.remoteFolders)).getAllByRole('button', { expanded: true });
    expect(folders.map((b) => b.textContent)).toEqual(['Projects', 'work1/2', 'play2']);
    const sections: string[] = [MACHINE_TESTIDS.remoteHeader, MACHINE_TESTIDS.remoteInUse, MACHINE_TESTIDS.remoteRecents, MACHINE_TESTIDS.remoteFolders];
    const list = screen.getByTestId(MACHINE_TESTIDS.remoteList);
    expect([...list.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')).filter((id) => sections.includes(id!)))
      .toEqual(sections);
    expect(new Set(rpc().map((c) => c.deviceId))).toEqual(new Set(['tower']));
    expect(new Set(rpc().map((c) => c.method))).toEqual(new Set(['projects.list', 'roots.list', 'shells.alive']));
    expect(projectListCalls()).toBe(1);
  });

  test('the header is the first child of the list and names the machine, its state and Reconnect', async () => {
    show();
    const list = screen.getByTestId(MACHINE_TESTIDS.remoteList);
    const header = screen.getByTestId(MACHINE_TESTIDS.remoteHeader);
    expect(list.firstElementChild).toBe(header);
    expect(within(header).getByText('Tower')).toBeTruthy();
    expect(within(header).getByText('online')).toBeTruthy();
    expect(within(header).getByRole('button', { name: 'Reconnect to Tower' }).textContent).toBe('Reconnect');
    expect(screen.queryByTestId(MACHINE_TESTIDS.remoteLastSeen)).toBeNull();
    await screen.findByTestId(MACHINE_TESTIDS.remoteFolders);
  });

  test('a long name truncates with the full name in its title', () => {
    const name = 'An extremely long machine name that cannot fit in a sidebar';
    show({ ...TOWER, name });
    const el = within(screen.getByTestId(MACHINE_TESTIDS.remoteHeader)).getByText(name);
    expect(el.classList).toContain('truncate');
    expect(el.classList).toContain('min-w-0');
    expect(el.getAttribute('title')).toBe(name);
  });

  test('hides an empty In use and Recents', async () => {
    projectsReply = async () => ({ result: [proj(9, 'solo', 1)] });
    invoke.mockImplementation(async (ch: string, a: { method?: string }) => {
      if (a.method === 'projects.list') return projectsReply();
      if (a.method === 'roots.list') return { result: [{ id: 1, path: '/work' }] };
      return { result: [] };
    });
    show();
    await waitFor(() => expect(rowNames()).toEqual(['solo']));
    expect(screen.queryByTestId(MACHINE_TESTIDS.remoteInUse)).toBeNull();
    expect(screen.queryByTestId(MACHINE_TESTIDS.remoteRecents)).toBeNull();
  });
});

describe('RemoteMachineList loading and errors (AC17)', () => {
  test('shows "Loading…" while the project list is pending, then the rows', async () => {
    let resolve!: (v: unknown) => void;
    projectsReply = () => new Promise((r) => { resolve = r; });
    show();
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.queryByTestId(MACHINE_TESTIDS.remoteFolders)).toBeNull();
    resolve({ result: PROJECTS });
    await screen.findByTestId(MACHINE_TESTIDS.remoteFolders);
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  test('keeps "Loading…" until the roots arrive, so projects never flash as orphans', async () => {
    let resolveRoots!: (v: unknown) => void;
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation((ch: string, a: { method?: string }) => (
      a.method === 'roots.list' ? new Promise((r) => { resolveRoots = r; }) : base(ch, a)
    ));
    show();
    await waitFor(() => expect(projectListCalls()).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(rowNames()).toEqual([]);
    resolveRoots({ result: [{ id: 1, path: '/work' }, { id: 2, path: '/play' }] });
    await waitFor(() => expect(rowNames(screen.getByTestId(MACHINE_TESTIDS.remoteFolders))).toEqual(['live', 'older', 'newer', 'plain', 'stray']));
  });

  test('a failed roots call (older host) still lists every project, as orphans', async () => {
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation((ch: string, a: { method?: string }) => (
      a.method === 'roots.list' ? Promise.reject(new Error('method_not_found')) : base(ch, a)
    ));
    show();
    await waitFor(() => expect(rowNames(screen.getByTestId(MACHINE_TESTIDS.remoteFolders))).toEqual(['live', 'older', 'newer', 'plain', 'stray']));
    expect(screen.queryByText('method_not_found')).toBeNull();
  });

  test('shows the failed call\'s message and no retry button', async () => {
    projectsReply = async () => { throw new Error('peer_unreachable'); };
    show();
    expect(await screen.findByText('peer_unreachable')).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.queryByTestId(MACHINE_TESTIDS.remoteFolders)).toBeNull();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Reconnect']);
  });
});

describe('RemoteMachineList rows (AC18)', () => {
  test('clicking a row asks App to open that remote project', async () => {
    const onOpenPane = vi.fn();
    show(TOWER, '', onOpenPane);
    await waitFor(() => expect(rowNames()).toContain('plain'));
    fireEvent.click(screen.getAllByTestId(MACHINE_TESTIDS.remoteProjectRow).find((r) => r.textContent === 'plain')!);
    expect(onOpenPane.mock.calls).toEqual([[{
      source: { kind: 'remote', deviceId: 'tower' }, deviceName: 'Tower', projectId: 4, projectName: 'plain',
    }]]);
  });
});

describe('RemoteMachineList filter (AC19)', () => {
  test('narrows every section by name, case-insensitively', async () => {
    const { rerender } = show();
    await waitFor(() => expect(rowNames()).toHaveLength(8));
    rerender(<RemoteMachineList machine={TOWER} filter="NEW" />);
    expect(screen.queryByTestId(MACHINE_TESTIDS.remoteInUse)).toBeNull();
    expect(rowNames(screen.getByTestId(MACHINE_TESTIDS.remoteRecents))).toEqual(['newer']);
    expect(rowNames(screen.getByTestId(MACHINE_TESTIDS.remoteFolders))).toEqual(['newer']);
    expect(within(screen.getByTestId(MACHINE_TESTIDS.remoteFolders)).queryByText('work')).toBeNull();
  });

  test('with no matches keeps only the Projects heading, with no rows and no message', async () => {
    const { rerender } = show();
    await screen.findByTestId(MACHINE_TESTIDS.remoteFolders);
    rerender(<RemoteMachineList machine={TOWER} filter="zzz" />);
    expect(screen.queryByTestId(MACHINE_TESTIDS.remoteInUse)).toBeNull();
    expect(screen.queryByTestId(MACHINE_TESTIDS.remoteRecents)).toBeNull();
    const folders = screen.getByTestId(MACHINE_TESTIDS.remoteFolders);
    expect(within(folders).getByRole('button').textContent).toBe('Projects');
    expect(rowNames()).toEqual([]);
    expect(screen.queryByText(/no match/i)).toBeNull();
  });
});

describe('RemoteMachineList offline (AC22, AC23, AC24)', () => {
  test('shows name, last seen and Reconnect, with no rows and no project fetch, ignoring the filter', async () => {
    show(OFFLINE, 'zzz');
    const header = screen.getByTestId(MACHINE_TESTIDS.remoteHeader);
    expect(within(header).getByText('Tower')).toBeTruthy();
    expect(within(header).getByText('offline')).toBeTruthy();
    expect(screen.getByTestId(MACHINE_TESTIDS.remoteLastSeen).textContent).toBe('last seen 3h ago');
    expect(within(header).getByRole('button', { name: 'Reconnect to Tower' })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(rowNames()).toEqual([]);
    expect(rpc()).toEqual([]);
  });

  test('"never seen" for a machine that was never online', () => {
    show({ ...OFFLINE, lastSeenAt: null });
    expect(screen.getByTestId(MACHINE_TESTIDS.remoteLastSeen).textContent).toBe('never seen');
  });

  test('going offline while shown hides the rows and shows the offline header', async () => {
    const { rerender } = show();
    await waitFor(() => expect(rowNames().length).toBeGreaterThan(0));
    rerender(<RemoteMachineList machine={OFFLINE} filter="" />);
    expect(rowNames()).toEqual([]);
    expect(screen.getByTestId(MACHINE_TESTIDS.remoteLastSeen).textContent).toBe('last seen 3h ago');
    expect(screen.queryByText('online')).toBeNull();
  });

  test('coming online while shown loads the project list', async () => {
    const { rerender } = show(OFFLINE);
    expect(projectListCalls()).toBe(0);
    rerender(<RemoteMachineList machine={TOWER} filter="" />);
    await waitFor(() => expect(rowNames().length).toBeGreaterThan(0));
    expect(projectListCalls()).toBe(1);
    expect(screen.queryByTestId(MACHINE_TESTIDS.remoteLastSeen)).toBeNull();
  });
});

describe('RemoteMachineList Reconnect (AC20)', () => {
  function reconnectButton() {
    return screen.getByTestId(MACHINE_TESTIDS.remoteReconnect) as HTMLButtonElement;
  }

  function withReconnect(reply: () => Promise<unknown>) {
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation((ch: string, a: unknown) => (ch === 'p2p:reconnect-device' ? reply() : base(ch, a)));
  }

  test('calls reconnect for this device, stays disabled until it settles, then toasts success', async () => {
    let resolve!: (v: unknown) => void;
    withReconnect(() => new Promise((r) => { resolve = r; }));
    show(OFFLINE);
    expect(reconnectButton().disabled).toBe(false);
    fireEvent.click(reconnectButton());
    expect(invoke.mock.calls.filter((c) => c[0] === 'p2p:reconnect-device')).toEqual([['p2p:reconnect-device', { deviceId: 'tower' }]]);
    expect(reconnectButton().disabled).toBe(true);
    fireEvent.click(reconnectButton());
    expect(invoke.mock.calls.filter((c) => c[0] === 'p2p:reconnect-device')).toHaveLength(1);
    expect(toast).not.toHaveBeenCalled();
    resolve({ ok: true });
    await waitFor(() => expect(reconnectButton().disabled).toBe(false));
    expect(toast.mock.calls).toEqual([['Reconnected to Tower', { kind: 'success', timeoutMs: 1500 }]]);
  });

  test('a failed reconnect re-enables the button and toasts the error as detail', async () => {
    withReconnect(async () => { throw new Error('relay_timeout'); });
    show(OFFLINE);
    fireEvent.click(reconnectButton());
    await waitFor(() => expect(reconnectButton().disabled).toBe(false));
    expect(toast.mock.calls).toEqual([['Reconnect failed', { kind: 'error', detail: 'relay_timeout' }]]);
  });
});

describe('RemoteMachineList collapse state (AC14 remote half, AC17)', () => {
  test('sections and roots collapse locally, and a remount resets them to open and refetches', async () => {
    const { rerender } = render(<RemoteMachineList key="a" machine={TOWER} filter="" />);
    await waitFor(() => expect(rowNames(screen.getByTestId(MACHINE_TESTIDS.remoteRecents))).toEqual(['newer', 'older']));
    const recentsToggle = within(screen.getByTestId(MACHINE_TESTIDS.remoteRecents)).getByRole('button', { name: 'Recents' });
    fireEvent.click(recentsToggle);
    expect(recentsToggle.getAttribute('aria-expanded')).toBe('false');
    expect(rowNames(screen.getByTestId(MACHINE_TESTIDS.remoteRecents))).toEqual([]);
    const workToggle = within(screen.getByTestId(MACHINE_TESTIDS.remoteFolders)).getByRole('button', { name: /work/ });
    fireEvent.click(workToggle);
    expect(workToggle.getAttribute('aria-expanded')).toBe('false');
    expect(rowNames(screen.getByTestId(MACHINE_TESTIDS.remoteFolders))).toEqual(['newer', 'plain', 'stray']);

    rerender(<RemoteMachineList key="b" machine={TOWER} filter="" />);
    await waitFor(() => expect(rowNames(screen.getByTestId(MACHINE_TESTIDS.remoteRecents))).toEqual(['newer', 'older']));
    expect(rowNames(screen.getByTestId(MACHINE_TESTIDS.remoteFolders))).toEqual(['live', 'older', 'newer', 'plain', 'stray']);
    expect(projectListCalls()).toBe(2);
  });
});
