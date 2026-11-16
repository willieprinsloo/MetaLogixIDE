import { utf8Decode, utf8Encode } from './bytes';
import type { SecureChannel } from './secure';
import { createFrameDecoder, encodeFrame, MAX_FRAME_BYTES } from './wire';

/** Shapes mirror src/shared/p2p-contract.ts (the host validates everything it returns). */
export type Project = { id: number; name: string; path: string };
export type AgentState = 'idle' | 'busy' | 'blocked';
export type ShellInfo = {
  projectId: number;
  shellIndex: number;
  agentState?: AgentState | null;
  /** The command the shell was launched with; argv[0] names the tab. */
  launchArgv?: string[];
  /** The agent the host detects running in the shell (`claude`, `codex`, `opencode`). Absent from older hosts. */
  agent?: string | null;
};
export type DeviceInfo = { name: string; platform: string; version: string; uptime: number };

export interface Methods {
  'device.info': { params: Record<string, never>; result: DeviceInfo };
  'projects.list': { params: Record<string, never>; result: Project[] };
  'shells.alive': { params: Record<string, never>; result: ShellInfo[] };
  'shells.input': { params: { stream: number; bytes: string }; result: { ok: true } };
  'shells.resize': { params: { stream: number; cols: number; rows: number }; result: { ok: true } };
  'shells.launch': { params: { projectId: number; forceFirst?: boolean }; result: { shellIndex: number } };
}

export class RpcError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RpcError';
  }
}

type Frame =
  | { kind: 'res'; id: number; ok: true; result: unknown }
  | { kind: 'res'; id: number; ok: false; error: { code: string; message: string } }
  | { kind: 'evt'; stream: number; data: unknown }
  | { kind: 'close-stream'; stream: number }
  | { kind: 'req' | 'open-stream'; id: number };

interface Pending { resolve(v: unknown): void; reject(e: Error): void }
interface Stream { onEvent(data: unknown): void; onClose(reason: string): void; closed: boolean; id?: number }

export interface StreamHandle {
  /** Resolves with the wire stream id once the host has accepted the stream. */
  readonly ready: Promise<number>;
  close(): void;
}

/**
 * Viewer side of the desktop's RpcPeer: unary calls plus host-to-viewer streams. The phone serves
 * nothing, so inbound requests are refused.
 */
export class RpcClient {
  readonly #ch: SecureChannel;
  readonly #decoder = createFrameDecoder(MAX_FRAME_BYTES);
  readonly #pending = new Map<number, Pending>();
  readonly #streams = new Map<number, Stream>();
  #next = 1;
  #closed = false;
  #onClosed: (() => void) | null = null;

  readonly #onMessage = (bytes: Uint8Array) => this.#receive(bytes);
  readonly #onClose = () => this.#teardown();

  constructor(ch: SecureChannel) {
    this.#ch = ch;
    ch.on('message', this.#onMessage);
    ch.on('close', this.#onClose);
  }

  get closed(): boolean { return this.#closed; }

  /** Fires once when the peer or transport goes away. */
  onClosed(cb: () => void): void { this.#onClosed = cb; }

  call<M extends keyof Methods>(method: M, params: Methods[M]['params'], timeoutMs = 30_000): Promise<Methods[M]['result']> {
    if (this.#closed) return Promise.reject(new RpcError('closed', 'rpc peer closed'));
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) reject(new RpcError('request_timeout', `${method} did not respond in time`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as Methods[M]['result']); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.#send({ kind: 'req', id, method, params });
    });
  }

  /** Opens `shells.attach`. `onClose` fires exactly once: remote end, attach failure, local close or link loss. */
  attach(
    params: { projectId: number; shellIndex: number },
    onEvent: (data: unknown) => void,
    onClose: (reason: string) => void,
  ): StreamHandle {
    const st: Stream = { onEvent, onClose, closed: false };
    const end = (reason: string) => {
      if (st.closed) return;
      st.closed = true;
      if (st.id !== undefined) this.#streams.delete(st.id);
      onClose(reason);
    };
    const ready = new Promise<number>((resolve, reject) => {
      if (this.#closed) { reject(new RpcError('closed', 'rpc peer closed')); return; }
      const id = this.#next++;
      this.#pending.set(id, {
        resolve: (res) => {
          const stream = (res as { stream: number }).stream;
          st.id = stream;
          if (st.closed) this.#send({ kind: 'close-stream', stream });
          else this.#streams.set(stream, st);
          resolve(stream);
        },
        reject,
      });
      this.#send({ kind: 'open-stream', id, stream: 0, method: 'shells.attach', params });
    });
    ready.catch((e: unknown) => end(`attach_failed: ${e instanceof RpcError ? e.code : String(e)}`));
    return {
      ready,
      close: () => {
        if (st.closed) return;
        if (st.id !== undefined && !this.#closed) this.#send({ kind: 'close-stream', stream: st.id });
        end('closed');
      },
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#teardown();
    this.#ch.close();
  }

  #teardown(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#ch.off('message', this.#onMessage);
    this.#ch.off('close', this.#onClose);
    for (const p of [...this.#pending.values()]) p.reject(new RpcError('closed', 'rpc peer closed'));
    this.#pending.clear();
    for (const s of [...this.#streams.values()]) {
      if (!s.closed) { s.closed = true; s.onClose('link_lost'); }
    }
    this.#streams.clear();
    this.#onClosed?.();
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
      let f: Frame;
      try {
        f = JSON.parse(utf8Decode(p)) as Frame;
      } catch {
        continue;
      }
      if (f && typeof f === 'object') this.#dispatch(f);
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
        else p.reject(new RpcError(String(f.error?.code ?? 'error'), String(f.error?.message ?? 'request failed')));
        break;
      }
      case 'evt': {
        const s = this.#streams.get(f.stream);
        if (s && !s.closed) { try { s.onEvent(f.data); } catch { /* a bad consumer must not kill the channel */ } }
        break;
      }
      case 'close-stream': {
        const s = this.#streams.get(f.stream);
        if (!s) return;
        this.#streams.delete(f.stream);
        if (!s.closed) { s.closed = true; s.onClose('remote_ended'); }
        break;
      }
      case 'req':
      case 'open-stream':
        this.#send({ kind: 'res', id: f.id, ok: false, error: { code: 'unknown_method', message: 'this device serves nothing' } });
        break;
    }
  }
}
