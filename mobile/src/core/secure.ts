import { Emitter } from './bytes';
import { createFramer, type NoiseResult, type RawTransport } from './noise';

/** Max plaintext per data-channel message (matches the desktop's SECURE_CHUNK_BYTES). */
const CHUNK = 16 * 1024;

/**
 * Encrypted channel over a handshaken transport. Construct synchronously after `viewerHandshake`
 * resolves; nothing is delivered until `start()`, so the consumer can attach its listener first.
 * Events: 'message' (Uint8Array), 'close', 'error' (Error). A decrypt failure is fatal.
 */
export class SecureChannel extends Emitter {
  readonly #raw: RawTransport;
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

  constructor(raw: RawTransport, noise: NoiseResult) {
    super();
    this.#raw = raw;
    this.#framer = createFramer(noise.sendKey, noise.recvKey);
    raw.on('message', this.#onRaw);
    raw.on('close', this.#onRawClose);
    noise.release();
    this.#queue = noise.pendingMessages.splice(0);
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    for (const m of this.#queue.splice(0)) this.#handle(m);
  }

  send(bytes: Uint8Array): void {
    if (this.#closed) return;
    for (let i = 0; i < bytes.length; i += CHUNK) this.#raw.send(this.#framer.encrypt(bytes.subarray(i, i + CHUNK)));
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
      this.emit('error', e instanceof Error ? e : new Error(String(e)));
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
