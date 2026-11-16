/**
 * Viewer (initiator) half of the desktop's Noise_XX_25519_ChaChaPoly_SHA256 handshake and its
 * per-frame AEAD. Byte-for-byte port of src/main/p2p/pairing.ts; the interop test runs this
 * against the desktop responder.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 as sha256Hash } from '@noble/hashes/sha2.js';
import { hmac as hmacHash } from '@noble/hashes/hmac.js';
import { concat, equalBytes, utf8Encode } from './bytes';

const PROTOCOL_NAME = 'Noise_XX_25519_ChaChaPoly_SHA256';
const DH = 32;
const TAG = 16;
const MSG2_LEN = DH + (DH + TAG) + (DH + TAG);
const EMPTY = new Uint8Array(0);

const sha256 = (...parts: Uint8Array[]): Uint8Array => sha256Hash(concat(...parts));
const hmac = (key: Uint8Array, ...parts: Uint8Array[]): Uint8Array => hmacHash(sha256Hash, key, concat(...parts));

function hkdf2(ck: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = hmac(ck, ikm);
  const o1 = hmac(temp, Uint8Array.of(1));
  const o2 = hmac(temp, o1, Uint8Array.of(2));
  return [o1, o2];
}

function dh(priv: Uint8Array, pub: Uint8Array): Uint8Array {
  const out = x25519.getSharedSecret(priv, pub);
  if (out.every((b) => b === 0)) throw new Error('degenerate DH output');
  return out;
}

/** 12-byte nonce: 4 zero bytes then a 64-bit counter. Counters stay below 2^53, so plain numbers are exact. */
function nonce(n: number, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(12);
  const v = new DataView(out.buffer);
  const hi = Math.floor(n / 0x100000000);
  const lo = n >>> 0;
  if (littleEndian) { v.setUint32(4, lo, true); v.setUint32(8, hi, true); }
  else { v.setUint32(4, hi, false); v.setUint32(8, lo, false); }
  return out;
}

class SymmetricState {
  h: Uint8Array;
  ck: Uint8Array;
  k: Uint8Array | null = null;
  n = 0;

  constructor(prologue: Uint8Array) {
    const name = utf8Encode(PROTOCOL_NAME);
    this.h = name.length <= 32 ? concat(name, new Uint8Array(32 - name.length)) : sha256(name);
    this.ck = this.h;
    this.mixHash(prologue);
  }
  mixHash(data: Uint8Array): void { this.h = sha256(this.h, data); }
  mixKey(ikm: Uint8Array): void {
    const [ck, k] = hkdf2(this.ck, ikm);
    this.ck = ck;
    this.k = k;
    this.n = 0;
  }
  encryptAndHash(pt: Uint8Array): Uint8Array {
    let out = pt;
    if (this.k) out = chacha20poly1305(this.k, nonce(this.n++, true), this.h).encrypt(pt);
    this.mixHash(out);
    return out;
  }
  decryptAndHash(ct: Uint8Array): Uint8Array {
    let out = ct;
    if (this.k) out = chacha20poly1305(this.k, nonce(this.n++, true), this.h).decrypt(ct);
    this.mixHash(ct);
    return out;
  }
  split(): [Uint8Array, Uint8Array] { return hkdf2(this.ck, EMPTY); }
}

/** Wire frame = seq(8, big-endian) | ciphertext | tag(16). Nonce = 4 zero bytes | seq. */
export function createFramer(sendKey: Uint8Array, recvKey: Uint8Array): {
  encrypt(bytes: Uint8Array): Uint8Array;
  decrypt(frame: Uint8Array): Uint8Array;
} {
  let sendSeq = 0;
  let recvSeq = 0;
  return {
    encrypt(bytes) {
      const n = nonce(sendSeq++, false);
      const ct = chacha20poly1305(sendKey, n).encrypt(bytes);
      return concat(n.subarray(4), ct);
    },
    decrypt(frame) {
      if (frame.length < 8 + TAG) throw new Error('frame too short');
      const n = nonce(recvSeq, false);
      if (!equalBytes(frame.subarray(0, 8), n.subarray(4))) throw new Error('replay_or_reorder');
      let pt: Uint8Array;
      try {
        pt = chacha20poly1305(recvKey, n).decrypt(frame.subarray(8));
      } catch {
        throw new Error('decrypt_failed');
      }
      recvSeq++;
      return pt;
    },
  };
}

