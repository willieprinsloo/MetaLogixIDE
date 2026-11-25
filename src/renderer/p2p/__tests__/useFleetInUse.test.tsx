// @vitest-environment jsdom
/**
 * useFleetInUse (docs/specs/machine-switcher-dots.md AC39): a paired machine's project names are
 * fetched with `projects.list` when its live set holds an unknown id, one request per machine at a
 * time, retried after a failure, dropped when the machine leaves the poll map, and returned under a
 * stable reference. Only the IPC bridge is mocked.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('../../api', () => ({ api: { invoke: (...a: unknown[]) => invoke(...a) } }));

import { useFleetInUse } from '../useFleetInUse';
import type { PeerShells } from '../../machine-dots';

const live = (...ids: number[]): PeerShells => ({ aliveProjectIds: new Set(ids), agentState: null, projectStates: new Map(ids.map((id) => [id, 'idle'])) });
const fleet = (entries: Record<string, PeerShells>): ReadonlyMap<string, PeerShells> => new Map(Object.entries(entries));
const project = (id: number, name: string) => ({ id, name, rootId: 1, path: `/p/${name}`, lastOpenedAt: null, config: {} });

let replies: Record<string, () => Promise<unknown>>;

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  replies = {};
  invoke.mockImplementation((ch: string, a: { deviceId: string; method: string }) => {
    if (ch !== 'p2p:rpc-call' || a.method !== 'projects.list') return Promise.reject(new Error(`unexpected ${ch} ${a.method}`));
    return (replies[a.deviceId] ?? (async () => ({ result: [] })))();
  });
});

afterEach(() => { vi.useRealTimers(); });

const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const listed = () => invoke.mock.calls.map((c) => (c[1] as { deviceId: string }).deviceId);
const named = (result: { current: ReturnType<typeof useFleetInUse> }, deviceId: string) =>
  Object.fromEntries(result.current.get(deviceId) ?? []);

describe('useFleetInUse', () => {
  test('fetches projects.list for a machine whose live set holds an unknown id and maps id to name', async () => {
    replies.t = async () => ({ result: [project(1, 'alpha'), project(2, 'beta')] });
    const { result } = renderHook(({ s }) => useFleetInUse(s), { initialProps: { s: fleet({ t: live(1) }) } });
    await flush();
    expect(invoke.mock.calls).toEqual([['p2p:rpc-call', { deviceId: 't', method: 'projects.list', params: {} }]]);
    expect(named(result, 't')).toEqual({ 1: 'alpha', 2: 'beta' });
  });

  test('makes no call with no machines or with no live projects', async () => {
    const { rerender, result } = renderHook(({ s }) => useFleetInUse(s), { initialProps: { s: fleet({}) } });
    rerender({ s: fleet({ t: live() }) });
    await flush(15000);
    expect(invoke).not.toHaveBeenCalled();
    expect(result.current.size).toBe(0);
  });

  test('does not refetch while every live id is known, and refetches when a new unknown id appears', async () => {
    replies.t = async () => ({ result: [project(1, 'alpha'), project(2, 'beta')] });
    const { result, rerender } = renderHook(({ s }) => useFleetInUse(s), { initialProps: { s: fleet({ t: live(1) }) } });
    await flush();
    rerender({ s: fleet({ t: live(1, 2) }) });
    await flush(15000);
    expect(listed()).toEqual(['t']);
    replies.t = async () => ({ result: [project(1, 'alpha'), project(2, 'beta'), project(3, 'gamma')] });
    rerender({ s: fleet({ t: live(2, 3) }) });
    await flush();
    expect(listed()).toEqual(['t', 't']);
    expect(named(result, 't')[3]).toBe('gamma');
  });

  test('keeps one request in flight per machine, independently for each machine', async () => {
    let settle!: (v: unknown) => void;
    replies.t = () => new Promise((r) => { settle = r; });
    replies.a = async () => ({ result: [project(9, 'nine')] });
    const { result, rerender } = renderHook(({ s }) => useFleetInUse(s), { initialProps: { s: fleet({ t: live(1) }) } });
    await flush();
    rerender({ s: fleet({ t: live(1, 2) }) });
    rerender({ s: fleet({ t: live(1, 2, 3), a: live(9) }) });
    await flush();
    expect(listed().sort()).toEqual(['a', 't']);
    expect(named(result, 'a')).toEqual({ 9: 'nine' });
    await act(async () => { settle({ result: [project(1, 'one'), project(2, 'two'), project(3, 'three')] }); await vi.advanceTimersByTimeAsync(0); });
    expect(named(result, 't')).toEqual({ 1: 'one', 2: 'two', 3: 'three' });
    expect(listed()).toHaveLength(2);
  });

  test('a failure leaves that machine out, the others unaffected, and retries on the next poll', async () => {
    replies.t = () => Promise.reject(new Error('peer_unreachable'));
    replies.a = async () => ({ result: [project(9, 'nine')] });
    const s = fleet({ t: live(1), a: live(9) });
    const { result } = renderHook(() => useFleetInUse(s));
    await flush();
    expect(result.current.has('t')).toBe(false);
    expect(named(result, 'a')).toEqual({ 9: 'nine' });
    await flush(4000);
    expect(listed().filter((d) => d === 't')).toHaveLength(1);
    replies.t = async () => ({ result: [project(1, 'one')] });
    await flush(1000);
    expect(listed().filter((d) => d === 't')).toHaveLength(2);
    expect(named(result, 't')).toEqual({ 1: 'one' });
    await flush(15000);
    expect(listed()).toHaveLength(3);
  });

  test('does not retry a failure once the machine has no unknown live id', async () => {
    replies.t = () => Promise.reject(new Error('peer_unreachable'));
    const { rerender } = renderHook(({ s }) => useFleetInUse(s), { initialProps: { s: fleet({ t: live(1) }) } });
    await flush();
    rerender({ s: fleet({ t: live() }) });
    await flush(15000);
    expect(listed()).toEqual(['t']);
  });

  test('drops a machine that leaves the poll map (offline or unpaired), ignores its late reply, and refetches when it returns', async () => {
    replies.t = async () => ({ result: [project(1, 'one')] });
    const { result, rerender } = renderHook(({ s }) => useFleetInUse(s), { initialProps: { s: fleet({ t: live(1) }) } });
    await flush();
    let settle!: (v: unknown) => void;
    replies.t = () => new Promise((r) => { settle = r; });
    rerender({ s: fleet({ t: live(1, 2) }) });
    await flush();
    rerender({ s: fleet({}) });
    await flush();
    expect(result.current.has('t')).toBe(false);
    await act(async () => { settle({ result: [project(1, 'one'), project(2, 'two')] }); await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.has('t')).toBe(false);
    replies.t = async () => ({ result: [project(1, 'uno')] });
    rerender({ s: fleet({ t: live(1) }) });
    await flush();
    expect(named(result, 't')).toEqual({ 1: 'uno' });
  });

  test('guards untrusted rows: a non-array reply, non-number ids and non-string names are ignored', async () => {
    replies.t = async () => ({ result: [null, { id: 'x', name: 'bad' }, { id: 2, name: 7 }, project(1, 'ok')] });
    replies.a = async () => ({ result: 'nope' });
    const { result } = renderHook(() => useFleetInUse(fleet({ t: live(1, 2), a: live(5) })));
    await flush();
    expect(named(result, 't')).toEqual({ 1: 'ok' });
    expect(named(result, 'a')).toEqual({});
  });

  test('keeps its reference while nothing changes, including a refetch that returns the same names', async () => {
    replies.t = async () => ({ result: [project(1, 'one')] });
    const { result, rerender } = renderHook(({ s }) => useFleetInUse(s), { initialProps: { s: fleet({ t: live(1) }) } });
    await flush();
    const first = result.current;
    rerender({ s: fleet({ t: live(1) }) });
    rerender({ s: fleet({ t: live(1, 4) }) });
    await flush();
    expect(listed()).toEqual(['t', 't']);
    expect(result.current).toBe(first);
    replies.t = async () => ({ result: [project(1, 'renamed'), project(4, 'four')] });
    rerender({ s: fleet({ t: live(1, 4, 5) }) });
    await flush();
    expect(result.current).not.toBe(first);
  });

  test('keeps the same empty Map with no machines', () => {
    const { result, rerender } = renderHook(({ s }) => useFleetInUse(s), { initialProps: { s: fleet({}) } });
    const first = result.current;
    rerender({ s: fleet({}) });
    expect(result.current).toBe(first);
  });

  test('stops retrying on unmount', async () => {
    replies.t = () => Promise.reject(new Error('down'));
    const { unmount } = renderHook(() => useFleetInUse(fleet({ t: live(1) })));
    await flush();
    unmount();
    await flush(15000);
    expect(listed()).toEqual(['t']);
  });
});
