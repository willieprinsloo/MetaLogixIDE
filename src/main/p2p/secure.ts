import { EventEmitter } from 'node:events';
import { createFramer, type HandshakeTransport, type NoiseResult } from './pairing';

/** Max plaintext per data-channel message; keeps well under SCTP/browser message limits. */
export const SECURE_CHUNK_BYTES = 16 * 1024;

/**
 * Encrypted message channel over a handshaken transport (Noise transport keys + per-frame AEAD).
 * Presents the same surface as the raw transport ('message', 'close', 'error', send, close, on, off) so
 * RpcPeer can sit on top unchanged.
 *
 * pendingMessages contract (see doNoiseXxHandshake): construct this synchronously after
 * `await doNoiseXxHandshake(...)`. The raw listener attaches in the constructor; frames that arrived
 * during the handshake (`noise.pendingMessages`) are queued first, then live frames in arrival order.
 * Nothing is delivered until `start()`, so callers can attach their own 'message' listener (RpcPeer)
 * first and then call `start()` in the same tick; the queue is then replayed in order.
 *
 * Decrypt failure (tamper, replay, reorder) is fatal: the channel is torn down.
 */
export class SecureTransport extends EventEmitter {
  readonly #raw: HandshakeTransport;
  readonly #framer: ReturnType<typeof createFramer>;
  readonly #queue: Uint8Array[];
  #started = false;
  #closed = false;

  readonly #onRaw = (bytes: Uint8Array) => {
    if (this.#closed) return;
    if (!this.#started) this.#queue.push(new Uint8Array(bytes));
    else this.#handle(bytes);
  };
  readonly #onRawClose = () => this.#teardown();

  constructor(raw: HandshakeTransport, noise: NoiseResult) {
    super();
    this.#raw = raw;
    this.#framer = createFramer(noise.sendKey, noise.recvKey);
    this.#queue = noise.pendingMessages.map((m) => new Uint8Array(m));
    raw.on('message', this.#onRaw);
    raw.on('close', this.#onRawClose);
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    const q = this.#queue.splice(0);
    for (const m of q) this.#handle(m);
  }

  send(bytes: Uint8Array): void {
    if (this.#closed) return;
    for (let i = 0; i < bytes.length; i += SECURE_CHUNK_BYTES) {
      this.#raw.send(this.#framer.encrypt(bytes.subarray(i, i + SECURE_CHUNK_BYTES)));
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#teardown();
    this.#raw.close();
  }

  #handle(frame: Uint8Array): void {
    if (this.#closed) return;
    let pt: Uint8Array;
    try {
      pt = this.#framer.decrypt(frame);
    } catch (e) {
      if (this.listenerCount('error') > 0) this.emit('error', e instanceof Error ? e : new Error(String(e)));
      this.close();
      return;
    }
    this.emit('message', pt);
  }

  #teardown(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#raw.off('message', this.#onRaw);
    this.#raw.off('close', this.#onRawClose);
    this.emit('close');
  }
}
