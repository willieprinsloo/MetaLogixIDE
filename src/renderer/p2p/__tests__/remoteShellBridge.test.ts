// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach } from 'vitest';

type Evt = { deviceId: string; streamId: number; data?: unknown; closed?: true; reason?: string };
const invoke = vi.fn();
let listeners: Array<(e: Evt) => void> = [];
const on = vi.fn((channel: string, cb: (e: Evt) => void) => {
  expect(channel).toBe('p2p:rpc-event');
  listeners.push(cb);
  return () => { listeners = listeners.filter((l) => l !== cb); };
});
vi.mock('../../api', () => ({ api: { invoke: (...a: unknown[]) => invoke(...a), on: (...a: [string, (e: Evt) => void]) => on(...a) } }));

import { openRemoteShell } from '../remoteShellBridge';

const emit = (e: Evt) => [...listeners].forEach((l) => l(e));
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  invoke.mockReset();
  on.mockClear();
  listeners = [];
  invoke.mockImplementation(async (ch: string, req: { method?: string }) => {
    if (ch === 'p2p:rpc-call' && req.method === 'shells.attach') return { result: { streamId: 7 } };
    if (ch === 'p2p:rpc-call') return { result: { ok: true } };
    return { ok: true };
  });
});

describe('openRemoteShell', () => {
  test('attaches and forwards out events for its stream only', async () => {
    const h = openRemoteShell('tower', 3, 1);
    const got: string[] = [];
    h.onData((d) => got.push(d));
    await flush();
    expect(invoke).toHaveBeenCalledWith('p2p:rpc-call', { deviceId: 'tower', method: 'shells.attach', params: { projectId: 3, shellIndex: 1 } });
    emit({ deviceId: 'tower', streamId: 7, data: { kind: 'out', bytes: 'hello' } });
    emit({ deviceId: 'tower', streamId: 8, data: { kind: 'out', bytes: 'other' } });
    emit({ deviceId: 'laptop', streamId: 7, data: { kind: 'out', bytes: 'wrong-device' } });
    expect(got).toEqual(['hello']);
  });

  test('events arriving before the attach response are not lost', async () => {
    let resolve!: (v: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const h = openRemoteShell('tower', 3, 1);
    const got: string[] = [];
    h.onData((d) => got.push(d));
    emit({ deviceId: 'tower', streamId: 7, data: { kind: 'out', bytes: 'early' } });
    resolve({ result: { streamId: 7 } });
    await flush();
    expect(got).toEqual(['early']);
  });

  test('send calls shells.input', async () => {
    const h = openRemoteShell('tower', 3, 1);
    h.send('ls é\r');
    await flush();
    expect(invoke).toHaveBeenCalledWith('p2p:rpc-call', { deviceId: 'tower', method: 'shells.input', params: { stream: 7, bytes: btoa(String.fromCharCode(...new TextEncoder().encode('ls é\r'))) } });
  });

  test('resize calls shells.resize', async () => {
    const h = openRemoteShell('tower', 3, 1);
    h.resize(120, 40);
    await flush();
    expect(invoke).toHaveBeenCalledWith('p2p:rpc-call', { deviceId: 'tower', method: 'shells.resize', params: { stream: 7, cols: 120, rows: 40 } });
  });

  test('close calls p2p:rpc-close-stream, unsubscribes and fires onClose once', async () => {
    const h = openRemoteShell('tower', 3, 1);
    const closes: string[] = [];
    h.onClose((r) => closes.push(r));
    await flush();
    h.close();
    h.close();
    await flush();
    expect(invoke).toHaveBeenCalledWith('p2p:rpc-close-stream', { streamId: 7 });
    expect(invoke.mock.calls.filter((c) => c[0] === 'p2p:rpc-close-stream')).toHaveLength(1);
    expect(listeners).toHaveLength(0);
    expect(closes).toEqual(['closed']);
  });

  test('close before attach resolves still closes the stream', async () => {
    const h = openRemoteShell('tower', 3, 1);
    h.close();
    await flush();
    expect(invoke).toHaveBeenCalledWith('p2p:rpc-close-stream', { streamId: 7 });
  });

  test('closed event fires onClose with the reason', async () => {
    const h = openRemoteShell('tower', 3, 1);
    const closes: string[] = [];
    h.onClose((r) => closes.push(r));
    await flush();
    emit({ deviceId: 'tower', streamId: 7, closed: true, reason: 'remote_ended' });
    expect(closes).toEqual(['remote_ended']);
    expect(listeners).toHaveLength(0);
  });

  test('exit event is surfaced via onExit', async () => {
    const h = openRemoteShell('tower', 3, 1);
    const exits: Array<number | null> = [];
    h.onExit((c) => exits.push(c));
    await flush();
    emit({ deviceId: 'tower', streamId: 7, data: { kind: 'exit', code: 2 } });
    expect(exits).toEqual([2]);
  });

  test('attach failure fires onClose', async () => {
    invoke.mockRejectedValueOnce(new Error('unknown_shell'));
    const h = openRemoteShell('tower', 3, 1);
    const closes: string[] = [];
    h.onClose((r) => closes.push(r));
    await flush();
    expect(closes).toEqual(['attach_failed: unknown_shell']);
  });

  test('reconnect: drop fires onClose("reconnecting"); re-open replays scrollback first', async () => {
    const first = openRemoteShell('tower', 3, 1);
    const closes: string[] = [];
    first.onClose((r) => closes.push(r));
    await flush();
    emit({ deviceId: 'tower', streamId: 7, closed: true, reason: 'reconnecting' });
    expect(closes).toEqual(['reconnecting']);

    invoke.mockImplementation(async (ch: string, req: { method?: string }) =>
      ch === 'p2p:rpc-call' && req.method === 'shells.attach' ? { result: { streamId: 9 } } : { result: {} });
    const second = openRemoteShell('tower', 3, 1);
    const got: string[] = [];
    second.onData((d) => got.push(d));
    await flush();
    emit({ deviceId: 'tower', streamId: 9, data: { kind: 'out', bytes: 'scrollback-1' } });
    emit({ deviceId: 'tower', streamId: 9, data: { kind: 'out', bytes: 'live' } });
    expect(got).toEqual(['scrollback-1', 'live']);
  });
});
