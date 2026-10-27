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
