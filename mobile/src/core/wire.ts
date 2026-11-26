/** 4-byte big-endian length-prefixed frames: the relay wire and the RPC wire both use this (src/shared/signaling-wire.ts). */

export const MAX_FRAME_BYTES = 1024 * 1024;

export function encodeFrame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, 4);
  return out;
}

export function createFrameDecoder(max: number = MAX_FRAME_BYTES): { push(chunk: Uint8Array): Uint8Array[] } {
  let buf = new Uint8Array(0);
  return {
    push(chunk) {
      if (chunk.length > 0) {
        const next = new Uint8Array(buf.length + chunk.length);
        next.set(buf, 0);
        next.set(chunk, buf.length);
        buf = next;
      }
      const frames: Uint8Array[] = [];
      let offset = 0;
      while (buf.length - offset >= 4) {
        const len = new DataView(buf.buffer, buf.byteOffset + offset, 4).getUint32(0, false);
        if (len > max) {
          buf = new Uint8Array(0);
          throw new Error(`frame_too_large: ${len} > ${max}`);
        }
        if (buf.length - offset - 4 < len) break;
        frames.push(buf.slice(offset + 4, offset + 4 + len));
        offset += 4 + len;
      }
      if (offset > 0) buf = buf.slice(offset);
      return frames;
    },
  };
}

export type Envelope = { type: string; data?: unknown };

export const Sig = {
  SessionRequest: 'session_request',
  SessionGranted: 'session_granted',
  SessionDenied: 'session_denied',
  Offer: 'offer',
  Answer: 'answer',
  IceCandidate: 'ice_candidate',
  SessionClose: 'session_close',
} as const;
