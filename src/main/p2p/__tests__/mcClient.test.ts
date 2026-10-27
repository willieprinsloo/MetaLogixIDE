import { describe, expect, test } from 'vitest';
import net from 'node:net';
import { McClient, type McClientOpts } from '../mcClient';
import { Secret } from '../../../shared/signaling-wire';
import type { Envelope } from '../../../shared/signaling-wire';
import { mockRelay, waitFor } from './_mockRelay';

// Plain TCP in tests; production default is also plaintext (mrsignald serves plaintext).
const mk = (port: number, extra: Partial<McClientOpts> = {}) =>
  new McClient({
    url: '127.0.0.1',
    port,
    role: 'viewer',
    createSocket: (h, p) => net.connect({ host: h, port: p }),
    ...extra,
  });

describe('McClient', () => {
  test('viewer: Hello is a bare {token, role} object and the client is connected immediately', async () => {
    const srv = await mockRelay();
    const c = mk(srv.port);
    const seen: string[] = [];
    c.on('status', (s) => seen.push(s));
    await c.start();
    const hello = await srv.acceptAndHello();
    expect(hello).toEqual({ token: '', role: 'viewer' });
    await waitFor(() => seen.includes('connected'));
    expect(seen).toEqual(['connecting', 'connected']);
    await c.stop();
    await srv.close();
  });

  test('host without identity: waits for assign_code, persists it, then connects', async () => {
    const srv = await mockRelay();
    const persisted: Array<{ code: string; secret: string }> = [];
    let persistedBeforeConnected = false;
    const c = mk(srv.port, { role: 'host', onAssignCode: (id) => { persisted.push(id); } });
    c.on('status', (s) => { if (s === 'connected') persistedBeforeConnected = persisted.length === 1; });
    const identities: unknown[] = [];
    c.on('identity', (i) => identities.push(i));
    const envs: Envelope[] = [];
    c.on('envelope', (e) => envs.push(e));
    await c.start();
    const hello = await srv.acceptAndHello({ mint: { code: '987654321', secret: 'zzz' } });
    expect(hello).toEqual({ token: '', role: 'host' });
    await waitFor(() => c.status === 'connected');
    expect(persisted).toEqual([{ code: '987654321', secret: 'zzz' }]);
    expect(persistedBeforeConnected).toBe(true);
    expect(identities).toEqual([{ code: '987654321' }]);
    expect(envs).toEqual([]); // assign_code carries a secret and is consumed, never re-emitted
    await c.stop();
    await srv.close();
  });

  test('host with identity: Hello carries code+secret and connects without waiting', async () => {
    const srv = await mockRelay();
    const c = mk(srv.port, { role: 'host', identity: { code: '111222333', secret: new Secret('sek') } });
    await c.start();
    const hello = await srv.acceptAndHello();
    expect(hello).toEqual({ token: '', role: 'host', code: '111222333', secret: 'sek' });
    await waitFor(() => c.status === 'connected');
    await c.stop();
    await srv.close();
  });

  test('the Hello event is redacted (token and secret never reach logs)', async () => {
    const srv = await mockRelay();
    const c = mk(srv.port, { role: 'host', token: new Secret('adm'), identity: { code: '1', secret: new Secret('sek') } });
    const hellos: unknown[] = [];
    c.on('hello', (h) => hellos.push(h));
    await c.start();
    await srv.acceptAndHello();
    await waitFor(() => hellos.length === 1);
    expect(hellos[0]).toEqual({ token: '<redacted>', role: 'host', code: '1', secret: '<redacted>' });
    expect(JSON.stringify(hellos)).not.toMatch(/adm|sek/);
    await c.stop();
    await srv.close();
  });

  test('a failing identity persist is not swallowed: error, no connected status', async () => {
    const srv = await mockRelay();
    const c = mk(srv.port, { role: 'host', onAssignCode: () => { throw new Error('disk_full'); }, backoff: { startMs: 10_000, maxMs: 10_000 } });
    const errors: Error[] = [];
    c.on('error', (e) => errors.push(e));
    const seen: string[] = [];
    c.on('status', (s) => seen.push(s));
    await c.start();
    await srv.acceptAndHello();
    await waitFor(() => errors.some((e) => /disk_full/.test(e.message)));
    await waitFor(() => c.status === 'disconnected');
    expect(seen).not.toContain('connected');
    await c.stop();
    await srv.close();
  });

  test('envelopes are bare in both directions (no outer wrapper)', async () => {
    const srv = await mockRelay();
    const c = mk(srv.port);
    const got: Envelope[] = [];
    c.on('envelope', (e) => got.push(e));
    await c.start();
    await srv.acceptAndHello();
    await waitFor(() => c.status === 'connected');
    await srv.sendFrame({ type: 'session_granted', data: { session: 's1' } });
    await waitFor(() => got.length === 1);
    expect(got[0]).toEqual({ type: 'session_granted', data: { session: 's1' } });
    c.send({ type: 'session_request', data: { code: '123456789' } });
    expect(await srv.nextEnvelope()).toEqual({ type: 'session_request', data: { code: '123456789' } });
    await c.stop();
    await srv.close();
  });

  test('send before connected throws', async () => {
    const c = mk(1);
    expect(() => c.send({ type: 'register' })).toThrow(/mc_not_connected/);
  });

  test('host reconnects with capped backoff on relay flap', async () => {
    const srv = await mockRelay({ dropAfterAccept: true });
    const c = mk(srv.port, { role: 'host' });
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

  test('viewer does not reconnect (a new connection would orphan the relay session)', async () => {
    const srv = await mockRelay({ dropAfterAccept: true });
    const c = mk(srv.port, { backoff: { startMs: 20, maxMs: 40 } });
    await c.start();
    await waitFor(() => srv.connections() === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(srv.connections()).toBe(1);
    expect(c.status).toBe('disconnected');
    await c.stop();
    await srv.close();
  });

  test('backoff does NOT reset after a sub-stableMs connect-then-drop flap', async () => {
    const starts: number[] = [];
    const srv = await mockRelay({ dropAfterHello: true, delayMs: 10 });
    const c = mk(srv.port, { role: 'host', identity: { code: '1', secret: new Secret('s') }, backoff: { startMs: 50, maxMs: 400 }, stableMs: 10_000 });
    c.on('status', (s) => s === 'connecting' && starts.push(Date.now()));
    await c.start();
    await waitFor(() => starts.length >= 4, 10_000);
    const deltas = starts.slice(1).map((t, i) => t - (starts[i] as number));
    expect(deltas[deltas.length - 1] as number).toBeGreaterThanOrEqual((deltas[0] as number) * 1.5);
    await c.stop();
    await srv.close();
  });

  test('helloTimeout: a host awaiting assign_code that never comes errors, closes and retries', async () => {
    const srv = await mockRelay({ acceptButNeverReply: true });
    const errors: Error[] = [];
    const starts: number[] = [];
    const c = mk(srv.port, { role: 'host', backoff: { startMs: 50, maxMs: 400 }, helloTimeoutMs: 150 });
    c.on('error', (e) => errors.push(e));
    c.on('status', (s) => s === 'connecting' && starts.push(Date.now()));
    await c.start();
    await waitFor(() => errors.some((e) => /hello_timeout/.test(e.message)));
    await waitFor(() => starts.length >= 2);
    await c.stop();
    await srv.close();
  });

  test('helloTimeout does not fire for a viewer that has sent Hello', async () => {
    const srv = await mockRelay();
    const errors: Error[] = [];
    const c = mk(srv.port, { helloTimeoutMs: 100 });
    c.on('error', (e) => errors.push(e));
    await c.start();
    await srv.acceptAndHello();
    await new Promise((r) => setTimeout(r, 250));
    expect(errors).toEqual([]);
    expect(c.status).toBe('connected');
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
});
