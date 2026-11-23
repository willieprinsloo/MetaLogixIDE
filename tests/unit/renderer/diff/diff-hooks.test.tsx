// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffEntry } from '@renderer/diff/diff-selection';
import { useDiffSides } from '@renderer/hooks/useDiffSides';
import { useGitChanges } from '@renderer/hooks/useGitChanges';
import { remoteWorkspace } from '@renderer/p2p/remote-workspace';
import type { IpcContract } from '@shared/ipc-contract';

const invoke = vi.hoisted(() => vi.fn<(channel: string, request: object) => Promise<unknown>>());
vi.mock('@renderer/api', () => ({ api: { invoke } }));

type PanelStatus = IpcContract['git:panel-status']['response'];
type DiffSides = IpcContract['git:diff-sides']['response'];

function status(path: string): PanelStatus {
  return { isRepo: true, branch: 'main', ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [path] };
}

function loaded(path: string) {
  return { phase: 'ready', lists: { staged: [], unstaged: [], untracked: [path] } };
}

beforeEach(() => {
  invoke.mockImplementation(async (channel) => { throw new Error(`Unexpected request: ${channel}`); });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
  vi.useRealTimers();
});

describe('useGitChanges', () => {
  it('skips local polling while loading but lets manual refresh supersede a slow status read', async () => {
    vi.useFakeTimers();
    const earlier = Promise.withResolvers<PanelStatus>();
    const refreshed = Promise.withResolvers<PanelStatus>();
    invoke.mockReturnValueOnce(earlier.promise).mockReturnValueOnce(refreshed.promise);
    const view = renderHook(() => useGitChanges(9, 1000));
    expect(view.result.current.state).toEqual({ phase: 'loading' });
    expect(invoke.mock.calls).toEqual([['git:panel-status', { projectId: 9 }]]);
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(invoke).toHaveBeenCalledTimes(1);

    act(() => { view.result.current.refresh(); });
    expect(invoke).toHaveBeenNthCalledWith(2, 'git:panel-status', { projectId: 9 });
    await act(async () => { refreshed.resolve(status('fresh.ts')); });
    expect(view.result.current.state).toEqual(loaded('fresh.ts'));
    expect(view.result.current.reloadToken).toBe(1);
    await act(async () => { earlier.resolve(status('old.ts')); });
    expect(view.result.current.state).toEqual(loaded('fresh.ts'));
    expect(view.result.current.reloadToken).toBe(1);
  });

  it('coalesces repeated remote refreshes, reports the current failure, and runs one queued retry', async () => {
    vi.useFakeTimers();
    const first = Promise.withResolvers<{ result: PanelStatus }>();
    const retry = Promise.withResolvers<{ result: PanelStatus }>();
    invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    const remote = remoteWorkspace('host-a');
    const view = renderHook(() => useGitChanges(9, 1000, remote));
    const request = { deviceId: 'host-a', method: 'workspace.diffStatus', params: { projectId: 9 } };
    expect(invoke.mock.calls).toEqual([['p2p:rpc-call', request]]);
    act(() => {
      view.result.current.refresh();
      view.result.current.refresh();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => { first.reject(new Error('Host temporarily unavailable')); });
    expect(view.result.current.state).toEqual({ phase: 'error', message: 'Host temporarily unavailable' });
    expect(view.result.current.reloadToken).toBe(1);
    expect(invoke).toHaveBeenNthCalledWith(2, 'p2p:rpc-call', request);
    await act(async () => { retry.resolve({ result: status('host.txt') }); });
    expect(view.result.current.state).toEqual(loaded('host.txt'));
    expect(view.result.current.reloadToken).toBe(2);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('drops an old peer’s outstanding refresh when switching to a peer with the same project ID', async () => {
    const earlier = Promise.withResolvers<{ result: PanelStatus }>();
    invoke.mockReturnValueOnce(earlier.promise).mockResolvedValueOnce({ result: status('peer-b.txt') });
    const peerA = remoteWorkspace('host-a');
    const peerB = remoteWorkspace('host-b');
    const view = renderHook(({ remote }) => useGitChanges(9, 60_000, remote), { initialProps: { remote: peerA } });
    act(() => { view.result.current.refresh(); });
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => { view.rerender({ remote: peerB }); });
    expect(view.result.current.state).toEqual(loaded('peer-b.txt'));
    await act(async () => { earlier.reject(new Error('Old peer disconnected')); });
    expect(view.result.current.state).toEqual(loaded('peer-b.txt'));
    expect(view.result.current.reloadToken).toBe(1);
    expect(invoke.mock.calls).toEqual([
      ['p2p:rpc-call', { deviceId: 'host-a', method: 'workspace.diffStatus', params: { projectId: 9 } }],
      ['p2p:rpc-call', { deviceId: 'host-b', method: 'workspace.diffStatus', params: { projectId: 9 } }],
    ]);
  });
});

describe('useDiffSides', () => {
  const entry: DiffEntry = { group: 'unstaged', path: 'working.ts', status: 'M' };
  const key = 'unstaged:working.ts';

  it('discards a superseded local rejection for the same path after manual refresh loads new data', async () => {
    const earlier = Promise.withResolvers<DiffSides>();
    const fresh: DiffSides = {
      status: 'ok',
      diff: '@@ -1 +1 @@\n-old\n+new\n',
      diffHash: 'fresh-hash',
      oldSide: { text: 'old\n' },
      newSide: { text: 'new\n' },
    };
    invoke.mockReturnValueOnce(earlier.promise).mockResolvedValueOnce(fresh);
    const view = renderHook(({ refresh }) => useDiffSides(9, entry, 0, refresh), { initialProps: { refresh: 0 } });
    const request = { projectId: 9, kind: 'unstaged', path: 'working.ts' };
    expect(view.result.current).toEqual({ status: 'loading', key });
    expect(invoke.mock.calls).toEqual([['git:diff-sides', request]]);
    await act(async () => { view.rerender({ refresh: 1 }); });
    expect(invoke).toHaveBeenNthCalledWith(2, 'git:diff-sides', request);
    expect(view.result.current).toEqual({ key, ...fresh });
    await act(async () => { earlier.reject(new Error('Stale failure')); });
    expect(view.result.current).toEqual({ key, ...fresh });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('settles a rejected remote request and retries only once for queued refreshes', async () => {
    const first = Promise.withResolvers<{ result: DiffSides }>();
    const second = Promise.withResolvers<{ result: DiffSides }>();
    invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const remote = remoteWorkspace('host-a');
    const view = renderHook(({ refresh }) => useDiffSides(9, entry, 0, refresh, remote), { initialProps: { refresh: 0 } });
    const request = { deviceId: 'host-a', method: 'workspace.diffSides', params: { projectId: 9, kind: 'unstaged', path: 'working.ts' } };
    expect(invoke.mock.calls).toEqual([['p2p:rpc-call', request]]);
    view.rerender({ refresh: 1 });
    view.rerender({ refresh: 2 });
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => { first.reject(new Error('Sides unavailable')); });
    expect(view.result.current).toEqual({ status: 'error', key, message: 'Sides unavailable' });
    expect(invoke).toHaveBeenNthCalledWith(2, 'p2p:rpc-call', request);
    await act(async () => { second.resolve({ result: { status: 'too-large' } }); });
    expect(view.result.current).toEqual({ status: 'too-large', key });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
