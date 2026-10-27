import { EventEmitter } from 'node:events';
import tls from 'node:tls';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import {
  createFrameDecoder,
  encodeFrame,
  redactHello,
  Secret,
  SignalingTypes,
  type Envelope,
  type Hello,
} from '../../shared/signaling-wire';

export type McStatus = 'connecting' | 'connected' | 'disconnected';

export interface TlsOpts {
  /** Opt in to TLS. mrsignald serves plaintext by default; set this only against a TLS-fronted relay. */
  enabled?: boolean;
  /** Dev only: accept self-signed relay certificates. Implies `enabled`. */
  tlsInsecure?: boolean;
  /** Back-compat alias. Default behavior is now plaintext; this flag is a no-op kept so existing call sites type-check. */
  plaintext?: boolean;
}

export interface McIdentity {
  code: string;
  secret: Secret<string>;
}

export interface McClientOpts {
  url: string;
  port: number;
  /** `host` serves projects/shells (persistent); `viewer` requests one session (anonymous, per-connection). */
  role: 'host' | 'viewer';
  /** Host only: previously minted (code, secret). Absent -> the relay mints a pair and sends `assign_code`. */
  identity?: McIdentity;
  /** Legacy/admin relay token. Empty for metaIDE. */
  token?: Secret<string>;
  /**
   * Host only: called with a freshly minted (or replaced) identity. The client is not `connected` until this
   * resolves (the pair must be persisted before the host does anything else). A rejection is fatal for this attempt.
   */
  onAssignCode?: (id: { code: string; secret: string }) => void | Promise<void>;
  tls?: TlsOpts;
  /** Test seam: supply the transport (default: tls.connect). Must emit 'connect' once usable. */
  createSocket?: (host: string, port: number) => Duplex;
  /** Test seam: backoff tuning. Defaults are the ruled values (500 ms -> 30 s cap, +-25% jitter). */
  backoff?: { startMs?: number; maxMs?: number };
  /** Uptime after `connected` before backoff resets (default 10 000). */
  stableMs?: number;
  /** Max time from socket creation until the Hello exchange is complete (default 10 000). */
  helloTimeoutMs?: number;
  /** Viewer connections are single-use: a dropped socket orphans the relay session, so do not reconnect. Default true for host, false for viewer. */
  reconnect?: boolean;
}

const MAX_FRAME_BYTES = 1 << 20;
const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Signaling client for mrsignald (metaconnect `internal/mrserver/listener.go`).
 *
 * Wire: 4-byte BE length-prefixed JSON frames.
 *  - Frame 1 (ours -> relay) is a bare Hello `{token, role, code?, secret?}`, NOT an Envelope.
 *  - Every later frame, both directions, is a bare mrsignal Envelope `{type, data}`.
 *  - A host without a usable (code, secret) is answered with `assign_code`. The relay never replies to a
 *    rejected Hello; it just closes the socket (so there is no auth_err, and rejection looks like a drop).
 *
 * Events: `status`, `envelope` (bare inner envelope; `assign_code` is consumed here, never re-emitted, since it
 * carries a secret), `identity` ({code} after a mint/replace), `hello` (redacted Hello, safe to audit), `error`.
 */
export class McClient extends EventEmitter {
  #sock: Duplex | null = null;
  #stopped = true;
  #status: McStatus = 'disconnected';
  #attempt = 0;
  #timer: NodeJS.Timeout | null = null;
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

  /** Sends a bare mrsignal Envelope. */
  send(env: Envelope): void {
    if (this.#status !== 'connected' || !this.#sock) throw new Error('mc_not_connected');
    this.#write(env);
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

  #write(obj: unknown): void {
    this.#sock?.write(encodeFrame(enc.encode(JSON.stringify(obj))));
  }

  #connect(): void {
    if (this.#stopped) return;
    // Force a fresh 'connecting' even if the previous status was already 'disconnected'.
    this.#status = 'disconnected';
    this.#setStatus('connecting');

    const { url, port, role } = this.opts;
    const t = this.opts.tls;
    // mrsignald is plaintext by default; TLS is opt-in via `enabled` or `tlsInsecure`.
    const useTls = !!(t?.enabled || t?.tlsInsecure);
    const sock: Duplex = this.opts.createSocket
      ? this.opts.createSocket(url, port)
      : useTls
        ? tls.connect({ host: url, port, servername: url, rejectUnauthorized: !t?.tlsInsecure })
        : net.connect({ host: url, port });
    this.#sock = sock;

    const decoder = createFrameDecoder({ maxFrameBytes: MAX_FRAME_BYTES });
    let ready = false;
    let closed = false;
    const helloTimer = setTimeout(() => {
      this.#emitError(new Error('hello_timeout'));
      sock.destroy();
    }, this.opts.helloTimeoutMs ?? 10_000);

    const becomeReady = () => {
      if (ready || closed) return;
      ready = true;
      clearTimeout(helloTimer);
      // Only a link that stays up resets backoff; connect-then-drop flaps keep growing it.
      this.#stableTimer = setTimeout(() => {
        this.#stableTimer = null;
        this.#attempt = 0;
      }, this.opts.stableMs ?? 10_000);
      this.#setStatus('connected');
    };

    const sendHello = () => {
      const id = this.opts.identity;
      const hello: Hello = {
        token: this.opts.token?.reveal() ?? '',
        role,
        ...(role === 'host' && id ? { code: id.code, secret: id.secret.reveal() } : {}),
      };
      this.#write(hello);
      this.emit('hello', redactHello(hello));
      // Viewers (and hosts reclaiming a code) get no reply to wait for. A host that needs a mint waits for assign_code.
      if (role === 'viewer' || id) becomeReady();
    };
    // TLS socket fires 'secureConnect'; plaintext/injected sockets fire 'connect'.
    const evt = !this.opts.createSocket && useTls ? 'secureConnect' : 'connect';
    sock.once(evt, sendHello);

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
        let env: Envelope;
        try {
          env = JSON.parse(dec.decode(f)) as Envelope;
        } catch {
          this.#emitError(new Error('bad_frame_json'));
          continue;
        }
        if (!env || typeof env.type !== 'string') {
          this.#emitError(new Error('bad_envelope'));
          continue;
        }
        if (env.type === SignalingTypes.AssignCode) {
          void this.#onAssign(env, sock, becomeReady);
          continue;
        }
        if (ready) this.emit('envelope', env);
      }
    });

    sock.on('error', (e) => this.#emitError(e));
    sock.on('close', () => {
      if (closed) return;
      closed = true;
      clearTimeout(helloTimer);
      this.#clearStable();
      if (this.#sock === sock) this.#sock = null;
      this.#setStatus('disconnected');
      if (!this.#stopped && (this.opts.reconnect ?? role === 'host')) this.#scheduleReconnect();
    });
  }

  async #onAssign(env: Envelope, sock: Duplex, becomeReady: () => void): Promise<void> {
    const d = (env.data ?? {}) as { code?: unknown; secret?: unknown };
    if (this.opts.role !== 'host' || typeof d.code !== 'string' || !d.code || typeof d.secret !== 'string' || !d.secret) {
      this.#emitError(new Error('bad_assign_code'));
      return;
    }
    try {
      await this.opts.onAssignCode?.({ code: d.code, secret: d.secret });
    } catch (e) {
      this.#emitError(e instanceof Error ? e : new Error('persist_identity_failed'));
      sock.destroy();
      return;
    }
    this.emit('identity', { code: d.code });
    becomeReady();
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
