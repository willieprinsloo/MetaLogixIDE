/**
 * Wire codec shared by the P2P signaling client and RPC layer.
 *
 * Framing matches MetaConnect's `mr-core` crate: a 4-byte big-endian u32
 * length prefix followed by that many payload bytes.
 */

export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024; // 1 MiB

export function encodeFrame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, 4);
  return out;
}

export function createFrameDecoder(opts: { maxFrameBytes?: number } = {}): {
  push(chunk: Uint8Array): Uint8Array[];
} {
  const max = opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  let buf = new Uint8Array(0);

  return {
    push(chunk: Uint8Array): Uint8Array[] {
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

/** Holds a sensitive value. Redacted in String(), template literals and JSON.stringify. */
export class Secret<T> {
  readonly #value: T;
  constructor(value: T) {
    this.#value = value;
  }
  reveal(): T {
    return this.#value;
  }
  toJSON(): '<redacted>' {
    return '<redacted>';
  }
  toString(): '<redacted>' {
    return '<redacted>';
  }
}

/**
 * Frame 1 on every relay connection (mrsignald `mrserver.Hello`). NOT an Envelope: a bare JSON object.
 * `host` + no code/secret -> relay mints a code and answers with `assign_code`; `host` + code/secret ->
 * relay verifies and reuses it; `viewer` -> anonymous, no credential. `token` is the legacy/admin path (unused by metaIDE).
 */
export type Hello = { token: string; role: 'host' | 'viewer'; code?: string; secret?: string };

/** Hello with every credential blanked; the only form that may reach logs or the audit trail. */
export function redactHello(h: Hello): Hello {
  return { ...h, token: h.token ? '<redacted>' : '', ...(h.secret ? { secret: '<redacted>' } : {}) };
}

export type Envelope<T = unknown> = { type: string; data?: T };

export const SignalingTypes = {
  Register: 'register',
  SessionRequest: 'session_request',
  SessionInvite: 'session_invite',
  SessionGranted: 'session_granted',
  SessionDenied: 'session_denied',
  Offer: 'offer',
  Answer: 'answer',
  IceCandidate: 'ice_candidate',
  SessionClose: 'session_close',
  AssignCode: 'assign_code',
} as const;

export type SignalingType = (typeof SignalingTypes)[keyof typeof SignalingTypes];
