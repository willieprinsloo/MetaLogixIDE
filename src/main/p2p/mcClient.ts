import { EventEmitter } from 'node:events';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import {
  createFrameDecoder,
  encodeFrame,
  Secret,
  TypeMetaIDE,
  type Envelope,
} from '../../shared/signaling-wire';

export type McStatus = 'connecting' | 'connected' | 'disconnected';

export interface TlsOpts {
  /** Dev only: accept self-signed relay certificates. */
  tlsInsecure?: boolean;
}

export interface McClientOpts {
  url: string;
  port: number;
  token: Secret<string>;
  tls?: TlsOpts;
  /** Test seam: supply the transport (default: tls.connect). Must emit 'connect'/'secureConnect' semantics via the returned stream. */
  createSocket?: (host: string, port: number) => Duplex;
  /** Test seam: backoff tuning. Defaults are the ruled values (500 ms -> 30 s cap, +-25% jitter). */
  backoff?: { startMs?: number; maxMs?: number };
  /** Uptime after auth_ok before backoff resets (default 10 000). */
  stableMs?: number;
  /** Max time to wait for auth_ok once the socket is created (default 30 000). */
  handshakeTimeoutMs?: number;
}

const MAX_FRAME_BYTES = 1 << 20;
const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Signaling client for MetaConnect's control stream.
 *
 * Wire: 4-byte BE length-prefixed JSON frames of `{type, data}`. On connect we
 * send `{type:'auth', data:{token}}` and wait for `{type:'auth_ok'}`
 * (metaconnect/internal/agent/agent.go). Signaling traffic is nested:
 * `{type:'metaide', data:<inner Envelope>}`.
 */
export class McClient extends EventEmitter {
  #sock: Duplex | null = null;
  #stopped = true;
  #status: McStatus = 'disconnected';
  #attempt = 0;
  #timer: NodeJS.Timeout | null = null;
  #fatal = false;
  #stableTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: McClientOpts) {
    super();
  }

  get status(): McStatus {
    return this.#status;
  }

  async start(): Promise<void> {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#fatal = false;
    this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#clearStable();
    const s = this.#sock;
    if (!s) {
      this.#setStatus('disconnected');
      return;
    }
    await new Promise<void>((resolve) => {
      s.once('close', () => resolve());
      s.end();
      s.destroy();
    });
  }

  send(env: Envelope): void {
    if (this.#status !== 'connected' || !this.#sock) throw new Error('mc_not_connected');
    this.#write({ type: TypeMetaIDE, data: env });
  }

  #clearStable(): void {
    if (this.#stableTimer) clearTimeout(this.#stableTimer);
    this.#stableTimer = null;
  }

  #setStatus(s: McStatus): void {
    if (this.#status === s) return;
    this.#status = s;
    this.emit('status', s);
  }

  #emitError(e: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', e);
  }

  #write(env: { type: string; data?: unknown }): void {
    this.#sock?.write(encodeFrame(enc.encode(JSON.stringify(env))));
  }

  #connect(): void {
    if (this.#stopped) return;
    // Force a fresh 'connecting' even if the previous status was already 'disconnected'.
    this.#status = 'disconnected';
    this.#setStatus('connecting');

    const { url, port } = this.opts;
    const sock: Duplex = this.opts.createSocket
      ? this.opts.createSocket(url, port)
      : tls.connect({
          host: url,
          port,
          servername: url,
          rejectUnauthorized: !this.opts.tls?.tlsInsecure,
        });
    this.#sock = sock;

    const decoder = createFrameDecoder({ maxFrameBytes: MAX_FRAME_BYTES });
    let authed = false;
    let closed = false;
    const hsTimer = setTimeout(() => {
      this.#emitError(new Error('handshake_timeout'));
      sock.destroy();
    }, this.opts.handshakeTimeoutMs ?? 30_000);

    const sendAuth = () => this.#write({ type: 'auth', data: { token: this.opts.token.reveal() } });
    // Default tls socket fires secureConnect; injected (plain) sockets fire connect.
    const evt = this.opts.createSocket ? 'connect' : 'secureConnect';
    sock.once(evt, sendAuth);

    sock.on('data', (chunk: Buffer) => {
      let frames: Uint8Array[];
      try {
        frames = decoder.push(chunk);
      } catch (e) {
        this.#emitError(e as Error);
        sock.destroy();
        return;
      }
      for (const f of frames) {
        let outer: { type?: string; data?: unknown };
        try {
          outer = JSON.parse(dec.decode(f));
        } catch {
          this.#emitError(new Error('bad_frame_json'));
          continue;
        }
        if (!authed) {
          if (outer.type === 'auth_ok') {
            authed = true;
            clearTimeout(hsTimer);
            // Only a link that stays up resets backoff; auth-then-drop flaps keep growing it.
            this.#stableTimer = setTimeout(() => {
              this.#stableTimer = null;
              this.#attempt = 0;
            }, this.opts.stableMs ?? 10_000);
            this.#setStatus('connected');
          } else if (outer.type === 'auth_err') {
            const reason = (outer.data as { reason?: string } | undefined)?.reason ?? 'unknown';
            this.#fatal = true; // mirrors the Go agent: auth rejection is not retried
            this.#emitError(new Error(`auth_rejected: ${reason}`));
            sock.destroy();
            return;
          }
          continue;
        }
        if (outer.type === TypeMetaIDE) {
          const inner = outer.data as Envelope | undefined;
          if (inner && typeof inner.type === 'string') this.emit('envelope', inner);
          else this.#emitError(new Error('bad_inner_envelope'));
        }
        // Other relay control types (heartbeat, config, ...) are not ours.
      }
    });

    sock.on('error', (e) => this.#emitError(e));
    sock.on('close', () => {
      if (closed) return;
      closed = true;
      clearTimeout(hsTimer);
      this.#clearStable();
      if (this.#sock === sock) this.#sock = null;
      this.#setStatus('disconnected');
      if (!this.#stopped && !this.#fatal) this.#scheduleReconnect();
    });
  }

  #scheduleReconnect(): void {
    const initial = this.opts.backoff?.startMs ?? 500;
    const max = this.opts.backoff?.maxMs ?? 30_000;
    const base = Math.min(max, initial * 2 ** this.#attempt);
    this.#attempt++;
    const jitter = 1 + (Math.random() * 0.5 - 0.25);
    const delay = Math.min(max * 1.25, base * jitter);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#connect();
    }, delay);
  }
}