/** Same canonical form the desktop uses for codes typed by a human. */
export function normalizeCode(code: string): string {
  let s = code;
  try { s = s.normalize('NFKC'); } catch { /* engines without Intl: connect codes are ASCII anyway */ }
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** SHA-256("metaide-pair-v1" 0x00 code 0x00 session id): binds a pairing handshake to code + relay session. */
export function pairingPrologue(connectCode: string, sessionId: string): Uint8Array {
  return sha256(utf8Encode('metaide-pair-v1\0'), utf8Encode(normalizeCode(connectCode)), utf8Encode('\0'), utf8Encode(sessionId));
}

export interface RawTransport {
  send(bytes: Uint8Array): void;
  close(): void;
  on(ev: 'message', cb: (m: Uint8Array) => void): unknown;
  on(ev: 'close', cb: () => void): unknown;
  off(ev: 'message', cb: (m: Uint8Array) => void): unknown;
  off(ev: 'close', cb: () => void): unknown;
}

export type NoiseResult = {
  sendKey: Uint8Array;
  recvKey: Uint8Array;
  /** The peer's Ed25519 device key. */
  remotePub: Uint8Array;
  /** Frames that arrived after message 2 but before the caller attached its own listener. Process first. */
  pendingMessages: Uint8Array[];
  /** Stops collecting into `pendingMessages`. Call once your own listener is attached (same tick). */
  release(): void;
};

export type DeviceKey = { seed: Uint8Array; pub: Uint8Array };

export function deviceKeyFromSeed(seed: Uint8Array): DeviceKey {
  if (seed.length !== 32) throw new Error('device key must be 32 bytes');
  return { seed, pub: ed25519.getPublicKey(seed) };
}

/** One canonical hex per device: the X25519 identity ignores the Ed25519 sign bit (see desktop identity.ts). */
export function canonicalPubHex(pub: Uint8Array): string {
  if (pub.length !== 32) throw new Error('invalid device public key');
  const b = new Uint8Array(pub);
  b[31] = b[31]! & 0x7f;
  let s = '';
  for (const x of b) s += (x < 16 ? '0' : '') + x.toString(16);
  return s;
}

/**
 * Runs the initiator side. The caller must build its SecureChannel synchronously in the continuation
 * of this promise so `pendingMessages` and live frames stay in order.
 */
export function viewerHandshake(opts: {
  transport: RawTransport;
  localKey: DeviceKey;
  /** Canonical hex of the device we expect; checked before our identity is revealed. */
  expectedRemote?: string;
  prologue?: Uint8Array;
  timeoutMs?: number;
}): Promise<NoiseResult> {
  const { transport: t, localKey } = opts;
  return new Promise<NoiseResult>((resolve, reject) => {
    const queue: Uint8Array[] = [];
    let done = false;
    let ss: SymmetricState;
    const ePriv = x25519.utils.randomSecretKey();
    const sPriv = ed25519.utils.toMontgomerySecret(localKey.seed);

    const finish = (err: Error | null, res?: NoiseResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      t.off('close', onClose);
      // On success the listener stays attached, buffering, until the caller takes over via release().
      if (err) t.off('message', onMessage);
      ePriv.fill(0);
      sPriv.fill(0);
      if (err) {
        try { t.close(); } catch { /* already closed */ }
        reject(err);
      } else resolve(res!);
    };
    const onClose = () => finish(new Error('handshake_failed: transport closed'));
    const onMessage = (m: Uint8Array) => {
      if (done) { queue.push(new Uint8Array(m)); return; }
      const m2 = new Uint8Array(m);
      try {
        if (m2.length !== MSG2_LEN) throw new Error('handshake_failed: bad message 2 length');
        // <- e, ee, s, es
        const re = m2.subarray(0, DH);
        ss.mixHash(re);
        ss.mixKey(dh(ePriv, re));
        let rs: Uint8Array;
        let remoteEd: Uint8Array;
        try {
          rs = ss.decryptAndHash(m2.subarray(DH, DH + DH + TAG));
          ss.mixKey(dh(ePriv, rs));
          remoteEd = ss.decryptAndHash(m2.subarray(DH + DH + TAG));
        } catch {
          // A wrong pair code changes the prologue, which surfaces here as an AEAD failure.
          throw new Error('handshake_failed');
        }
        if (remoteEd.length !== 32 || !equalBytes(ed25519.utils.toMontgomery(remoteEd), rs)) {
          throw new Error('handshake_failed: identity binding mismatch');
        }
        if (opts.expectedRemote && canonicalPubHex(remoteEd) !== opts.expectedRemote) throw new Error('trust_failed');
        // -> s, se
        const encS = ss.encryptAndHash(x25519.getPublicKey(sPriv));
        ss.mixKey(dh(sPriv, re));
        const encP = ss.encryptAndHash(localKey.pub);
        t.send(concat(encS, encP));
        const [k1, k2] = ss.split();
        finish(null, {
          sendKey: k1, recvKey: k2, remotePub: new Uint8Array(remoteEd), pendingMessages: queue,
          release: () => { t.off('message', onMessage); },
        });
      } catch (e) {
        finish(e instanceof Error && /^(handshake_failed|trust_failed)/.test(e.message) ? e : new Error('handshake_failed'));
      }
    };
    const timer = setTimeout(() => finish(new Error('handshake_timeout')), opts.timeoutMs ?? 10_000);
    t.on('message', onMessage);
    t.on('close', onClose);

    try {
      ss = new SymmetricState(opts.prologue ?? EMPTY);
      // -> e
      const ePub = x25519.getPublicKey(ePriv);
      ss.mixHash(ePub);
      ss.encryptAndHash(EMPTY);
      t.send(ePub);
    } catch {
      finish(new Error('handshake_failed'));
    }
  });
}
