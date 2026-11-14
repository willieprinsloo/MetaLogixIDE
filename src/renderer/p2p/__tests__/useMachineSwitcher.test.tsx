// @vitest-environment jsdom
/**
 * useMachineSwitcher (docs/specs/machine-switcher-dots.md AC6, AC9, AC10, AC11, AC12, AC15 and plan
 * ruling C2): the dot list from fleet + device name, the selection, and its fallback to this machine.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('../../api', () => ({ api: { invoke: (...a: unknown[]) => invoke(...a) } }));
let localAgentState: 'idle' | 'busy' | 'blocked' | null = null;
vi.mock('../../hooks/useAgentStates', () => ({ useMachineAgentState: () => localAgentState }));

import { useMachineSwitcher } from '../useMachineSwitcher';
import { LOCAL_MACHINE_ID } from '../../machine-switcher-contract';

type Reply = { fleet?: unknown } | Error | Promise<unknown>;
let fleetReplies: Reply[];
let settings: () => Promise<unknown>;
let shells: Record<string, () => Promise<unknown>>;

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
  shells = {};
  localAgentState = null;
  invoke.mockImplementation((ch: string, a?: { deviceId: string; method: string }) => {
    if (ch === 'p2p:fleet-list') return nextFleet();
    if (ch === 'p2p:settings-get') return settings();
    if (ch === 'p2p:rpc-call' && a?.method === 'shells.alive') return (shells[a.deviceId] ?? (async () => ({ result: [] })))();
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

  test('keeps the same machines array across a poll that changes nothing, and replaces it when a dot changes (F4)', async () => {
    fleetReplies = [
      { fleet: [TOWER, ATLAS] },
      { fleet: [{ ...TOWER }, { ...ATLAS }] },
      { fleet: [TOWER, { ...ATLAS, online: true }] },
      { fleet: [TOWER, { ...ATLAS, online: true, lastSeenAt: 9 }] },
    ];
    const { result } = renderHook(() => useMachineSwitcher());
    await flush();
    const first = result.current.machines;
    await pollOnce();
    expect(invoke.mock.calls.filter((c) => c[0] === 'p2p:fleet-list')).toHaveLength(2);
    expect(result.current.machines).toBe(first);
    await pollOnce();
    expect(result.current.machines).not.toBe(first);
    expect(result.current.machines.find((m) => m.deviceId === 'atlas')!.online).toBe(true);
    const second = result.current.machines;
    await pollOnce();
    expect(result.current.machines).not.toBe(second);
    expect(result.current.machines.find((m) => m.deviceId === 'atlas')!.lastSeenAt).toBe(9);
  });

  test('keeps the same machines array across empty polls (zero peers)', async () => {
    fleetReplies = [{ fleet: [] }, { fleet: [] }, { fleet: [] }];
    const { result } = renderHook(() => useMachineSwitcher());
    await flush();
    const first = result.current.machines;
    await pollOnce();
    await pollOnce();
    expect(result.current.machines).toBe(first);
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

  test('this machine\'s dot takes the local machine aggregate, null with no agent (AC34)', async () => {
    localAgentState = 'blocked';
    const { result, rerender } = renderHook(() => useMachineSwitcher());
    await flush();
    expect(result.current.machines[0]!.agentState).toBe('blocked');
    localAgentState = null;
    rerender();
    expect(result.current.machines[0]!.agentState).toBeNull();
  });

  test('a peer\'s dot takes the state from its shells.alive poll; an offline peer has none (AC34)', async () => {
    fleetReplies = [{ fleet: [TOWER, ATLAS] }];
    shells.tower = async () => ({ result: [{ projectId: 4, shellIndex: 0, agentState: 'busy' }] });
    shells.atlas = async () => ({ result: [{ projectId: 5, shellIndex: 0, agentState: 'blocked' }] });
    const { result } = renderHook(() => useMachineSwitcher());
    await flush();
    await flush();
    expect(result.current.machines.find((m) => m.deviceId === 'tower')!.agentState).toBe('busy');
    expect(result.current.machines.find((m) => m.deviceId === 'atlas')!.agentState).toBeNull();
    expect(invoke.mock.calls.filter((c) => c[0] === 'p2p:rpc-call').map((c) => (c[1] as { deviceId: string }).deviceId)).toEqual(['tower']);
  });

  test('shellsFor returns a peer\'s live project ids, and an empty set for an unknown machine', async () => {
    fleetReplies = [{ fleet: [TOWER] }];
    shells.tower = async () => ({ result: [{ projectId: 4, shellIndex: 0 }, { projectId: 7, shellIndex: 1 }] });
    const { result } = renderHook(() => useMachineSwitcher());
    await flush();
    await flush();
    expect([...result.current.shellsFor('tower')].sort()).toEqual([4, 7]);
    expect(result.current.shellsFor('nope').size).toBe(0);
    expect(result.current.shellsFor(LOCAL_MACHINE_ID).size).toBe(0);
    expect(result.current.shellsFor('nope')).toBe(result.current.shellsFor(LOCAL_MACHINE_ID));
  });

  test('machines keeps its reference across fleet and shells polls that change nothing', async () => {
    fleetReplies = [{ fleet: [TOWER] }, { fleet: [{ ...TOWER }] }, { fleet: [{ ...TOWER }] }];
    shells.tower = async () => ({ result: [{ projectId: 4, shellIndex: 0, agentState: 'idle' }] });
    const { result, rerender } = renderHook(() => useMachineSwitcher());
    await flush();
    await flush();
    const first = result.current.machines;
    expect(first.find((m) => m.deviceId === 'tower')!.agentState).toBe('idle');
    await pollOnce();
    await pollOnce();
    rerender();
    expect(result.current.machines).toBe(first);
    shells.tower = async () => ({ result: [{ projectId: 4, shellIndex: 0, agentState: 'busy' }] });
    await pollOnce();
    expect(result.current.machines).not.toBe(first);
    expect(result.current.machines.find((m) => m.deviceId === 'tower')!.agentState).toBe('busy');
  });
});
