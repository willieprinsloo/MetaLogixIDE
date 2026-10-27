import { describe, expect, test } from 'vitest';
import { RpcPeer } from '../rpc';
import { pairedTransports } from './_pairedTransports';
import { encodeFrame } from '../../../shared/signaling-wire';
import { waitFor } from './_mockRelay';

const enc = (s: string) => encodeFrame(new TextEncoder().encode(s));

function setup() {
  const [ta, tb] = pairedTransports();
  const client = new RpcPeer(ta.asTransport());
  const server = new RpcPeer(tb.asTransport());
  const clientErrors: Error[] = [];
  const serverErrors: Error[] = [];
  client.on('error', (e) => clientErrors.push(e));
  server.on('error', (e) => serverErrors.push(e));
  return { ta, tb, client, server, clientErrors, serverErrors };
}

const info = { name: 'n', platform: 'p', version: '1', uptime: 1 };

describe('RpcPeer', () => {
  test('request/response round-trip', async () => {
    const { client, server } = setup();
    server.handle('device.info', async () => info);
    await expect(client.call('device.info', {})).resolves.toEqual(info);
  });

  test('stream: open, events, close cancels server iterable', async () => {
    const { client, server } = setup();
    let cancelled = false;
    server.handle('shells.attach', () => (async function* () {
      try {
        for (let i = 0; ; i++) {
          yield `e${i}`;
          await new Promise((r) => setTimeout(r, 5));
        }
      } finally {
        cancelled = true;
      }
    })());
    const got: unknown[] = [];
    const h = client.openStream('shells.attach', { projectId: 1, shellIndex: 0 }, (d) => got.push(d));
    await waitFor(() => got.length >= 3);
    expect(got.slice(0, 3)).toEqual(['e0', 'e1', 'e2']);
    h.close();
    await waitFor(() => cancelled);
    const n = got.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(got.length).toBeLessThanOrEqual(n + 1);
  });

  test('stream ending on server notifies the client side without error', async () => {
    const { client, server, clientErrors } = setup();
    server.handle('shells.attach', () => (async function* () { yield 'a'; yield 'b'; })());
    const got: unknown[] = [];
    client.openStream('shells.attach', { projectId: 1, shellIndex: 0 }, (d) => got.push(d));
    await waitFor(() => got.length === 2);
    expect(clientErrors).toEqual([]);
  });

  test('malformed JSON emits rpc_parse_error, keeps channel open, next frame works', async () => {
    const { ta, tb, client, server, serverErrors } = setup();
    server.handle('device.info', async () => info);
    tb.inject(enc('{not json'));
    expect(serverErrors).toHaveLength(1);
    expect(serverErrors[0]?.message).toMatch(/^rpc_parse_error/);
    expect(tb.closed).toBe(false);
    await expect(client.call('device.info', {})).resolves.toEqual(info);
    expect(ta.closed).toBe(false);
  });

  test('oversized frame emits frame_too_large and closes channel', () => {
    const { tb, serverErrors } = setup();
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, (1 << 20) + 1, false);
    tb.inject(prefix);
    expect(serverErrors).toHaveLength(1);
    expect(serverErrors[0]?.message).toMatch(/frame_too_large/);
    expect(tb.closed).toBe(true);
  });

  test('unknown method rejects with unknown_method', async () => {
    const { client } = setup();
    await expect(client.call('device.info', {})).rejects.toMatchObject({ code: 'unknown_method' });
  });

  test('invalid params rejects with invalid_params', async () => {
    const { client, server } = setup();
    server.handle('projects.get', async () => ({ id: 1, name: 'x', path: '/x' }));
    await expect(client.call('projects.get', { id: -1 } as never)).rejects.toMatchObject({ code: 'invalid_params' });
  });

  test('invalid result from handler yields invalid_result', async () => {
    const { client, server } = setup();
    server.handle('device.info', async () => ({ nope: true }) as never);
    await expect(client.call('device.info', {})).rejects.toMatchObject({ code: 'invalid_result' });
  });

  test('handler throwing yields handler_error without leaking the message', async () => {
    const { client, server, serverErrors } = setup();
    server.handle('device.info', async () => { throw new Error('boom'); });
    await expect(client.call('device.info', {})).rejects.toMatchObject({ code: 'handler_error', message: 'handler failed' });
    expect(serverErrors.some((e) => e.message.includes('boom'))).toBe(true);
  });

  test('client close() after server stream end is a no-op', async () => {
    const { client, server } = setup();
    server.handle('shells.attach', () => (async function* () { yield 1; })());
    const got: unknown[] = [];
    const h = client.openStream('shells.attach', { projectId: 1, shellIndex: 0 }, (d) => got.push(d));
    await waitFor(() => got.length === 1);
    expect(() => h.close()).not.toThrow();
  });

  test('server close() cancels open iterables; client close() rejects pending calls', async () => {
    const { client, server } = setup();
    let cancelled = false;
    server.handle('shells.attach', () => (async function* () {
      try { for (;;) { yield 1; await new Promise((r) => setTimeout(r, 5)); } } finally { cancelled = true; }
    })());
    server.handle('device.info', () => new Promise(() => {}));
    client.openStream('shells.attach', { projectId: 1, shellIndex: 0 }, () => {});
    await new Promise((r) => setTimeout(r, 30));
    const pending = client.call('device.info', {});
    pending.catch(() => {});
    server.close();
    await waitFor(() => cancelled);
    client.close();
    await expect(pending).rejects.toMatchObject({ code: 'closed' });
  });

  test('allowIncomingStreams:false refuses open-stream without invoking handler', async () => {
    const [ta, tb] = pairedTransports();
    const client = new RpcPeer(ta.asTransport());
    const viewer = new RpcPeer(tb.asTransport(), { allowIncomingStreams: false });
    let invoked = false;
    viewer.handle('shells.attach', () => { invoked = true; return (async function* () { yield 1; })(); });
    const errs: Error[] = [];
    client.on('error', (e) => errs.push(e));
    client.openStream('shells.attach', { projectId: 1, shellIndex: 0 }, () => {});
    await waitFor(() => errs.length === 1);
    expect((errs[0] as { code?: string }).code).toBe("streams_not_allowed_on_this_side");
    expect(invoked).toBe(false);
  });

  test('oversized result becomes result_too_large; channel stays usable', async () => {
    const { tb, client, server } = setup();
    server.handle('fs.read', async () => ({ content: 'x'.repeat((1 << 20) + 10), encoding: 'utf8' as const }));
    server.handle('device.info', async () => info);
    await expect(client.call('fs.read', { projectId: 1, path: 'a' })).rejects.toMatchObject({ code: 'result_too_large' });
    expect(tb.closed).toBe(false);
    await expect(client.call('device.info', {})).resolves.toEqual(info);
  });

  test('oversized event emits event_too_large and closes the stream; channel stays open', async () => {
    const { ta, tb, client, server, serverErrors } = setup();
    server.handle('shells.attach', () => (async function* () {
      yield 'x'.repeat((1 << 20) + 10);
      await new Promise(() => {});
    })());
    server.handle('device.info', async () => info);
    const got: unknown[] = [];
    client.openStream('shells.attach', { projectId: 1, shellIndex: 0 }, (d) => got.push(d));
    await waitFor(() => serverErrors.some((e) => /event_too_large/.test(e.message)));
    expect(got).toEqual([]);
    const sentKinds = tb.sent.map((b) => JSON.parse(new TextDecoder().decode(b.slice(4))).kind);
    expect(sentKinds).toContain('close-stream');
    expect(tb.closed || ta.closed).toBe(false);
    await expect(client.call('device.info', {})).resolves.toEqual(info);
  });

  test('oversized request rejects with request_too_large', async () => {
    const { client } = setup();
    await expect(client.call('fs.list', { projectId: 1, path: 'x'.repeat((1 << 20) + 10) })).rejects.toMatchObject({ code: 'request_too_large' });
  });

  test('cancellation stops the pump and calls return on a cooperative iterator', async () => {
    const { client, server } = setup();
    let cleaned = false;
    server.handle('shells.attach', () => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<unknown>>(() => {}),
          return: async () => { cleaned = true; return { done: true as const, value: undefined }; },
        };
      },
    }));
    const h = client.openStream('shells.attach', { projectId: 1, shellIndex: 0 }, () => {});
    await new Promise((r) => setTimeout(r, 20));
    h.close();
    await waitFor(() => cleaned, 50);
  });

  test('oversized event cancels the stream without advancing the generator past its yield', async () => {
    const { client, server, serverErrors } = setup();
    const sideEffects: number[] = [];
    server.handle('shells.attach', () => (async function* () {
      yield 'ok';
      sideEffects.push(1);
      yield 'x'.repeat((1 << 20) + 10);
      sideEffects.push(2);
    })());
    client.openStream('shells.attach', { projectId: 1, shellIndex: 0 }, () => {});
    await waitFor(() => serverErrors.some((e) => /event_too_large/.test(e.message)));
    await new Promise((r) => setTimeout(r, 30));
    expect(sideEffects).toEqual([1]);
  });

  describe('onCall audit hook', () => {
    test('reports ok, invalid_params, unknown_method, result_too_large and handler_error', async () => {
      const { client, server } = setup();
      const calls: Array<[string, unknown, unknown]> = [];
      server.setOnCall((m, p, o) => calls.push([m, p, o]));
      server.handle('device.info', async () => info);
      server.handle('projects.get', async () => { throw new Error('boom'); });
      server.handle('fs.read', async () => ({ content: 'x'.repeat(1 << 20), encoding: 'utf8' as const }));
      await client.call('device.info', {});
      await expect(client.call('projects.get', { id: -1 } as never)).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(client.call('projects.get', { id: 1 })).rejects.toMatchObject({ code: 'handler_error' });
      await expect(client.call('fs.read', { projectId: 1, path: 'a' })).rejects.toMatchObject({ code: 'result_too_large' });
      await expect(client.call('shells.kill', { projectId: 1, shellIndex: 0 })).rejects.toMatchObject({ code: 'unknown_method' });
      expect(calls.map(([m, , o]) => [m, o])).toEqual([
        ['device.info', 'ok'],
        ['projects.get', { error: 'invalid_params' }],
        ['projects.get', { error: 'handler_error' }],
        ['fs.read', { error: 'result_too_large' }],
        ['shells.kill', { error: 'unknown_method' }],
      ]);
      expect(calls[1]![1]).toEqual({ id: -1 });
    });

    test('a throwing hook does not break the channel', async () => {
      const [ta, tb] = pairedTransports();
      const client = new RpcPeer(ta.asTransport());
      const server = new RpcPeer(tb.asTransport(), { onCall: () => { throw new Error('x'); } });
      server.handle('device.info', async () => info);
      await expect(client.call('device.info', {})).resolves.toEqual(info);
    });
  });
});
