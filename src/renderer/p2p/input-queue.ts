/**
 * Ordered, coalescing send queue for remote shell input. At most one `send` is in flight; bytes
 * pushed meanwhile accumulate and are flushed in frames of at most `INPUT_CHUNK_BYTES` UTF-8
 * bytes, split on code-point boundaries so the host never decodes half a character. A single
 * push over `MAX_REMOTE_PASTE_BYTES` is refused whole (`onError` too-large, nothing sent). A
 * rejected send drops everything pending and reports `failed`.
 */
export const INPUT_CHUNK_BYTES = 256 * 1024;
export const MAX_REMOTE_PASTE_BYTES = 4 * 1024 * 1024;

export type InputError =
  | { kind: 'too-large'; limitBytes: number }
  | { kind: 'failed'; message: string };

export interface InputQueueOptions {
  send: (text: string) => Promise<unknown>;
  onError: (e: InputError) => void;
}

export interface InputQueue {
  push(text: string): void;
}

function takeChunk(text: string, maxBytes: number): number {
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i) as number;
    const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size;
    i += cp > 0xffff ? 2 : 1;
  }
  return i;
}

export function createInputQueue(opts: InputQueueOptions): InputQueue {
  let pending = '';
  let inFlight = false;

  const pump = () => {
    if (inFlight || pending === '') return;
    const end = takeChunk(pending, INPUT_CHUNK_BYTES);
    const frame = pending.slice(0, end);
    pending = pending.slice(end);
    inFlight = true;
    opts.send(frame).then(
      () => { inFlight = false; pump(); },
      (err: unknown) => {
        inFlight = false;
        pending = '';
        opts.onError({ kind: 'failed', message: err instanceof Error ? err.message : String(err) });
      },
    );
  };

  return {
    push(text) {
      if (text === '') return;
      if (new TextEncoder().encode(text).length > MAX_REMOTE_PASTE_BYTES) {
        opts.onError({ kind: 'too-large', limitBytes: MAX_REMOTE_PASTE_BYTES });
        return;
      }
      pending += text;
      pump();
    },
  };
}
