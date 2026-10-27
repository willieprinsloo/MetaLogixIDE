import { describe, expect, test, vi } from 'vitest';
import { WebRtcTransport, type TransportWorker } from '../transport';
import type { WorkerEvent } from '../worker/peerEngine';

function mockWorker(results: Record<string, unknown> = {}) {
  let sink: (e: WorkerEvent) => void = () => {};
  const calls: Array<[string, ...unknown[]]> = [];
  const w: TransportWorker = {
    call: vi.fn(async (cmd: string, ...args: unknown[]) => {
      calls.push([cmd, ...args]);
      if (cmd in results && results[cmd] instanceof Error) throw results[cmd];
      return results[cmd] ?? null;
    }) as TransportWorker['call'],
    onEvent: (cb) => { sink = cb; },
    destroy: vi.fn(),
  };
  return { w, calls, emit: (e: WorkerEvent) => sink(e) };
}

const ice: RTCIceServer[] = [{ urls: 'stun:x' }];

describe('WebRtcTransport', () => {
  test('does not create the worker until first use', async () => {
    const m = mockWorker();
    const createWorker = vi.fn(() => m.w);
    const t = new WebRtcTransport({ iceServers: ice, role: 'host', createWorker });
    expect(createWorker).not.toHaveBeenCalled();
    await t.createOffer();
    expect(createWorker).toHaveBeenCalledTimes(1);
    await t.createOffer();
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  test('creates the peer connection first, then marshals offer', async () => {
    const m = mockWorker({ 'create-offer': 'o-sdp' });
    const t = new WebRtcTransport({ iceServers: ice, role: 'host', createWorker: () => m.w });
    await expect(t.createOffer()).resolves.toBe('o-sdp');
    expect(m.calls).toEqual([['create-pc', ice], ['create-offer']]);
  });

  test('createAnswer / setRemoteDescription / addIceCandidate / openDataChannel map to commands', async () => {
    const m = mockWorker({ 'create-answer': 'a-sdp' });
    const t = new WebRtcTransport({ iceServers: ice, role: 'viewer', createWorker: () => m.w });
    await expect(t.createAnswer('o')).resolves.toBe('a-sdp');
    await t.setRemoteDescription('a');
    await t.addIceCandidate('{"candidate":"c"}');
    await t.openDataChannel('ctl');
    expect(m.calls.slice(1)).toEqual([
      ['create-answer', 'o'],
      ['set-remote-description', 'a', 'offer'],
      ['add-ice-candidate', '{"candidate":"c"}'],
      ['open-dc', 'ctl'],
    ]);
  });

  test('setRemoteDescription sends the type implied by role', async () => {
    const h = mockWorker();
    const host = new WebRtcTransport({ iceServers: ice, role: 'host', createWorker: () => h.w });
    await host.setRemoteDescription('ans');
    expect(h.calls.at(-1)).toEqual(['set-remote-description', 'ans', 'answer']);
    const v = mockWorker();
    const viewer = new WebRtcTransport({ iceServers: ice, role: 'viewer', createWorker: () => v.w });
    await viewer.setRemoteDescription('off');
    expect(v.calls.at(-1)).toEqual(['set-remote-description', 'off', 'offer']);
  });

  test('errors with no error listener are dropped, not thrown', async () => {
    const m = mockWorker({ send: new Error('data channel not open') });
    const t = new WebRtcTransport({ iceServers: ice, role: 'host', createWorker: () => m.w });
    expect(() => t.send(new Uint8Array([1]))).not.toThrow(); // not started
    await t.createOffer();
    expect(() => t.send(new Uint8Array([1]))).not.toThrow(); // worker rejects
    expect(() => m.emit({ type: 'error', message: 'x' })).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });

  test('worker events surface on the emitter', async () => {
    const m = mockWorker();
    const t = new WebRtcTransport({ iceServers: ice, role: 'host', createWorker: () => m.w });
    const got: unknown[] = [];
    t.on('message', (b) => got.push(['message', b]));
    t.on('local-candidate', (c) => got.push(['cand', c]));
    t.on('open', () => got.push('open'));
    t.on('close', () => got.push('close'));
    t.on('error', (e) => got.push(['error', (e as Error).message]));
    await t.createOffer();
    const bytes = new Uint8Array([1, 2]);
    m.emit({ type: 'local-candidate', cand: 'cc' });
    m.emit({ type: 'open' });
    m.emit({ type: 'message', bytes });
    m.emit({ type: 'error', message: 'boom' });
    m.emit({ type: 'close' });
    expect(got).toEqual([['cand', 'cc'], 'open', ['message', bytes], ['error', 'boom'], 'close']);
  });

  test('send marshals bytes; failure surfaces as error event', async () => {
    const m = mockWorker({ send: new Error('data channel not open') });
    const t = new WebRtcTransport({ iceServers: ice, role: 'host', createWorker: () => m.w });
    await t.createOffer();
    const errs: string[] = [];
    t.on('error', (e) => errs.push((e as Error).message));
    const b = new Uint8Array([9]);
    t.send(b);
    await new Promise((r) => setImmediate(r));
    expect(m.calls.at(-1)).toEqual(['send', b]);
    expect(errs).toEqual(['data channel not open']);
  });

  test('send before the worker exists emits an error instead of throwing', () => {
    const t = new WebRtcTransport({ iceServers: ice, role: 'host', createWorker: () => mockWorker().w });
    const errs: string[] = [];
    t.on('error', (e) => errs.push((e as Error).message));
    expect(() => t.send(new Uint8Array([1]))).not.toThrow();
    expect(errs).toEqual(['transport not started']);
  });

  test('command rejection propagates to the caller', async () => {
    const m = mockWorker({ 'create-offer': new Error('nope') });
    const t = new WebRtcTransport({ iceServers: ice, role: 'host', createWorker: () => m.w });
    await expect(t.createOffer()).rejects.toThrow('nope');
  });

  test('close sends close, destroys the worker, is idempotent, and blocks reuse', async () => {
    const m = mockWorker();
    const t = new WebRtcTransport({ iceServers: ice, role: 'host', createWorker: () => m.w });
    await t.createOffer();
    t.close();
    t.close();
    await new Promise((r) => setImmediate(r));
    expect(m.calls.filter((c) => c[0] === 'close')).toHaveLength(1);
    expect(m.w.destroy).toHaveBeenCalledTimes(1);
    await expect(t.createOffer()).rejects.toThrow('transport closed');
  });

  test('close before any use does not spawn a worker', () => {
    const createWorker = vi.fn(() => mockWorker().w);
    const t = new WebRtcTransport({ iceServers: ice, role: 'host', createWorker });
    t.close();
    expect(createWorker).not.toHaveBeenCalled();
  });
});
