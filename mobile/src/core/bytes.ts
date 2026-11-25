/** Byte helpers with no platform dependencies (Hermes lacks parts of TextDecoder/Buffer/DataView BigInt). */

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd; // lone surrogate
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}

export function utf8Decode(b: Uint8Array): string {
  const parts: string[] = [];
  let units: number[] = [];
  const flush = () => { if (units.length) { parts.push(String.fromCharCode.apply(null, units)); units = []; } };
  for (let i = 0; i < b.length; ) {
    const c = b[i]!;
    let cp = 0xfffd;
    let n = 1;
    if (c < 0x80) cp = c;
    else if (c >= 0xc2 && c < 0xe0 && i + 1 < b.length) { cp = ((c & 0x1f) << 6) | (b[i + 1]! & 0x3f); n = 2; }
    else if (c >= 0xe0 && c < 0xf0 && i + 2 < b.length) { cp = ((c & 0x0f) << 12) | ((b[i + 1]! & 0x3f) << 6) | (b[i + 2]! & 0x3f); n = 3; }
    else if (c >= 0xf0 && c < 0xf5 && i + 3 < b.length) {
      cp = ((c & 0x07) << 18) | ((b[i + 1]! & 0x3f) << 12) | ((b[i + 2]! & 0x3f) << 6) | (b[i + 3]! & 0x3f);
      n = 4;
    }
    i += n;
    if (cp >= 0x10000) { cp -= 0x10000; units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)); }
    else units.push(cp);
    if (units.length >= 4096) flush();
  }
  flush();
  return parts.join('');
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64Encode(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const a = b[i]!, c = b[i + 1], d = b[i + 2];
    out += B64[a >> 2]! + B64[((a & 3) << 4) | ((c ?? 0) >> 4)]!;
    out += c === undefined ? '=' : B64[((c & 15) << 2) | ((d ?? 0) >> 6)]!;
    out += d === undefined ? '=' : B64[d & 63]!;
  }
  return out;
}

export function toHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i]! < 16 ? '0' : '') + b[i]!.toString(16);
  return s;
}

export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error('invalid hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

/** Tiny emitter with the on/off/emit surface the transports share. */
export class Emitter {
  #l = new Map<string, Set<(...a: never[]) => void>>();
  on(ev: string, cb: (...a: never[]) => void): this {
    let s = this.#l.get(ev);
    if (!s) this.#l.set(ev, (s = new Set()));
    s.add(cb);
    return this;
  }
  off(ev: string, cb: (...a: never[]) => void): this {
    this.#l.get(ev)?.delete(cb);
    return this;
  }
  emit(ev: string, ...args: unknown[]): void {
    for (const cb of [...(this.#l.get(ev) ?? [])]) (cb as (...a: unknown[]) => void)(...args);
  }
}
