import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import type { Secret } from '../../shared/signaling-wire';
import type { WebRtcTransport } from './transport';
import { EFF_SHORT_WORDLIST } from './_wordlist';

// ---------------------------------------------------------------------------
// Enrollment codes
// ---------------------------------------------------------------------------

export const ENROLLMENT_TTL_MS = 60 * 60_000;
const CODE_WORDS = 6;

export function generateEnrollmentCode(now: number = Date.now()): { code: string; expiresAt: number } {
  const words: string[] = [];
  for (let i = 0; i < CODE_WORDS; i++) words.push(EFF_SHORT_WORDLIST[randomInt(EFF_SHORT_WORDLIST.length)]!);
  return { code: words.join(' '), expiresAt: now + ENROLLMENT_TTL_MS };
}

/**
 * Canonical form of an enrollment code: NFKC, trimmed, whitespace collapsed to single spaces, lowercase.
 * Both sides must derive the Noise prologue from this form so that cosmetic differences (case, extra
 * spaces, full-width characters) in what the human typed cannot break or split the binding.
 */
export function normalizeEnrollmentCode(code: string): string {
  return code.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** UTF-8 bytes of the normalized code: the Noise prologue for pairing handshakes (both roles). */
export function enrollmentPrologue(code: string): Uint8Array {
  return new TextEncoder().encode(normalizeEnrollmentCode(code));
}

/**
 * Noise prologue for a connect-code pairing handshake: SHA-256("metaide-pair-v1" 0x00 code 0x00 nonce).
 * The nonce is the relay-issued session id (both peers receive the same one in invite/granted), so a recorded
 * handshake cannot be replayed against a different session and a relay that swaps in a different host's code
 * produces a prologue mismatch. NOTE: the connect code is also the relay's address for the host, so the relay
 * itself knows it; this binds code+session, it is not a secret shared out-of-band from the relay.
 */
export function pairingPrologue(connectCode: string, nonce: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update('metaide-pair-v1\0').update(normalizeEnrollmentCode(connectCode)).update('\0').update(nonce).digest());
}

/**
 * Format + TTL check only. Matching the code against the one the host issued is
 * the caller's job (compare with a constant-time equality on the normalised string).
 */
export function verifyEnrollmentCode(code: string, expiresAt: number, now: number = Date.now()): boolean {
  if (typeof code !== 'string' || !Number.isFinite(expiresAt) || now >= expiresAt) return false;
  const words = normalizeEnrollmentCode(code).split(' ');
  if (words.length !== CODE_WORDS) return false;
  return words.every((w) => EFF_SHORT_WORDLIST.includes(w));
}

// ---------------------------------------------------------------------------
// Noise_XX_25519_ChaChaPoly_SHA256 over the data channel
//
//   -> e
//   <- e, ee, s, es
//   -> s, se
//
// Static keys are the device's Ed25519 identity converted to X25519. Because an
// X25519 key cannot be mapped back to an Ed25519 key, each side sends its
// Ed25519 public key as the (encrypted) handshake payload of the message that
// carries `s`; the receiver checks toMontgomery(payload) === s. The viewer is
// the initiator, the host the responder.
//
// Wire layout (bytes):
//   msg1 (32)  : e(32)
//   msg2 (128) : e(32) | enc(s)(32+16) | enc(ed25519 pub)(32+16)
//   msg3 (96)  : enc(s)(32+16) | enc(ed25519 pub)(32+16)
// ---------------------------------------------------------------------------

const PROTOCOL_NAME = 'Noise_XX_25519_ChaChaPoly_SHA256';
const DH = 32;
const TAG = 16;
const MSG1_LEN = DH;
const MSG2_LEN = DH + (DH + TAG) + (DH + TAG);
const MSG3_LEN = (DH + TAG) + (DH + TAG);

const EMPTY = new Uint8Array(0);

/**
 * pendingMessages contract: the caller must attach its message listener synchronously
 * after `await doNoiseXxHandshake(...)` and process `pendingMessages` in order, before
 * any newly received frame.
 */
export type NoiseResult = {
  sendKey: Uint8Array;
  recvKey: Uint8Array;
  remotePub: Uint8Array;
  /** Inbound messages that arrived after message 3 but before the listener was detached. Process first. */
  pendingMessages: Uint8Array[];
};
export type HandshakeTransport = Pick<WebRtcTransport, 'send' | 'close' | 'on' | 'off'>;

