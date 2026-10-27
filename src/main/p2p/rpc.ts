import { EventEmitter } from 'node:events';
import {
  Frame,
  RpcMethods,
  type Params,
  type Result,
  type RpcMethodName,
} from '../../shared/p2p-contract';
import { createFrameDecoder, encodeFrame } from '../../shared/signaling-wire';
import type { WebRtcTransport } from './transport';

/** The slice of WebRtcTransport the RPC layer needs (lets tests supply a double). */
export type RpcTransport = Pick<WebRtcTransport, 'send' | 'close' | 'on' | 'off'>;

export const MAX_RPC_FRAME_BYTES = 1 << 20;

/*
 * v1 invariant: streams are ONE-WAY. The viewer calls openStream(); the host
 * handles it with an AsyncIterable. Stream ids are allocated by the handling
 * side, so host-initiated streams in the other direction would collide with
 * ids in the same space. A peer constructed with allowIncomingStreams:false
 * (the viewer) refuses open-stream frames, making the collision unreachable.
 * If v2 adds host-initiated streams, use role-tagged id spaces.
 *
 * TODO(v2): AbortSignal passed to handlers — see task-6-report fix round 1 for context
 * TODO(v1.x): no cap on concurrent streams/requests and no backpressure.
 */

export interface RpcPeerOptions {
  /** Default true. When false, inbound `open-stream` is refused and the handler is not invoked. */
  allowIncomingStreams?: boolean;
  /** Audit hook, see `RpcPeer.setOnCall`. */
  onCall?: OnCall;
}

/** Outcome of an inbound request, reported once per request (streams: at open). */
export type CallOutcome = 'ok' | { error: string };
export type OnCall = (method: string, params: unknown, outcome: CallOutcome) => void;

const CANCELLED = Symbol('cancelled');

export class RpcError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RpcError';
  }
}

/** `stream` is the wire id pre-allocated for a stream request (undefined for unary calls). */
export interface HandlerContext { stream?: number }
type Impl = (params: unknown, ctx: HandlerContext) => Promise<unknown> | AsyncIterable<unknown>;

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
}

interface ClientStream {
  onEvent(data: unknown): void;
  closed: boolean;
  stream?: number;
  onClose?: () => void;
}

const textEnc = new TextEncoder();
const textDec = new TextDecoder();

function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return typeof v === 'object' && v !== null && typeof (v as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function';
}

/**
 * Request/response + server-streamed RPC over a length-framed JSON byte channel.
 *
 * Request ids are allocated by the caller, stream ids by the handling side.
 * A stream is opened with `open-stream`; the handler's AsyncIterable is pumped
 * as `evt` frames after the `res` carrying `{ stream }`, and ends with `close-stream`.
 */
export class RpcPeer extends EventEmitter {
  readonly #transport: RpcTransport;
  readonly #decoder = createFrameDecoder({ maxFrameBytes: MAX_RPC_FRAME_BYTES });
  readonly #handlers = new Map<string, Impl>();
  readonly #pending = new Map<number, Pending>();
  readonly #clientStreams = new Map<number, ClientStream>(); // by stream id
  readonly #serverStreams = new Map<number, AsyncIterator<unknown>>();
  readonly #cancels = new Map<number, { promise: Promise<typeof CANCELLED>; resolve(): void }>();
  readonly #allowIncomingStreams: boolean;
  #onCall: OnCall | null;
  #nextReq = 1;
  #nextStream = 1;
  #closed = false;

  readonly #onMessage = (bytes: Uint8Array) => this.#receive(bytes);
  readonly #onClose = () => this.#teardown();

  constructor(transport: RpcTransport, opts: RpcPeerOptions = {}) {
    super();
    this.#allowIncomingStreams = opts.allowIncomingStreams ?? true;
    this.#onCall = opts.onCall ?? null;
    this.#transport = transport as RpcTransport;
    this.#transport.on('message', this.#onMessage);
    this.#transport.on('close', this.#onClose);
  }

  handle<M extends RpcMethodName>(
    method: M,
    impl: (params: Params<M>, ctx: HandlerContext) => Promise<Result<M>> | AsyncIterable<unknown>,
  ): void {
    this.#handlers.set(method, impl as Impl);
  }

