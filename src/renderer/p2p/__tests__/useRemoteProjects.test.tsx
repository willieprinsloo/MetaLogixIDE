// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('../../api', () => ({ api: { invoke: (...a: unknown[]) => invoke(...a) } }));

import { useRemoteProjects } from '../useRemoteProjects';

beforeEach(() => { invoke.mockReset(); });

describe('useRemoteProjects', () => {
  test('useRemoteProjects(deviceId) fetches via p2p:rpc-call projects.list', async () => {
    invoke.mockResolvedValueOnce({ result: [{ id: 'p1', name: 'One' }] });
    const { result } = renderHook(() => useRemoteProjects('tower'));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(invoke).toHaveBeenCalledWith('p2p:rpc-call', { deviceId: 'tower', method: 'projects.list', params: {} });
    expect(result.current.projects).toEqual([{ id: 'p1', name: 'One' }]);
    expect(result.current.error).toBeUndefined();
  });

  test('useRemoteProjects refetches when deviceId changes', async () => {
    invoke.mockResolvedValue({ result: [] });
    const { rerender } = renderHook(({ id }) => useRemoteProjects(id), { initialProps: { id: 'a' } });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    rerender({ id: 'b' });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(invoke).toHaveBeenLastCalledWith('p2p:rpc-call', { deviceId: 'b', method: 'projects.list', params: {} });
  });

  test('useRemoteProjects surfaces errors from the RPC', async () => {
    invoke.mockRejectedValueOnce(new Error('peer offline'));
    const { result } = renderHook(() => useRemoteProjects('tower'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('peer offline');
    expect(result.current.projects).toEqual([]);
  });

  test('useRemoteProjects ignores a response that lands after unmount', async () => {
    let resolve!: (v: unknown) => void;
    invoke.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const { result, unmount } = renderHook(() => useRemoteProjects('tower'));
    expect(result.current.loading).toBe(true);
    const snapshot = result.current.projects;
    unmount();
    await act(async () => {
      resolve({ result: [{ id: 'p1', name: 'One' }] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.projects).toBe(snapshot);
    expect(result.current.loading).toBe(true);
  });
});
