import net from 'node:net';
import { createFrameDecoder, encodeFrame } from '../../../shared/signaling-wire';

export interface MockRelay {
  port: number;
  /** Waits for a client connection, reads its `auth` frame, replies `auth_ok` (or `auth_err`). Returns the auth data. */
  acceptAndHello(opts?: { reject?: boolean }): Promise<{ token?: string }>;
  /** Writes a raw 4-byte big-endian length prefix (no payload) to the current client. */
  sendRawLengthPrefix(len: number): Promise<void>;
  /** Writes a framed outer envelope to the current client. */
  sendFrame(env: { type: string; data?: unknown }): Promise<void>;
  connections(): number;
  close(): Promise<void>;
}

export async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Tiny plain-TCP stand-in for the MetaConnect relay control stream. */
export async function mockRelay(
  opts: {
    dropAfterAccept?: boolean;
    /** Auto-handle auth: reply auth_ok (after delayAuthAcceptMs) then destroy the socket. */
    dropAfterAuth?: boolean;
    delayAuthAcceptMs?: number;
    /** Accept TCP, read nothing, never reply (documents intent; this is also the default). */
    acceptButNeverAuth?: boolean;
  } = {},
): Promise<MockRelay> {
  const sockets: net.Socket[] = [];
  let count = 0;
  const server = net.createServer((s) => {
    count++;
    s.on('error', () => {});
    if (opts.dropAfterAccept) {
      s.destroy();
      return;
    }
    if (opts.dropAfterAuth) {
      s.once('data', () => {
        setTimeout(() => {
          const ok = encodeFrame(new TextEncoder().encode(JSON.stringify({ type: 'auth_ok' })));
          s.write(ok, () => s.destroy());
        }, opts.delayAuthAcceptMs ?? 0);
      });
      return;
    }
    sockets.push(s);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;

  const current = async (): Promise<net.Socket> => {
    await waitFor(() => sockets.length > 0);
    return sockets[sockets.length - 1] as net.Socket;
  };
  const write = (s: net.Socket, b: Uint8Array) =>
    new Promise<void>((res, rej) => s.write(b, (e) => (e ? rej(e) : res())));

  return {
    port,
    connections: () => count,
    async acceptAndHello(o = {}) {
      const s = await current();
      const dec = createFrameDecoder({ maxFrameBytes: 1 << 20 });
      const frame = await new Promise<Uint8Array>((resolve, reject) => {
        const onData = (chunk: Buffer) => {
          const frames = dec.push(chunk);
          if (frames.length) {
            s.off('data', onData);
            resolve(frames[0] as Uint8Array);
          }
        };
        s.on('data', onData);
        s.once('error', reject);
      });
      const env = JSON.parse(new TextDecoder().decode(frame)) as { type: string; data?: { token?: string } };
      if (env.type !== 'auth') throw new Error(`expected auth, got ${env.type}`);
      const reply = o.reject ? { type: 'auth_err', data: { reason: 'bad token' } } : { type: 'auth_ok' };
      await write(s, encodeFrame(new TextEncoder().encode(JSON.stringify(reply))));
      return { token: env.data?.token };
    },
    async sendRawLengthPrefix(len) {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, len, false);
      await write(await current(), b);
    },
    async sendFrame(env) {
      await write(await current(), encodeFrame(new TextEncoder().encode(JSON.stringify(env))));
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
