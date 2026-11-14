// @vitest-environment jsdom
/**
 * useMachineSwitcher (docs/specs/machine-switcher-dots.md AC6, AC9, AC10, AC11, AC12, AC15 and plan
 * ruling C2): the dot list from fleet + device name, the selection, and its fallback to this machine.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('../../api', () => ({ api: { invoke: (...a: unknown[]) => invoke(...a) } }));

import { useMachineSwitcher } from '../useMachineSwitcher';
import { LOCAL_MACHINE_ID } from '../../machine-switcher-contract';

type Reply = { fleet?: unknown } | Error | Promise<unknown>;
let fleetReplies: Reply[];
let settings: () => Promise<unknown>;

const TOWER = { deviceId: 'tower', name: 'Tower', online: true, lastSeenAt: 1 };
const ATLAS = { deviceId: 'atlas', name: 'Atlas', online: false, lastSeenAt: null };

function nextFleet(): Promise<unknown> {
  const r = fleetReplies.length > 1 ? fleetReplies.shift()! : fleetReplies[0]!;
  if (r instanceof Error) return Promise.reject(r);
  return Promise.resolve(r);
}

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

const pollOnce = () => flush(5000);

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  fleetReplies = [{ fleet: [] }];
  settings = async () => ({ deviceName: 'Laptop' });
  invoke.mockImplementation((ch: string) => {
    if (ch === 'p2p:fleet-list') return nextFleet();
    if (ch === 'p2p:settings-get') return settings();
    return Promise.reject(new Error(`unexpected ${ch}`));
  });
});

afterEach(() => { vi.useRealTimers(); });

const channels = () => invoke.mock.calls.map((c) => c[0] as string);

describe('useMachineSwitcher', () => {
  test('starts on this machine, with only the local dot before any peer is known', async () => {
    const { result } = renderHook(() => useMachineSwitcher());
    expect(result.current.activeId).toBe(LOCAL_MACHINE_ID);
    expect(result.current.active.self).toBe(true);
    await flush();
    expect(result.current.machines.map((m) => m.deviceId)).toEqual([LOCAL_MACHINE_ID]);
    expect(result.current.activeId).toBe(LOCAL_MACHINE_ID);
  });

  test('lists this machine first, then peers by name', async () => {
    fleetReplies = [{ fleet: [TOWER, ATLAS] }];
    const { result } = renderHook(() => useMachineSwitcher());
    await flush();
    expect(result.current.machines.map((m) => m.deviceId)).toEqual([LOCAL_MACHINE_ID, 'atlas', 'tower']);
    expect(result.current.machines[0]!.name).toBe('Laptop');
  });

  test('select(peer) makes it active; select(active) changes nothing and makes no IPC call', async () => {
    fleetReplies = [{ fleet: [TOWER] }];
    const { result } = renderHook(() => useMachineSwitcher());
    await flush();
    act(() => result.current.select('tower'));
    expect(result.current.activeId).toBe('tower');
    expect(result.current.active).toMatchObject({ deviceId: 'tower', name: 'Tower', self: false });
    const before = invoke.mock.calls.length;
    const snapshot = result.current;
    act(() => result.current.select('tower'));
    expect(result.current.activeId).toBe('tower');
    expect(result.current).toBe(snapshot);
    expect(invoke.mock.calls.length).toBe(before);
    act(() => result.current.select(LOCAL_MACHINE_ID));
    expect(result.current.activeId).toBe(LOCAL_MACHINE_ID);
  });

  test('a rejected fleet poll keeps the machine list and the selection (C2)', async () => {
    fleetReplies = [{ fleet: [TOWER] }, new Error('relay down'), { fleet: [TOWER] }];
    const { result } = renderHook(() => useMachineSwitcher());
    await flush();
    act(() => result.current.select('tower'));
    await pollOnce();
    expect(invoke.mock.calls.filter((c) => c[0] === 'p2p:fleet-list')).toHaveLength(2);
    expect(result.current.machines.map((m) => m.deviceId)).toEqual([LOCAL_MACHINE_ID, 'tower']);
    expect(result.current.activeId).toBe('tower');
  });

  test('falls back to this machine when the shown peer leaves, and stays there when it returns (AC15)', async () => {
    fleetReplies = [{ fleet: [TOWER, ATLAS] }, { fleet: [ATLAS] }, { fleet: [TOWER, ATLAS] }];
    const { result } = renderHook(() => useMachineSwitcher());
    await flush();
    act(() => result.current.select('tower'));
    await pollOnce();
    expect(result.current.activeId).toBe(LOCAL_MACHINE_ID);
    expect(result.current.active.self).toBe(true);
    await pollOnce();
    expect(result.current.machines.map((m) => m.deviceId)).toContain('tower');
    expect(result.current.activeId).toBe(LOCAL_MACHINE_ID);
  });

  test('a first peer found by a later poll grows the list to two dots (AC9)', async () => {
    fleetReplies = [{ fleet: [] }, { fleet: [TOWER] }];
    const { result } = renderHook(() => useMachineSwitcher());
    await flush();
    expect(result.current.machines).toHaveLength(1);
    await pollOnce();
    expect(result.current.machines).toHaveLength(2);
  });

  test('reads the device name once from P2P settings', async () => {
    const { result } = renderHook(() => useMachineSwitcher());
    await flush();
    await pollOnce();
    expect(channels().filter((c) => c === 'p2p:settings-get')).toHaveLength(1);
    expect(result.current.machines[0]!.name).toBe('Laptop');
  });

  test('names this machine "This machine" while the settings call is pending', async () => {
    let resolve!: (v: unknown) => void;
    settings = () => new Promise((r) => { resolve = r; });
    const { result } = renderHook(() => useMachineSwitcher());
    await flush();
    expect(result.current.machines[0]!.name).toBe('This machine');
    await act(async () => { resolve({ deviceName: 'Studio' }); await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.machines[0]!.name).toBe('Studio');
  });

  test.each([
    ['rejects (P2P off)', () => Promise.reject(new Error('p2p_not_started'))],
    ['returns an empty name', async () => ({ deviceName: '' })],
    ['returns no name', async () => ({})],
  ])('names this machine "This machine" when the settings call %s', async (_label, impl) => {
    settings = impl;
    const { result } = renderHook(() => useMachineSwitcher());
    await flush();
    expect(result.current.machines[0]!.name).toBe('This machine');
  });
});
