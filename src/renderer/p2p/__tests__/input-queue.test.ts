import { describe, test, expect, vi } from 'vitest';
import { createInputQueue, INPUT_CHUNK_BYTES, MAX_REMOTE_PASTE_BYTES, type InputError } from '../input-queue';

function setup() {
  const sent: string[] = [];
  const resolvers: Array<{ ok: () => void; fail: (e: Error) => void }> = [];
  const errors: InputError[] = [];
  const send = vi.fn((t: string) => {
    sent.push(t);
    return new Promise<void>((ok, fail) => resolvers.push({ ok, fail }));
  });
  const q = createInputQueue({ send, onError: (e) => errors.push(e) });
  const settle = async () => { resolvers[resolvers.length - 1]?.ok(); await Promise.resolve(); await Promise.resolve(); };
  return { q, sent, send, resolvers, errors, settle };
}

describe('createInputQueue', () => {
  test('only one send in flight; later pushes coalesce into one frame in order', async () => {
    const { q, sent, settle } = setup();
    q.push('a'); q.push('b'); q.push('c');
    expect(sent).toEqual(['a']);
    await settle();
    expect(sent).toEqual(['a', 'bc']);
  });

  test('every frame is at most 256 KiB UTF-8 and the concatenation preserves order with interleaved keys', async () => {
    const { q, sent, settle } = setup();
    q.push('x'.repeat(2 * 1024 * 1024));
    q.push('KEY');
    for (let i = 0; i < 20; i++) await settle();
    const enc = new TextEncoder();
    expect(sent.every((s) => enc.encode(s).length <= INPUT_CHUNK_BYTES)).toBe(true);
    expect(sent.join('')).toBe('x'.repeat(2 * 1024 * 1024) + 'KEY');
    expect(sent.length).toBeGreaterThan(8);
  });

  test('never splits a code point: each frame decodes independently to the original', async () => {
    const { q, sent, settle } = setup();
    const text = '😀日a'.repeat(300_000).slice(0, 1_000_000);
    q.push('é');
    q.push(text);
    for (let i = 0; i < 20; i++) await settle();
    const dec = new TextDecoder('utf-8', { fatal: true });
    const enc = new TextEncoder();
    const round = sent.map((s) => dec.decode(enc.encode(s)));
    expect(round.join('')).toBe('é' + text);
    for (const s of sent) expect(/[\ud800-\udbff]$|^[\udc00-\udfff]/.test(s)).toBe(false);
  });

  test('over 4 MiB is refused whole: too-large error, nothing sent', () => {
    const { q, send, errors } = setup();
    q.push('x'.repeat(MAX_REMOTE_PASTE_BYTES + 1));
    expect(send).not.toHaveBeenCalled();
    expect(errors).toEqual([{ kind: 'too-large', limitBytes: MAX_REMOTE_PASTE_BYTES }]);
  });

  test('a push that would grow the pending buffer past 4 MiB is refused, earlier data still flows', () => {
    const { q, send, errors } = setup();
    q.push('a');
    q.push('x'.repeat(MAX_REMOTE_PASTE_BYTES));
    q.push('y');
    expect(errors).toEqual([{ kind: 'too-large', limitBytes: MAX_REMOTE_PASTE_BYTES }]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('exactly 4 MiB is accepted', () => {
    const { q, send, errors } = setup();
    q.push('x'.repeat(MAX_REMOTE_PASTE_BYTES));
    expect(send).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });

  test('a rejection drops pending data and reports failed once', async () => {
    const { q, resolvers, send, errors } = setup();
    q.push('a'); q.push('b');
    resolvers[0]?.fail(new Error('link down'));
    await Promise.resolve(); await Promise.resolve();
    expect(errors).toEqual([{ kind: 'failed', message: 'link down' }]);
    expect(send).toHaveBeenCalledTimes(1);
    q.push('c');
    expect(send).toHaveBeenCalledTimes(2);
  });
});
