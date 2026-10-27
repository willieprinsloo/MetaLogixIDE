import { describe, test, expect } from 'vitest';
import { encodeFrame, createFrameDecoder, Secret, TypeMetaIDE, SignalingTypes } from '../signaling-wire';
import { RpcMethods, Frame } from '../p2p-contract';

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

describe('encodeFrame / createFrameDecoder', () => {
  test('roundtrips a single frame', () => {
    const bytes = new TextEncoder().encode('{"type":"register"}');
    const dec = createFrameDecoder();
    expect(dec.push(encodeFrame(bytes))).toEqual([bytes]);
  });

  test('yields multiple frames from one chunk', () => {
    const a = new TextEncoder().encode('{"a":1}');
    const b = new TextEncoder().encode('{"b":2}');
    const combined = concat(encodeFrame(a), encodeFrame(b));
    const dec = createFrameDecoder();
    expect(dec.push(combined)).toEqual([a, b]);
  });

  test('reassembles a frame split across chunks', () => {
    const bytes = new TextEncoder().encode('{"hello":"world"}');
    const enc = encodeFrame(bytes);
    const dec = createFrameDecoder();
    expect(dec.push(enc.slice(0, 3))).toEqual([]);
    expect(dec.push(enc.slice(3))).toEqual([bytes]);
  });

  test('rejects a length prefix over the frame-size cap', () => {
    const dec = createFrameDecoder({ maxFrameBytes: 1024 });
    const bad = new Uint8Array([0x00, 0x10, 0x00, 0x00]); // ~1 MiB claim
    expect(() => dec.push(bad)).toThrow(/frame_too_large/);
  });

  test('uses a big-endian u32 prefix and a 1 MiB default cap', () => {
    const enc = encodeFrame(new Uint8Array(258));
    expect(Array.from(enc.slice(0, 4))).toEqual([0, 0, 1, 2]);
    const over = new Uint8Array([0x00, 0x10, 0x00, 0x01]);
    expect(() => createFrameDecoder().push(over)).toThrow(/frame_too_large/);
  });
});

describe('Secret', () => {
  test('reveal returns the inner value', () => {
    expect(new Secret('abc').reveal()).toBe('abc');
  });
  test('toString and JSON serialize to <redacted>', () => {
    const s = new Secret('abc');
    expect(String(s)).toBe('<redacted>');
    expect(JSON.stringify({ s })).toBe('{"s":"<redacted>"}');
  });
});

describe('constants and RpcMethods', () => {
  test('exports signaling literals', () => {
    expect(TypeMetaIDE).toBe('metaide');
    expect(SignalingTypes.SessionInvite).toBe('session_invite');
  });
  test('Frame accepts both res variants and rejects unknown kinds', () => {
    expect(Frame.safeParse({ kind: 'res', id: 1, ok: true, result: 1 }).success).toBe(true);
    expect(Frame.safeParse({ kind: 'res', id: 1, ok: false, error: { code: 'x', message: 'y' } }).success).toBe(true);
    expect(Frame.safeParse({ kind: 'bogus' }).success).toBe(false);
  });
  test('RpcMethods validates params', () => {
    expect(RpcMethods['projects.get'].params.safeParse({ id: 1 }).success).toBe(true);
    expect(RpcMethods['projects.get'].params.safeParse({ id: 'x' }).success).toBe(false);
    expect(RpcMethods['projects.get'].params.safeParse({ id: 0 }).success).toBe(false);
    expect(RpcMethods['projects.get'].params.safeParse({}).success).toBe(false);
  });
});
