import { EventEmitter } from 'node:events';
import type { WorkerCommand, WorkerEvent } from './worker/peerEngine';
import { createWindowWorker } from './worker/windowWorker';

/** Main-process handle to whatever hosts the RTCPeerConnection (hidden window in prod, mock in tests). */
export interface TransportWorker {
  call(cmd: WorkerCommand, ...args: unknown[]): Promise<unknown>;
  onEvent(cb: (e: WorkerEvent) => void): void;
  destroy(): void;
}

export interface WebRtcTransportOpts {
  iceServers: RTCIceServer[];
  role: 'host' | 'viewer';
  /** Test seam: supply the worker. Called lazily on first API use. */
  createWorker?: () => TransportWorker;
}

/**
 * Thin proxy over a WebRTC peer connection that lives in a hidden renderer
 * (the main process has no RTCPeerConnection). Events: 'message' (Uint8Array),
 * 'local-candidate' (string), 'open' | 'close', 'error' (Error).
 *
 * Viewer side: the data channel arrives via ondatachannel in the worker and
 * 'open' fires once it is usable; the host calls openDataChannel().
 */
export class WebRtcTransport extends EventEmitter {
  #worker: TransportWorker | null = null;
  #closed = false;
  readonly role: 'host' | 'viewer';

  constructor(private readonly opts: WebRtcTransportOpts) {
    super();
    this.role = opts.role;
  }

  async createOffer(): Promise<string> { return (await this.#call('create-offer')) as string; }
  async createAnswer(sdp: string): Promise<string> { return (await this.#call('create-answer', sdp)) as string; }
  async setRemoteDescription(sdp: string): Promise<void> {
    // Host receives the viewer's answer; viewer receives the host's offer.
    await this.#call('set-remote-description', sdp, this.role === 'viewer' ? 'offer' : 'answer');
  }
  async addIceCandidate(cand: string): Promise<void> { await this.#call('add-ice-candidate', cand); }
  async openDataChannel(label: string): Promise<void> { await this.#call('open-dc', label); }

  send(bytes: Uint8Array): void {
    const w = this.#worker;
    if (!w || this.#closed) { this.#safeEmitError(new Error('transport not started')); return; }
    w.call('send', bytes).catch((err: unknown) => this.#safeEmitError(toError(err)));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const w = this.#worker;
    this.#worker = null;
    if (!w) return;
    w.call('close').catch(() => { /* worker may already be gone */ }).finally(() => w.destroy());
  }

  async #call(cmd: WorkerCommand, ...args: unknown[]): Promise<unknown> {
    if (this.#closed) throw new Error('transport closed');
    if (!this.#worker) {
      const w = (this.opts.createWorker ?? createWindowWorker)();
      this.#worker = w;
      w.onEvent((e) => this.#dispatch(e));
      await w.call('create-pc', this.opts.iceServers);
    }
    return this.#worker.call(cmd, ...args);
  }

  #safeEmitError(err: Error): void {
    // EventEmitter throws on 'error' with no listener; drop instead.
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }

  #dispatch(e: WorkerEvent): void {
    switch (e.type) {
      case 'message': this.emit('message', e.bytes); break;
      case 'local-candidate': this.emit('local-candidate', e.cand); break;
      case 'open': this.emit('open'); break;
      case 'close': this.emit('close'); break;
      case 'error': this.#safeEmitError(new Error(e.message)); break;
    }
  }
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}