function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}
function hmac(key: Uint8Array, ...parts: Uint8Array[]): Uint8Array {
  const h = createHmac('sha256', key);
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
/** Noise HKDF with two outputs. */
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

class SymmetricState {
  h: Uint8Array;
  ck: Uint8Array;
  k: Uint8Array | null = null;
  n = 0n;

  constructor(prologue: Uint8Array) {
    const name = new TextEncoder().encode(PROTOCOL_NAME);
    this.h = name.length <= 32 ? concat(name, new Uint8Array(32 - name.length)) : sha256(name);
    this.ck = this.h;
    // Noise prologue: h = HASH(h || prologue). Mixed in before any message; when
    // pairing, callers pass the normalized enrollment code bytes.
    this.mixHash(prologue);
  }
  mixHash(data: Uint8Array): void { this.h = sha256(this.h, data); }
  mixKey(ikm: Uint8Array): void {
    const [ck, k] = hkdf2(this.ck, ikm);
    this.ck = ck;
    this.k = k;
    this.n = 0n;
  }
  #nonce(): Uint8Array {
    const nonce = new Uint8Array(12);
    new DataView(nonce.buffer).setBigUint64(4, this.n, true);
    return nonce;
  }
  encryptAndHash(pt: Uint8Array): Uint8Array {
    let out = pt;
    if (this.k) {
      out = chacha20poly1305(this.k, this.#nonce(), this.h).encrypt(pt);
      this.n++;
    }
    this.mixHash(out);
    return out;
  }
  decryptAndHash(ct: Uint8Array): Uint8Array {
    let out = ct;
    if (this.k) {
      out = chacha20poly1305(this.k, this.#nonce(), this.h).decrypt(ct);
      this.n++;
    }
    this.mixHash(ct);
    return out;
  }
  /** Noise Split(): [initiator->responder key, responder->initiator key]. */
  split(): [Uint8Array, Uint8Array] { return hkdf2(this.ck, EMPTY); }
}

/**
 * Per-direction frame AEAD. Wire frame = seq(8, big-endian) | ciphertext | tag(16).
 * Nonce = 4 zero bytes | seq. Direction is bound by the key (sendKey != recvKey),
 * order by the strictly monotonic sequence. AAD is empty.
 */
export function createFramer(sendKey: Uint8Array, recvKey: Uint8Array): {
  encrypt(bytes: Uint8Array): Uint8Array;
  decrypt(bytes: Uint8Array): Uint8Array;
} {
  let sendSeq = 0n;
  let recvSeq = 0n;
  const MAX = (1n << 64n) - 1n;
  const nonceOf = (seq: bigint): Uint8Array => {
    const n = new Uint8Array(12);
    new DataView(n.buffer).setBigUint64(4, seq, false);
    return n;
  };
  return {
    encrypt(bytes) {
      if (sendSeq > MAX) throw new Error('sequence_exhausted');
      const seq = sendSeq;
      const ct = chacha20poly1305(sendKey, nonceOf(seq)).encrypt(bytes);
      sendSeq++;
      const out = new Uint8Array(8 + ct.length);
      new DataView(out.buffer).setBigUint64(0, seq, false);
      out.set(ct, 8);
      return out;
    },
    decrypt(frame) {
      if (frame.length < 8 + TAG) throw new Error('frame too short');
      if (recvSeq > MAX) throw new Error('sequence_exhausted');
      const seq = new DataView(frame.buffer, frame.byteOffset, 8).getBigUint64(0, false);
      // Error priority: the seq header is checked before AEAD, so a tampered seq
      // reports replay_or_reorder; ciphertext/tag tampering reports decrypt_failed.
      if (seq !== recvSeq) throw new Error('replay_or_reorder');
      let pt: Uint8Array;
      try {
        pt = chacha20poly1305(recvKey, nonceOf(seq)).decrypt(frame.subarray(8));
      } catch {
        throw new Error('decrypt_failed');
      }
      recvSeq++;
      return pt;
    },
  };
}

class HandshakeError extends Error {}

/** Collects inbound messages from the moment of construction so none are missed. */
class Mailbox {
  #queue: Uint8Array[] = [];
  #waiter: { resolve: (m: Uint8Array) => void; reject: (e: Error) => void } | null = null;
  #error: Error | null = null;
  #timer: NodeJS.Timeout;
  readonly #onMessage = (m: Uint8Array) => {
    const copy = new Uint8Array(m);
    if (this.#waiter) { const w = this.#waiter; this.#waiter = null; w.resolve(copy); } else this.#queue.push(copy);
  };
  readonly #onClose = () => this.fail(new HandshakeError('handshake_failed: transport closed'));

  constructor(private readonly t: HandshakeTransport, timeoutMs: number) {
    t.on('message', this.#onMessage);
    t.on('close', this.#onClose);
    this.#timer = setTimeout(() => this.fail(new HandshakeError('handshake_timeout')), timeoutMs);
  }
  fail(e: Error): void {
    if (this.#error) return;
    this.#error = e;
    if (this.#waiter) { const w = this.#waiter; this.#waiter = null; w.reject(e); }
  }
  next(): Promise<Uint8Array> {
    if (this.#error) return Promise.reject(this.#error);
    const m = this.#queue.shift();
    if (m) return Promise.resolve(m);
    return new Promise((resolve, reject) => { this.#waiter = { resolve, reject }; });
  }
  drain(): Uint8Array[] {
    const q = this.#queue;
    this.#queue = [];
    return q;
  }
  dispose(): void {
    clearTimeout(this.#timer);
    this.t.off('message', this.#onMessage);
    this.t.off('close', this.#onClose);
  }
}

/** The Ed25519 pub carried in the payload must be the one `s` was derived from. */
function checkPayload(payload: Uint8Array, rs: Uint8Array): Uint8Array {
  if (payload.length !== 32) throw new HandshakeError('handshake_failed: bad payload');
  if (!equalBytes(ed25519.utils.toMontgomery(payload), rs)) throw new HandshakeError('handshake_failed: identity binding mismatch');
  return payload;
}

export async function doNoiseXxHandshake(opts: {
  transport: HandshakeTransport;
  role: 'host' | 'viewer';
  localKey: { pub: Uint8Array; priv: Secret<Uint8Array> };
  remoteKeyExpected?: Uint8Array;
  /** Mixed into the Noise hash before message 1; both sides must pass identical bytes. */
  prologue?: Uint8Array;
  timeoutMs?: number;
}): Promise<NoiseResult> {
  const { transport, role, localKey, remoteKeyExpected } = opts;
  // Listener is attached synchronously, before any await, so an eager peer cannot beat us.
  const mailbox = new Mailbox(transport, opts.timeoutMs ?? 10_000);
  const edSeed = localKey.priv.reveal();
  const sPriv = ed25519.utils.toMontgomerySecret(edSeed);
  const sPub = x25519.getPublicKey(sPriv);
  let ePriv: Uint8Array | null = null;
  try {
    const ss = new SymmetricState(opts.prologue ?? EMPTY);
    const trust = (remoteEd: Uint8Array): void => {
      if (remoteKeyExpected && !equalBytes(remoteEd, remoteKeyExpected)) throw new HandshakeError('trust_failed');
    };

    if (role === 'viewer') {
      // -> e
      ePriv = x25519.utils.randomSecretKey();
      const ePub = x25519.getPublicKey(ePriv);
      ss.mixHash(ePub);
      ss.encryptAndHash(EMPTY); // empty payload, no key yet
      transport.send(ePub);

      // <- e, ee, s, es
      const m2 = await mailbox.next();
      if (m2.length !== MSG2_LEN) throw new HandshakeError('handshake_failed: bad message 2 length');
      const re = m2.subarray(0, DH);
      ss.mixHash(re);
      ss.mixKey(dh(ePriv, re));
      const rs = ss.decryptAndHash(m2.subarray(DH, DH + DH + TAG));
      ss.mixKey(dh(ePriv, rs));
      const remoteEd = checkPayload(ss.decryptAndHash(m2.subarray(DH + DH + TAG)), rs);
      trust(remoteEd); // before revealing our identity

      // -> s, se
      const encS = ss.encryptAndHash(sPub);
      ss.mixKey(dh(sPriv, re));
      const encP = ss.encryptAndHash(localKey.pub);
      transport.send(concat(encS, encP));
      const [k1, k2] = ss.split();
      return { sendKey: k1, recvKey: k2, remotePub: new Uint8Array(remoteEd), pendingMessages: mailbox.drain() };
    }

    // responder (host)
    const m1 = await mailbox.next();
    if (m1.length !== MSG1_LEN) throw new HandshakeError('handshake_failed: bad message 1 length');
    const re = m1.subarray(0, DH);
    ss.mixHash(re);
    ss.decryptAndHash(EMPTY);

    // <- e, ee, s, es
    ePriv = x25519.utils.randomSecretKey();
    const ePub = x25519.getPublicKey(ePriv);
    ss.mixHash(ePub);
    ss.mixKey(dh(ePriv, re));
    const encS = ss.encryptAndHash(sPub);
    ss.mixKey(dh(sPriv, re));
    const encP = ss.encryptAndHash(localKey.pub);
    transport.send(concat(ePub, encS, encP));

    // -> s, se
    const m3 = await mailbox.next();
    if (m3.length !== MSG3_LEN) throw new HandshakeError('handshake_failed: bad message 3 length');
    const rs = ss.decryptAndHash(m3.subarray(0, DH + TAG));
    ss.mixKey(dh(ePriv, rs));
    const remoteEd = checkPayload(ss.decryptAndHash(m3.subarray(DH + TAG)), rs);
    trust(remoteEd);
    const [k1, k2] = ss.split();
    return { sendKey: k2, recvKey: k1, remotePub: new Uint8Array(remoteEd), pendingMessages: mailbox.drain() };
  } catch (e) {
    // Fail closed: never leave a half-handshaken channel open.
    try { transport.close(); } catch { /* already closed */ }
    if (e instanceof HandshakeError) throw e;
    throw new HandshakeError('handshake_failed');
  } finally {
    mailbox.dispose();
    ePriv?.fill(0);
    sPriv.fill(0);
  }
}
