// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('../../api', () => ({ api: { invoke: (...a: unknown[]) => invoke(...a) } }));

import { useFleet } from '../useFleet';

const FLEET = [
  { deviceId: 'laptop', name: 'Laptop', online: true, lastSeenAt: 1 },
  { deviceId: 'tower', name: 'Tower', online: false, lastSeenAt: null },
];

beforeEach(() => { invoke.mockReset(); });

describe('useFleet', () => {
  test('useFleet reports loading, then the fleet from the IPC bridge', async () => {
    invoke.mockResolvedValueOnce({ fleet: FLEET });
    const { result } = renderHook(() => useFleet());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.machines).toHaveLength(2);
    expect(invoke).toHaveBeenCalledWith('p2p:fleet-list', undefined);
  });

  test('useFleet.refresh re-invokes p2p:fleet-list', async () => {
    invoke.mockResolvedValue({ fleet: FLEET });
    const { result } = renderHook(() => useFleet());
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.refresh());
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  });

  test('useFleet surfaces errors', async () => {
    invoke.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useFleet());
    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.loading).toBe(false);
  });

  test('useFleet keeps the same machines array when a poll returns an equal fleet', async () => {
    invoke.mockImplementation(async () => ({ fleet: FLEET.map((m) => ({ ...m })) }));
    const { result } = renderHook(() => useFleet());
    await waitFor(() => expect(result.current.machines).toHaveLength(2));
    const first = result.current.machines;
    act(() => result.current.refresh());
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.machines).toBe(first);
  });

  test.each([
    ['online', { online: false }],
    ['lastSeenAt', { lastSeenAt: 2 }],
    ['name', { name: 'Laptop 2' }],
    ['self', { self: true }],
  ])('useFleet replaces the machines array when %s changes', async (_field, change) => {
    invoke.mockResolvedValueOnce({ fleet: FLEET.map((m) => ({ ...m })) });
    invoke.mockResolvedValueOnce({ fleet: [{ ...FLEET[0]!, ...change }, { ...FLEET[1]! }] });
    const { result } = renderHook(() => useFleet());
    await waitFor(() => expect(result.current.machines).toHaveLength(2));
    const first = result.current.machines;
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.machines).not.toBe(first));
    expect(result.current.machines[0]).toMatchObject(change);
  });

  test('useFleet replaces the machines array when the order or the count changes', async () => {
    invoke.mockResolvedValueOnce({ fleet: FLEET.map((m) => ({ ...m })) });
    invoke.mockResolvedValueOnce({ fleet: [{ ...FLEET[1]! }, { ...FLEET[0]! }] });
    invoke.mockResolvedValueOnce({ fleet: [{ ...FLEET[1]! }] });
    const { result } = renderHook(() => useFleet());
    await waitFor(() => expect(result.current.machines).toHaveLength(2));
    const first = result.current.machines;
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.machines[0]!.deviceId).toBe('tower'));
    expect(result.current.machines).not.toBe(first);
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.machines).toHaveLength(1));
  });

  test('useFleet ignores a response that lands after unmount', async () => {
    let resolve!: (v: unknown) => void;
    invoke.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const { result, unmount } = renderHook(() => useFleet());
    expect(result.current.loading).toBe(true);
    const snapshot = result.current.machines;
    unmount();
    await act(async () => {
      resolve({ fleet: [{ deviceId: 'x', name: 'X', online: true, lastSeenAt: 1 }] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.machines).toBe(snapshot);
    expect(result.current.loading).toBe(true);
  });
});
