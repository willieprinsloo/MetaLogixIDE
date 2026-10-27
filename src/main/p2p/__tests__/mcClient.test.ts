import { describe, expect, test } from 'vitest';
import net from 'node:net';
import { McClient } from '../mcClient';
import { Secret, SignalingTypes, TypeMetaIDE } from '../../../shared/signaling-wire';
import type { Envelope } from '../../../shared/signaling-wire';
import { mockRelay, waitFor } from './_mockRelay';

// Plain TCP in tests; production default is tls.connect.
const mk = (port: number) =>
  new McClient({
    url: '127.0.0.1',
    port,
    token: new Secret('t'),
    createSocket: (h, p) => net.connect({ host: h, port: p }),
  });

describe('McClient', () => {
  test('connects and emits connected status', async () => {
    const srv = await mockRelay();
    const c = mk(srv.port);
    const seen: string[] = [];
    c.on('status', (s) => seen.push(s));
    await c.start();
    const hello = await srv.acceptAndHello();
    expect(hello.token).toBe('t');
    await waitFor(() => seen.includes('connected'));
    expect(seen).toEqual(['connecting', 'connected']);
    await c.stop();
    await srv.close();
  });

  test('unwraps inner envelopes and wraps sends in TypeMetaIDE', async () => {
    const srv = await mockRelay();
    const c = mk(srv.port);
    const got: Envelope[] = [];
    c.on('envelope', (e) => got.push(e));
    await c.start();
    await srv.acceptAndHello();
    await waitFor(() => c.status === 'connected');
    await srv.sendFrame({ type: TypeMetaIDE, data: { type: SignalingTypes.AssignCode, data: { code: 'abc' } } });
    await srv.sendFrame({ type: 'heartbeat' }); // not ours: ignored
    await waitFor(() => got.length === 1);
    expect(got[0]).toEqual({ type: 'assign_code', data: { code: 'abc' } });    await c.stop();
    await srv.close();
  });

  test('reconnects with capped backoff on relay flap', async () => {
    const srv = await mockRelay({ dropAfterAccept: true });
    const c = mk(srv.port);
    const starts: number[] = [];
    c.on('status', (s) => s === 'connecting' && starts.push(Date.now()));
    await c.start();
    await waitFor(() => starts.length >= 4, 60_000);
    const deltas = starts.slice(1).map((t, i) => t - (starts[i] as number));
    expect(Math.max(...deltas)).toBeLessThanOrEqual(30_000 + 7_500);
    expect(deltas[2] as number).toBeGreaterThan(deltas[0] as number); // grows
    await c.stop();
    await srv.close();
  }, 70_000);

  test('backoff does NOT reset after a sub-10s auth-then-drop flap (Review Focus #2)', async () => {
    const starts: number[] = [];
    const srv = await mockRelay({ dropAfterAuth: true, delayAuthAcceptMs: 10 });
    const c = new McClient({
      url: '127.0.0.1',
      port: srv.port,
      token: new Secret('t'),
      createSocket: (h, p) => net.connect({ host: h, port: p }),
      backoff: { startMs: 50, maxMs: 400 },
      stableMs: 10_000,
    });
    c.on('status', (s) => s === 'connecting' && starts.push(Date.now()));
    await c.start();
    await waitFor(() => starts.length >= 4, 10_000);
    const deltas = starts.slice(1).map((t, i) => t - (starts[i] as number));
    // Backoff keeps growing, not back to startMs
    expect(deltas[deltas.length - 1] as number).toBeGreaterThanOrEqual((deltas[0] as number) * 1.5);
    await c.stop();
    await srv.close();
  });

  test('closes the socket and reconnects when auth_ok never arrives', async () => {
    const srv = await mockRelay({ acceptButNeverAuth: true });
    const errors: Error[] = [];
    const starts: number[] = [];
    const c = new McClient({
      url: '127.0.0.1',
      port: srv.port,
      token: new Secret('t'),
      createSocket: (h, p) => net.connect({ host: h, port: p }),
      backoff: { startMs: 50, maxMs: 400 },
      handshakeTimeoutMs: 150,
    });
    c.on('error', (e) => errors.push(e));
    c.on('status', (s) => s === 'connecting' && starts.push(Date.now()));
    await c.start();
    await waitFor(() => errors.some((e) => /handshake_timeout/.test(e.message)));
    await waitFor(() => starts.length >= 2);
    expect(starts.length).toBeGreaterThanOrEqual(2);
    await c.stop();
    await srv.close();
  });

  test('rejects frames larger than 1 MiB', async () => {
    const srv = await mockRelay();
    const c = mk(srv.port);
    const errors: Error[] = [];
    c.on('error', (e) => errors.push(e));
    await c.start();
    await srv.sendRawLengthPrefix(2 * 1024 * 1024);
    await waitFor(() => errors.length === 1);
    expect(errors[0]?.message).toMatch(/frame_too_large/);
    await c.stop();
    await srv.close();
  });

  test('auth_err is fatal: emits error and does not reconnect', async () => {
    const srv = await mockRelay();
    const c = mk(srv.port);
    const errors: Error[] = [];
    c.on('error', (e) => errors.push(e));
    await c.start();
    await srv.acceptAndHello({ reject: true });
    await waitFor(() => errors.length === 1);
    expect(errors[0]?.message).toMatch(/auth_rejected/);
    await new Promise((r) => setTimeout(r, 900));
    expect(srv.connections()).toBe(1);
    await c.stop();
    await srv.close();
  });
});