  /**
   * Registers the audit hook. Invoked exactly once per inbound request with the method, the raw
   * (unvalidated) params and the outcome: `unknown_method`, `invalid_params`, `result_too_large`,
   * `invalid_result`, handler error codes, or 'ok'. It must not throw; if it does, the error is swallowed.
   */
  setOnCall(cb: OnCall | null): void {
    this.#onCall = cb;
  }

  call<M extends RpcMethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    if (this.#closed) return Promise.reject(new RpcError('closed', 'rpc peer closed'));
    const id = this.#nextReq++;
    return new Promise<Result<M>>((resolve, reject) => {
      // Without a timeout, a wedged data channel leaves every call hanging
      // forever — the symptom users see as "P2P stops responding". 30s is
      // long enough for a normal fs.read, short enough that a dead channel
      // surfaces promptly instead of appearing-but-doing-nothing.
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) {
          reject(new RpcError('request_timeout', `${method} did not respond within 30s`));
        }
      }, 30_000);
      (timer as { unref?: () => void }).unref?.();
      this.#pending.set(id, {
        resolve: (v: unknown) => { clearTimeout(timer); (resolve as (v: unknown) => void)(v); },
        reject: (e: Error) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.#send({ kind: 'req', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(err as Error);
      }
    });
  }

  openStream<M extends RpcMethodName>(
    method: M,
    params: Params<M>,
    onEvent: (data: unknown) => void,
    onClose?: () => void,
  ): { close(): void; readonly stream: number | undefined } {
    // onClose fires only when the REMOTE ends the stream (not on a local handle.close()).
    const st: ClientStream = { onEvent, closed: false, onClose };
    const handle = {
      get stream() { return st.stream; },
      close: () => {
        if (st.closed) return;
        st.closed = true;
        if (st.stream !== undefined) {
          this.#clientStreams.delete(st.stream);
          this.#send({ kind: 'close-stream', stream: st.stream });
        }
        // else: the open response will see `closed` and close immediately.
      },
    };
    if (this.#closed) {
      st.closed = true;
      return handle;
    }
    const id = this.#nextReq++;
    this.#pending.set(id, {
      resolve: (res) => {
        const stream = (res as { stream: number }).stream;
        st.stream = stream;
        if (st.closed) this.#send({ kind: 'close-stream', stream });
        else this.#clientStreams.set(stream, st);
      },
      reject: (err) => {
        st.closed = true;
        this.#emitError(err);
      },
    });
    // `stream` is a placeholder on open: the handling side allocates the real id.
    try {
      this.#send({ kind: 'open-stream', id, stream: 0, method, params });
    } catch (err) {
      this.#pending.delete(id);
      st.closed = true;
      throw err;
    }
    return handle;
  }

  close(): void {
    if (this.#closed) return;
    this.#teardown();
    this.#transport.close();
  }

  // ---- internals ----

  #teardown(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#transport.off('message', this.#onMessage);
    this.#transport.off('close', this.#onClose);
    for (const [, p] of this.#pending) p.reject(new RpcError('closed', 'rpc peer closed'));
    this.#pending.clear();
    this.#clientStreams.clear();
    this.#serverStreams.clear();
    for (const [, c] of this.#cancels) c.resolve(); // pumps call it.return()
    this.#cancels.clear();
  }

  #emitError(err: Error): void {
    // EventEmitter throws on 'error' without a listener; drop instead.
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }

  #send(frame: Frame): void {
    if (this.#closed) return;
    const payload = textEnc.encode(JSON.stringify(frame));
    if (payload.byteLength > MAX_RPC_FRAME_BYTES) {
      switch (frame.kind) {
        case 'res':
          // Handler ran fine; protect the channel with a surrogate error.
          this.#send({
            kind: 'res', id: frame.id, ok: false,
            error: { code: 'result_too_large', message: 'response exceeded 1 MiB cap' },
          });
          return;
        case 'evt':
          this.#emitError(new Error(`event_too_large: stream ${frame.stream}`));
          this.#cancelServerStream(frame.stream);
          this.#send({ kind: 'close-stream', stream: frame.stream });
          return;
        default:
          throw new RpcError('request_too_large', 'request exceeded 1 MiB cap');
      }
    }
    this.#transport.send(encodeFrame(payload));
  }

  #cancelServerStream(stream: number): void {
    this.#serverStreams.delete(stream);
    const c = this.#cancels.get(stream);
    if (c) { this.#cancels.delete(stream); c.resolve(); }
  }

  #receive(bytes: Uint8Array): void {
    let payloads: Uint8Array[];
    try {
      payloads = this.#decoder.push(bytes);
    } catch (err) {
      // Oversized frame: stream sync is lost, so the channel must go.
      this.#emitError(err instanceof Error ? err : new Error(String(err)));
      this.close();
      return;
    }
    for (const p of payloads) {
      let frame: Frame;
      try {
        const parsed = Frame.safeParse(JSON.parse(textDec.decode(p)));
        if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join('; '));
        frame = parsed.data;
      } catch (err) {
        this.#emitError(new Error(`rpc_parse_error: ${err instanceof Error ? err.message : String(err)}`));
        continue;
      }
      // Yield to the event loop between frames so a burst cannot monopolise it.
      setImmediate(() => this.#dispatch(frame));
    }
  }

  #dispatch(f: Frame): void {
    if (this.#closed) return;
    switch (f.kind) {
      case 'req': void this.#onRequest(f.id, f.method, f.params, false); break;
      case 'open-stream':
        if (!this.#allowIncomingStreams) {
          this.#fail(f.id, 'streams_not_allowed_on_this_side', 'this peer does not accept incoming streams');
          break;
        }
        void this.#onRequest(f.id, f.method, f.params, true);
        break;
      case 'res': {
        const p = this.#pending.get(f.id);
        if (!p) return;
        this.#pending.delete(f.id);
        if (f.ok) p.resolve(f.result);
        else p.reject(new RpcError(f.error.code, f.error.message));
        break;
      }
      case 'evt': {
        const s = this.#clientStreams.get(f.stream);
        if (!s) return;
        try {
          s.onEvent(f.data);
        } catch (err) {
          this.#emitError(err instanceof Error ? err : new Error(String(err)));
        }
        break;
      }
      case 'close-stream': {
        // Remote end finished a client stream, or asked us to cancel a server stream.
        const cs = this.#clientStreams.get(f.stream);
        if (cs) {
          cs.closed = true;
          this.#clientStreams.delete(f.stream);
          try { cs.onClose?.(); } catch (err) { this.#emitError(err instanceof Error ? err : new Error(String(err))); }
        }
        this.#cancelServerStream(f.stream);
        break;
      }
    }
  }

  #report(method: string, params: unknown, outcome: CallOutcome): void {
    if (!this.#onCall) return;
    try { this.#onCall(method, params, outcome); } catch { /* auditing must never break the channel */ }
  }

  #fail(id: number, code: string, message: string): void {
    this.#send({ kind: 'res', id, ok: false, error: { code, message } });
  }

  #handlerFailed(id: number, method: string, params: unknown, err: unknown): void {
    // A handler that throws RpcError chose its code and message for the peer (e.g. path_outside_project).
    if (err instanceof RpcError) {
      this.#report(method, params, { error: err.code });
      return this.#fail(id, err.code, err.message);
    }
    this.#report(method, params, { error: 'handler_error' });
    // Detail stays local; the peer gets a generic message (no information disclosure).
    this.#emitError(new Error(`handler_error: ${method}: ${err instanceof Error ? err.message : String(err)}`));
    this.#fail(id, 'handler_error', 'handler failed');
  }

  async #onRequest(id: number, method: string, params: unknown, wantStream: boolean): Promise<void> {
    const impl = this.#handlers.get(method);
    const spec = (RpcMethods as Record<string, (typeof RpcMethods)[RpcMethodName]>)[method];
    if (!impl || !spec) {
      this.#report(method, params, { error: 'unknown_method' });
      return this.#fail(id, 'unknown_method', `unknown method: ${method}`);
    }

    const parsedParams = spec.params.safeParse(params);
    if (!parsedParams.success) {
      const msg = parsedParams.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      this.#report(method, params, { error: 'invalid_params' });
      return this.#fail(id, 'invalid_params', msg);
    }

    let out: Promise<unknown> | AsyncIterable<unknown>;
    // Allocated up front so a stream handler can register its own wire id (e.g. for shells.input).
    const stream = wantStream ? this.#nextStream++ : undefined;
    try {
      out = impl(parsedParams.data, { stream });
    } catch (err) {
      return this.#handlerFailed(id, method, params, err);
    }

    if (isAsyncIterable(out)) {
      if (!wantStream) {
        void Promise.resolve(out[Symbol.asyncIterator]().return?.()).catch(() => {});
        this.#report(method, params, { error: 'stream_method' });
        return this.#fail(id, 'stream_method', `${method} is a stream; use openStream`);
      }
      const it = out[Symbol.asyncIterator]();
      this.#serverStreams.set(stream!, it);
      let resolve!: () => void;
      const promise = new Promise<typeof CANCELLED>((r) => { resolve = () => r(CANCELLED); });
      this.#cancels.set(stream!, { promise, resolve });
      this.#report(method, params, 'ok');
      this.#send({ kind: 'res', id, ok: true, result: { stream: stream! } });
      void this.#pump(stream!, it);
      return;
    }

    let value: unknown;
    try {
      value = await out;
    } catch (err) {
      return this.#handlerFailed(id, method, params, err);
    }
    if (wantStream) {
      this.#report(method, params, { error: 'not_a_stream' });
      return this.#fail(id, 'not_a_stream', `${method} is not a stream`);
    }
    const parsedResult = spec.result.safeParse(value);
    if (!parsedResult.success) {
      // Server-side bug: surface locally, tell the peer without leaking details.
      this.#emitError(new Error(`invalid_result: ${method}: ${parsedResult.error.message}`));
      this.#report(method, params, { error: 'invalid_result' });
      return this.#fail(id, 'invalid_result', `handler for ${method} returned an invalid result`);
    }
    const okFrame: Frame = { kind: 'res', id, ok: true, result: parsedResult.data };
    const tooLarge = textEnc.encode(JSON.stringify(okFrame)).byteLength > MAX_RPC_FRAME_BYTES;
    this.#report(method, params, tooLarge ? { error: 'result_too_large' } : 'ok');
    this.#send(okFrame);
  }

  async #pump(stream: number, it: AsyncIterator<unknown>): Promise<void> {
    const cancel = this.#cancels.get(stream)?.promise;
    // NOTE: #pump calls it.return?.() without awaiting it. For an async generator
    // whose body is parked on a never-resolving await, that return() queues
    // behind the pending next() and the generator's finally never runs. v1
    // handlers must not have unobservable waits (shells.attach reads a PTY stream
    // that always eventually ends or emits). A proper fix needs an AbortSignal
    // passed through handle() — tracked for v2.
    const stop = () => { void Promise.resolve(it.return?.()).catch(() => {}); };
    try {
      for (;;) {
        if (this.#closed || this.#serverStreams.get(stream) !== it) {
          // stream was cancelled (e.g., oversized-evt path, close-stream, or teardown)
          stop();
          return;
        }
        const n = it.next();
        n.catch(() => {}); // a loser of the race must not become an unhandled rejection
        const r = cancel ? await Promise.race([n, cancel]) : await n;
        // Do not await it.return(): behind a pending next() it can never settle.
        if (r === CANCELLED || this.#closed || this.#serverStreams.get(stream) !== it) { stop(); return; }
        if (r.done) break;
        this.#send({ kind: 'evt', stream, data: r.value });
      }
    } catch (err) {
      this.#emitError(err instanceof Error ? err : new Error(String(err)));
    }
    if (this.#serverStreams.get(stream) === it) {
      this.#serverStreams.delete(stream);
      this.#cancels.delete(stream);
      this.#send({ kind: 'close-stream', stream });
    }
  }
}
