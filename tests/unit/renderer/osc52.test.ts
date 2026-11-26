import { describe, test, expect, vi } from 'vitest';
import { parseOsc52, OSC52_MAX_BYTES } from '@renderer/osc52';

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

describe('parseOsc52', () => {
  test.each(['c', '', 'p', 's', 'pc'])('Pc=%j with base64 is a write', (pc) => {
    expect(parseOsc52(`${pc};${b64('hi')}`)).toEqual({ kind: 'write', text: 'hi' });
  });
  test('unknown selection target is ignored', () => {
    expect(parseOsc52(`0;${b64('hi')}`)).toEqual({ kind: 'ignore' });
  });
  test('read query is ignored', () => {
    expect(parseOsc52('c;?')).toEqual({ kind: 'ignore' });
  });
  test.each(['c;', 'c;***', 'c;a', 'nosemicolon'])('invalid or empty payload %j is ignored', (d) => {
    expect(parseOsc52(d)).toEqual({ kind: 'ignore' });
  });
  test('invalid UTF-8 is ignored', () => {
    expect(parseOsc52(`c;${btoa('\xff\xfe')}`)).toEqual({ kind: 'ignore' });
  });
  test('emoji and CJK round trip', () => {
    const t = 'héllo 🎉 日本語';
    expect(parseOsc52(`c;${b64(t)}`)).toEqual({ kind: 'write', text: t });
  });
  test('exactly 1 MiB decoded is a write, one more byte is ignored', () => {
    expect(parseOsc52(`c;${btoa('a'.repeat(OSC52_MAX_BYTES))}`).kind).toBe('write');
    expect(parseOsc52(`c;${btoa('a'.repeat(OSC52_MAX_BYTES + 1))}`).kind).toBe('ignore');
  });
  test('oversize base64 is rejected before decoding', () => {
    const atobSpy = vi.spyOn(globalThis, 'atob');
    const huge = 'A'.repeat(Math.ceil(OSC52_MAX_BYTES / 3) * 4 + 4);
    expect(parseOsc52(`c;${huge}`)).toEqual({ kind: 'ignore' });
    expect(atobSpy).not.toHaveBeenCalled();
    atobSpy.mockRestore();
  });
});
