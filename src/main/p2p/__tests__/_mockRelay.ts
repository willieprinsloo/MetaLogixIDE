import net from 'node:net';
import { createFrameDecoder, encodeFrame, type Envelope, type Hello } from '../../../shared/signaling-wire';

export interface MockRelay {
  port: number;
  /**
   * Waits for a client connection and reads frame 1 (a bare Hello JSON object, NOT an Envelope), like mrsignald.
   * A `host` Hello without code+secret is answered with `assign_code` (default pair 123456789 / s3cret).
   * Returns the Hello exactly as received.
   */
  acceptAndHello(opts?: { mint?: { code: string; secret: string } }): Promise<Hello>;
  /** Resolves with the next Envelope the client sends after Hello. */
  nextEnvelope(): Promise<Envelope>;
  /** Writes a raw 4-byte big-endian length prefix (no payload) to the current client. */
  sendRawLengthPrefix(len: number): Promise<void>;
  /** Writes a bare mrsignal Envelope to the current client. */
  sendFrame(env: Envelope): Promise<void>;
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

/** Tiny plain-TCP stand-in for mrsignald's listener. */
export async function mockRelay(
  opts: {
    /** Close the socket immediately on accept. */
    dropAfterAccept?: boolean;
    /** Read the Hello (after delayMs) then close, like a relay that rejects it. */
    dropAfterHello?: boolean;
    delayMs?: number;
    /** Accept TCP, read nothing, never reply (this is also the default). */
    acceptButNeverReply?: boolean;
  } = {},
): Promise<MockRelay> {
  const sockets: net.Socket[] = [];
  const decoders = new Map<net.Socket, ReturnType<typeof createFrameDecoder>>();
  const queued = new Map<net.Socket, Uint8Array[]>();
  let count = 0;
  const server = net.createServer((s) => {
    count++;
    s.on('error', () => {});
    if (opts.dropAfterAccept) {
      s.destroy();
      return;
    }
    if (opts.dropAfterHello) {
      s.once('data', () => setTimeout(() => s.destroy(), opts.delayMs ?? 0));
      return;
    }
    const dec = createFrameDecoder({ maxFrameBytes: 1 << 20 });
    decoders.set(s, dec);
    queued.set(s, []);
    s.on('data', (chunk: Buffer) => {
      try {
        queued.get(s)!.push(...dec.push(chunk));
      } catch {
        /* oversize etc.: the test inspects the client side */
      }
    });
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
  const nextFrame = async (s: net.Socket): Promise<Uint8Array> => {
    await waitFor(() => (queued.get(s)?.length ?? 0) > 0);
    return queued.get(s)!.shift() as Uint8Array;
  };

  return {
    port,
    connections: () => count,
    async acceptAndHello(o = {}) {
      const s = await current();
      const hello = JSON.parse(new TextDecoder().decode(await nextFrame(s))) as Hello;
      if (hello.role === 'host' && !(hello.code && hello.secret)) {
        const data = o.mint ?? { code: '123456789', secret: 's3cret' };
        await write(s, encodeFrame(new TextEncoder().encode(JSON.stringify({ type: 'assign_code', data }))));
      }
      return hello;
    },
    async nextEnvelope() {
      const s = await current();
      return JSON.parse(new TextDecoder().decode(await nextFrame(s))) as Envelope;
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
