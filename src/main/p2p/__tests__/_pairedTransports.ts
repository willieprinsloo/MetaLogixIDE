import { EventEmitter } from 'node:events';
import type { RpcTransport } from '../rpc';

/** In-memory transport double: send() delivers to the peer's 'message' event asynchronously. */
export class MockTransport extends EventEmitter {
  peer: MockTransport | null = null;
  closed = false;
  sent: Uint8Array[] = [];

  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
    const p = this.peer;
    if (p && !this.closed) queueMicrotask(() => p.emit('message', bytes));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  /** Inject raw bytes as if received from the remote end. */
  inject(bytes: Uint8Array): void {
    this.emit('message', bytes);
  }

  asTransport(): RpcTransport {
    return this as unknown as RpcTransport;
  }
}

export function pairedTransports(): [MockTransport, MockTransport] {
  const a = new MockTransport();
  const b = new MockTransport();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
