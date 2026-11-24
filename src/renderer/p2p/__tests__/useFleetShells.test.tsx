// @vitest-environment jsdom
/**
 * useFleetShells (docs/specs/machine-switcher-dots.md AC34, plan A2.4 and E3): one `shells.alive`
 * poll per online peer every 5 s, the guarded agent state, failure and offline handling, and a
 * result that keeps its reference across polls that change nothing.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('../../api', () => ({ api: { invoke: (...a: unknown[]) => invoke(...a) } }));

import { useFleetShells } from '../useFleetShells';
import type { MachineDot } from '../../machine-switcher-contract';

const dot = (deviceId: string, online = true): MachineDot => ({ deviceId, name: deviceId, online, lastSeenAt: null, self: false });
const LOCAL: MachineDot = { deviceId: 'local', name: 'L', online: true, lastSeenAt: null, self: true };

let replies: Record<string, () => Promise<unknown>>;

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  replies = {};
  invoke.mockImplementation((ch: string, a: { deviceId: string; method: string }) => {
    if (ch !== 'p2p:rpc-call' || a.method !== 'shells.alive') return Promise.reject(new Error(`unexpected ${ch} ${a.method}`));
    return (replies[a.deviceId] ?? (async () => ({ result: [] })))();
  });
});

afterEach(() => { vi.useRealTimers(); });

const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const polled = () => invoke.mock.calls.map((c) => (c[1] as { deviceId: string }).deviceId);
const rows = (...r: Array<Record<string, unknown>>) => async () => ({ result: r.map((x) => ({ ...x })) });

describe('useFleetShells', () => {
  test('polls shells.alive for every online peer at once and every 5 s, never for offline peers or this machine', async () => {
    const peers = [LOCAL, dot('a'), dot('b'), dot('z', false)];
    renderHook(() => useFleetShells(peers));
    await flush();
    expect(polled().sort()).toEqual(['a', 'b']);
    await flush(5000);
    expect(polled().sort()).toEqual(['a', 'a', 'b', 'b']);
    expect(invoke.mock.calls[0]).toEqual(['p2p:rpc-call', { deviceId: expect.any(String), method: 'shells.alive', params: {} }]);
  });

  test('aggregates each peer\'s shells into live project ids and the worst agent state', async () => {
    replies.a = rows({ projectId: 1, shellIndex: 0, agentState: 'idle' }, { projectId: 2, shellIndex: 0, agentState: 'blocked' }, { projectId: 2, shellIndex: 1, agentState: 'busy' });
    replies.b = rows({ projectId: 9, shellIndex: 0, agentState: null });
    const { result } = renderHook(() => useFleetShells([dot('a'), dot('b')]));
    await flush();
    expect([...result.current.get('a')!.aliveProjectIds].sort()).toEqual([1, 2]);
    expect(result.current.get('a')!.agentState).toBe('blocked');
    expect([...result.current.get('b')!.aliveProjectIds]).toEqual([9]);
    expect(result.current.get('b')!.agentState).toBeNull();
  });

  test('an old host that sends no agentState gives null; a non-literal value gives null', async () => {
    replies.a = rows({ projectId: 1, shellIndex: 0 });
    replies.b = rows({ projectId: 1, shellIndex: 0, agentState: 'BUSY' }, { projectId: 2, shellIndex: 0, agentState: 7 });
    const { result } = renderHook(() => useFleetShells([dot('a'), dot('b')]));
    await flush();
    expect(result.current.get('a')).toEqual({ aliveProjectIds: new Set([1]), agentState: null });
    expect(result.current.get('b')!.agentState).toBeNull();
  });

  test('a malformed reply yields an empty entry and never throws', async () => {
    replies.a = async () => ({ result: 'nope' });
    replies.b = async () => ({ result: [null, { projectId: 'x' }, { projectId: 3, agentState: 'busy' }] });
    const { result } = renderHook(() => useFleetShells([dot('a'), dot('b')]));
    await flush();
    expect(result.current.get('a')).toEqual({ aliveProjectIds: new Set(), agentState: null });
    expect(result.current.get('b')).toEqual({ aliveProjectIds: new Set([3]), agentState: 'busy' });
  });

  test('a failed poll keeps that peer\'s last entry (E3)', async () => {
    replies.a = rows({ projectId: 1, shellIndex: 0, agentState: 'busy' });
    const { result } = renderHook(() => useFleetShells([dot('a')]));
    await flush();
    const before = result.current.get('a');
    replies.a = async () => { throw new Error('peer_unreachable'); };
    await flush(5000);
    expect(polled()).toEqual(['a', 'a']);
    expect(result.current.get('a')).toBe(before);
  });

  test('a peer coming online is polled at once; going offline or being removed drops its entry', async () => {
    replies.a = rows({ projectId: 1, shellIndex: 0, agentState: 'busy' });
    replies.b = rows({ projectId: 2, shellIndex: 0, agentState: 'idle' });
    const { result, rerender } = renderHook(({ peers }) => useFleetShells(peers), { initialProps: { peers: [dot('a'), dot('b', false)] } });
    await flush();
    expect(polled()).toEqual(['a']);
    rerender({ peers: [dot('a'), dot('b')] });
    await flush();
    expect(polled()).toContain('b');
    expect(result.current.get('b')!.agentState).toBe('idle');
    rerender({ peers: [dot('a'), dot('b', false)] });
    await flush();
    expect(result.current.has('b')).toBe(false);
    expect(result.current.get('a')!.agentState).toBe('busy');
    rerender({ peers: [] });
    await flush();
    expect(result.current.size).toBe(0);
  });

  test('a reply that lands after the peer went offline is ignored', async () => {
    let resolve!: (v: unknown) => void;
    replies.a = () => new Promise((r) => { resolve = r; });
    const { result, rerender } = renderHook(({ peers }) => useFleetShells(peers), { initialProps: { peers: [dot('a')] } });
    await flush();
    rerender({ peers: [dot('a', false)] });
    await flush();
    await act(async () => { resolve({ result: [{ projectId: 1, shellIndex: 0, agentState: 'busy' }] }); await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.has('a')).toBe(false);
  });

  test('keeps the same Map across polls that change nothing, and replaces it when a peer\'s shells change', async () => {
    replies.a = rows({ projectId: 1, shellIndex: 0, agentState: 'busy' }, { projectId: 2, shellIndex: 0, agentState: null });
    const { result } = renderHook(() => useFleetShells([dot('a')]));
    await flush();
    const first = result.current;
    await flush(5000);
    await flush(5000);
    expect(polled()).toHaveLength(3);
    expect(result.current).toBe(first);
    replies.a = rows({ projectId: 1, shellIndex: 0, agentState: 'idle' }, { projectId: 2, shellIndex: 0, agentState: null });
    await flush(5000);
    expect(result.current).not.toBe(first);
    const second = result.current;
    replies.a = rows({ projectId: 1, shellIndex: 0, agentState: 'idle' });
    await flush(5000);
    expect(result.current).not.toBe(second);
  });

  test('keeps the same Map when the online set grows but nothing changes: the newcomer\'s poll fails', async () => {
    replies.a = rows({ projectId: 1, shellIndex: 0, agentState: 'busy' });
    replies.b = () => Promise.reject(new Error('unreachable'));
    const { result, rerender } = renderHook(({ peers }) => useFleetShells(peers), { initialProps: { peers: [dot('a'), dot('b', false)] } });
    await flush();
    const first = result.current;
    rerender({ peers: [dot('a'), dot('b')] });
    await flush();
    expect(polled()).toEqual(['a', 'a', 'b']);
    expect(result.current).toBe(first);
  });

  test('keeps the same empty Map with no online peers and makes no calls', async () => {
    const { result, rerender } = renderHook(({ peers }) => useFleetShells(peers), { initialProps: { peers: [LOCAL, dot('z', false)] } });
    const first = result.current;
    await flush(15000);
    rerender({ peers: [LOCAL, dot('z', false)] });
    expect(result.current).toBe(first);
    expect(invoke).not.toHaveBeenCalled();
  });

  test('stops polling on unmount', async () => {
    const { unmount } = renderHook(() => useFleetShells([dot('a')]));
    await flush();
    unmount();
    await flush(15000);
    expect(polled()).toEqual(['a']);
  });
});
