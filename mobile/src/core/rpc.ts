import { Cause, type Duration, Effect, Queue, Schema, type Scope, Stream } from 'effect';
import { utf8Decode, utf8Encode } from './bytes';
import { RpcError } from './errors';
import { Frame, Results, ShellEvent, type Method, type Params, type Result } from './schemas';
import type { SecureChannel } from './secure';
import { createFrameDecoder, encodeFrame, MAX_FRAME_BYTES } from './wire';

const decodeFrame = Schema.decodeUnknownOption(Frame);
const decodeShellEvent = Schema.decodeUnknownOption(ShellEvent);

interface Pending { resolve(v: unknown): void; reject(e: RpcError): void }
interface OpenStream { onEvent(data: unknown): void; onEnd(error: RpcError | null): void }

/** A live `shells.attach`: the wire id the host knows it by, and its events until the shell or the link ends. */
export interface AttachedShell {
  readonly stream: number;
  /** Ends normally when the host closes the stream (the shell exited); fails with `link_lost` when the link goes. */
  readonly events: Stream.Stream<ShellEvent, RpcError>;
}

/**
 * Viewer side of the desktop's RpcPeer: unary calls plus host-to-viewer streams. The phone serves
 * nothing, so inbound requests are refused. Frames are dispatched synchronously in arrival order.
 */
export class RpcClient {
  readonly #ch: SecureChannel;
  readonly #decoder = createFrameDecoder(MAX_FRAME_BYTES);
  readonly #pending = new Map<number, Pending>();
  readonly #streams = new Map<number, OpenStream>();
  readonly #closeListeners = new Set<() => void>();
  #next = 1;
  #closed = false;

  readonly #onMessage = (bytes: Uint8Array) => this.#receive(bytes);
  readonly #onClose = () => this.#teardown();

  constructor(ch: SecureChannel) {
    this.#ch = ch;
    ch.on('message', this.#onMessage);
    ch.on('close', this.#onClose);
  }

  get isClosed(): boolean { return this.#closed; }

  /** Completes when the peer or the transport goes away (at once if it already has). */
  readonly closed: Effect.Effect<void> = Effect.callback((resume) => {
    if (this.#closed) { resume(Effect.void); return; }
    const cb = () => resume(Effect.void);
    this.#closeListeners.add(cb);
    return Effect.sync(() => { this.#closeListeners.delete(cb); });
  });

  /** One request. Fails with the host's error code, `request_timeout`, `closed`, or `invalid_result`. */
  call<M extends Method>(method: M, params: Params[M], timeout: Duration.Input = '30 seconds'): Effect.Effect<Result<M>, RpcError> {
    return this.#request('req', method, params).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(new RpcError({ code: 'request_timeout', message: `${method} did not respond in time` })),
      }),
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(Results[method] as Schema.Decoder<Result<M>>)(value).pipe(
          Effect.mapError(() => new RpcError({ code: 'invalid_result', message: `${method} returned something unexpected` })),
        )),
    );
  }

  /**
   * Opens `shells.attach` for the lifetime of the scope: the host replays the screen, then streams output.
   * Closing the scope tells the host to stop.
   */
  attach(params: { projectId: number; shellIndex: number }): Effect.Effect<AttachedShell, RpcError, Scope.Scope> {
    return Effect.gen({ self: this }, function*() {
      const queue = yield* Queue.unbounded<ShellEvent, RpcError | Cause.Done>();
      // Events can share a batch with the response that names the stream, so the handlers are
      // registered inside the response callback, before the next frame is dispatched.
      const stream = yield* Effect.acquireRelease(
        this.#request('open-stream', 'shells.attach', params, (res) => {
          const id = (res as { stream?: unknown } | null)?.stream;
          if (typeof id !== 'number') return;
          this.#streams.set(id, {
            onEvent: (data) => {
              const ev = decodeShellEvent(data);
              if (ev._tag === 'Some') Queue.offerUnsafe(queue, ev.value);
            },
            onEnd: (error) => { if (error) Queue.failCauseUnsafe(queue, Cause.fail(error)); else Queue.endUnsafe(queue); },
          });
        }).pipe(
          Effect.flatMap((res) => {
            const id = (res as { stream?: unknown } | null)?.stream;
            return typeof id === 'number' ? Effect.succeed(id) : Effect.fail(new RpcError({ code: 'invalid_result', message: 'attach returned no stream' }));
          }),
        ),
        (id) => Effect.sync(() => {
          if (this.#streams.delete(id) && !this.#closed) this.#send({ kind: 'close-stream', stream: id });
          Queue.endUnsafe(queue);
        }),
      );
      return { stream, events: Stream.fromQueue(queue) };
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#teardown();
    this.#ch.close();
  }

  /** Sends a request and waits for its response; `onResult` runs synchronously when it arrives. Interruption forgets it. */
  #request(kind: 'req' | 'open-stream', method: string, params: unknown, onResult?: (v: unknown) => void): Effect.Effect<unknown, RpcError> {
    return Effect.callback<unknown, RpcError>((resume) => {
      if (this.#closed) { resume(Effect.fail(new RpcError({ code: 'closed', message: 'rpc peer closed' }))); return; }
      const id = this.#next++;
      this.#pending.set(id, {
        resolve: (v) => { onResult?.(v); resume(Effect.succeed(v)); },
        reject: (e) => resume(Effect.fail(e)),
      });
      this.#send(kind === 'req' ? { kind, id, method, params } : { kind, id, stream: 0, method, params });
      return Effect.sync(() => { this.#pending.delete(id); });
    });
  }

  #teardown(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#ch.off('message', this.#onMessage);
    this.#ch.off('close', this.#onClose);
    const gone = new RpcError({ code: 'closed', message: 'rpc peer closed' });
    for (const p of [...this.#pending.values()]) p.reject(gone);
    this.#pending.clear();
    for (const s of [...this.#streams.values()]) s.onEnd(new RpcError({ code: 'link_lost', message: 'the link to the machine was lost' }));
    this.#streams.clear();
    for (const cb of [...this.#closeListeners]) cb();
    this.#closeListeners.clear();
  }

  #send(frame: object): void {
    if (this.#closed) return;
    this.#ch.send(encodeFrame(utf8Encode(JSON.stringify(frame))));
  }

  #receive(bytes: Uint8Array): void {
    let payloads: Uint8Array[];
    try {
      payloads = this.#decoder.push(bytes);
    } catch {
      this.close();
      return;
    }
    for (const p of payloads) {
      let json: unknown;
      try { json = JSON.parse(utf8Decode(p)); } catch { continue; }
      const frame = decodeFrame(json);
      if (frame._tag === 'Some') this.#dispatch(frame.value);
    }
  }

  #dispatch(f: Frame): void {
    if (this.#closed) return;
    switch (f.kind) {
      case 'res': {
        const p = this.#pending.get(f.id);
        if (!p) return;
        this.#pending.delete(f.id);
        if (f.ok) p.resolve(f.result);
        else p.reject(new RpcError({ code: f.error.code, message: f.error.message }));
        break;
      }
      case 'evt':
        this.#streams.get(f.stream)?.onEvent(f.data);
        break;
      case 'close-stream': {
        const s = this.#streams.get(f.stream);
        if (!s) return;
        this.#streams.delete(f.stream);
        s.onEnd(null);
        break;
      }
      case 'req':
      case 'open-stream':
        this.#send({ kind: 'res', id: f.id, ok: false, error: { code: 'unknown_method', message: 'this device serves nothing' } });
        break;
    }
  }
}
