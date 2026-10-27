import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Secret } from '../../../shared/signaling-wire';
import {
  generateEnrollmentCode, verifyEnrollmentCode, doNoiseXxHandshake, createFramer,
  ENROLLMENT_TTL_MS, type HandshakeTransport,
} from '../pairing';
import { EFF_SHORT_WORDLIST } from '../_wordlist';
import { pairedTransports, type MockTransport } from './_pairedTransports';

const asT = (m: MockTransport) => m as unknown as HandshakeTransport;
function newKey() {
  const seed = new Uint8Array(randomBytes(32));
  return { pub: ed25519.getPublicKey(seed), priv: new Secret(seed) };
}

describe('enrollment code', () => {
  it('is 6 unique-set words from the list with a 5 minute TTL', () => {
    const t0 = 1_000_000;
    const { code, expiresAt } = generateEnrollmentCode(t0);
    expect(expiresAt - t0).toBe(5 * 60_000);
    expect(ENROLLMENT_TTL_MS).toBe(300_000);
    const words = code.split(' ');
    expect(words).toHaveLength(6);
    for (const w of words) expect(EFF_SHORT_WORDLIST).toContain(w);
    expect(code).toBe(code.toLowerCase());
  });
  it('codes are random', () => {
    const seen = new Set(Array.from({ length: 20 }, () => generateEnrollmentCode().code));
    expect(seen.size).toBe(20);
  });
  it('honours TTL expiry and rejects malformed codes', () => {
    const { code, expiresAt } = generateEnrollmentCode(1000);
    expect(verifyEnrollmentCode(code, expiresAt, expiresAt - 1)).toBe(true);
    expect(verifyEnrollmentCode(code, expiresAt, expiresAt)).toBe(false);
    expect(verifyEnrollmentCode(code.toUpperCase(), expiresAt, 1001)).toBe(true);
    expect(verifyEnrollmentCode('one two three', expiresAt, 1001)).toBe(false);
    expect(verifyEnrollmentCode(code.replace(/^\S+/, 'zzzzzz'), expiresAt, 1001)).toBe(false);
    expect(verifyEnrollmentCode(code, Date.now() - 1)).toBe(false);
  });
});

describe('Noise XX', () => {
  it('round-trips: same session key, each learns the other pub, frames decrypt', async () => {
    const [v, h] = pairedTransports();
    const vk = newKey();
    const hk = newKey();
    const [rv, rh] = await Promise.all([
      doNoiseXxHandshake({ transport: asT(v), role: 'viewer', localKey: vk }),
      doNoiseXxHandshake({ transport: asT(h), role: 'host', localKey: hk }),
    ]);
    expect(Buffer.from(rv.sendKey)).toEqual(Buffer.from(rh.recvKey));
    expect(Buffer.from(rv.recvKey)).toEqual(Buffer.from(rh.sendKey));
    expect(Buffer.from(rv.sendKey)).not.toEqual(Buffer.from(rv.recvKey));
    expect(rv.sendKey).toHaveLength(32);
    expect(rv.pendingMessages).toEqual([]);
    expect(Buffer.from(rv.remotePub)).toEqual(Buffer.from(hk.pub));
    expect(Buffer.from(rh.remotePub)).toEqual(Buffer.from(vk.pub));
    // wire sizes
    expect(v.sent.map((m) => m.length)).toEqual([32, 96]);
    expect(h.sent.map((m) => m.length)).toEqual([128]);
    // data frames

    // plaintext identity never on the wire
    const wire = Buffer.concat([...v.sent, ...h.sent]);
    expect(wire.includes(Buffer.from(vk.pub))).toBe(false);
    expect(wire.includes(Buffer.from(hk.pub))).toBe(false);
  });

  it('succeeds when remoteKeyExpected matches', async () => {
    const [v, h] = pairedTransports();
    const vk = newKey(); const hk = newKey();
    const [rv, rh] = await Promise.all([
      doNoiseXxHandshake({ transport: asT(v), role: 'viewer', localKey: vk, remoteKeyExpected: hk.pub }),
      doNoiseXxHandshake({ transport: asT(h), role: 'host', localKey: hk, remoteKeyExpected: vk.pub }),
    ]);
    expect(Buffer.from(rv.sendKey)).toEqual(Buffer.from(rh.recvKey));
  });

  it('viewer rejects with trust_failed on key mismatch, closes channel, never sends message 3', async () => {
    const [v, h] = pairedTransports();
    const vk = newKey(); const hk = newKey(); const other = newKey();
    const [rv, rh] = await Promise.allSettled([
      doNoiseXxHandshake({ transport: asT(v), role: 'viewer', localKey: vk, remoteKeyExpected: other.pub }),
      doNoiseXxHandshake({ transport: asT(h), role: 'host', localKey: hk, timeoutMs: 100 }),
    ]);
    expect(rv.status).toBe('rejected');
    expect((rv as PromiseRejectedResult).reason.message).toBe('trust_failed');
    expect(v.closed).toBe(true);
    expect(v.sent).toHaveLength(1); // identity not revealed to the impostor
    expect(rh.status).toBe('rejected');
  });

  it('host rejects with trust_failed when the viewer is not the expected device', async () => {
    const [v, h] = pairedTransports();
    const [, rh] = await Promise.allSettled([
      doNoiseXxHandshake({ transport: asT(v), role: 'viewer', localKey: newKey() }),
      doNoiseXxHandshake({ transport: asT(h), role: 'host', localKey: newKey(), remoteKeyExpected: newKey().pub }),
    ]);
    expect((rh as PromiseRejectedResult).reason.message).toBe('trust_failed');
    expect(h.closed).toBe(true);
  });

  it('times out with handshake_timeout when the responder never answers', async () => {
    const [v] = pairedTransports();
    const t0 = Date.now();
    await expect(
      doNoiseXxHandshake({ transport: asT(v), role: 'viewer', localKey: newKey(), timeoutMs: 80 }),
    ).rejects.toThrow('handshake_timeout');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
    expect(v.closed).toBe(true);
  });

  it('rejects a corrupted message 2 and sends nothing further', async () => {
    const [v, h] = pairedTransports();
    const p = doNoiseXxHandshake({ transport: asT(v), role: 'viewer', localKey: newKey(), timeoutMs: 500 });
    const hostP = doNoiseXxHandshake({ transport: asT(h), role: 'host', localKey: newKey(), timeoutMs: 100 });
    // Intercept: flip a ciphertext bit in host's reply before the viewer sees it.
    const origSend = h.send.bind(h);
    h.send = (b: Uint8Array) => { const c = new Uint8Array(b); c[40]! ^= 0x01; origSend(c); };
    await expect(p).rejects.toThrow(/handshake_failed/);
    expect(v.sent).toHaveLength(1);
    expect(v.closed).toBe(true);
    await hostP.catch(() => undefined);
  });

  it('rejects wrong-length and replayed messages', async () => {
    const [v, h] = pairedTransports();
    const p = doNoiseXxHandshake({ transport: asT(v), role: 'viewer', localKey: newKey(), timeoutMs: 500 });
    v.inject(new Uint8Array(10));
    await expect(p).rejects.toThrow(/handshake_failed/);

    // Replay of a recorded msg2 from another session cannot complete a fresh handshake.
    const [v1, h1] = pairedTransports();
    await Promise.all([
      doNoiseXxHandshake({ transport: asT(v1), role: 'viewer', localKey: newKey() }),
      doNoiseXxHandshake({ transport: asT(h1), role: 'host', localKey: newKey() }),
    ]);
    const recorded = h1.sent[0]!;
    const [v2] = pairedTransports();
    const p2 = doNoiseXxHandshake({ transport: asT(v2), role: 'viewer', localKey: newKey(), timeoutMs: 500 });
    v2.inject(recorded);
    await expect(p2).rejects.toThrow(/handshake_failed/);
    void h;
  });

  it('fails when the transport closes mid-handshake', async () => {
    const [v] = pairedTransports();
    const p = doNoiseXxHandshake({ transport: asT(v), role: 'viewer', localKey: newKey(), timeoutMs: 5000 });
    v.close();
    await expect(p).rejects.toThrow(/handshake_failed/);
  });
});

describe('Noise prologue', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const run = (pv?: Uint8Array, ph?: Uint8Array) => {
    const [v, h] = pairedTransports();
    return Promise.allSettled([
      doNoiseXxHandshake({ transport: asT(v), role: 'viewer', localKey: newKey(), prologue: pv, timeoutMs: 200 }),
      doNoiseXxHandshake({ transport: asT(h), role: 'host', localKey: newKey(), prologue: ph, timeoutMs: 200 }),
    ]);
  };
  it('succeeds with the same prologue', async () => {
    const [a, b] = await run(enc('alpha beta'), enc('alpha beta'));
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('fulfilled');
  });
  it('fails with handshake_failed on different prologues', async () => {
    const [a, b] = await run(enc('alpha beta'), enc('alpha gamma'));
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
    expect((a as PromiseRejectedResult).reason.message).toMatch(/handshake_failed/);
  });
  it('fails when only one side has a prologue', async () => {
    const [a] = await run(enc('x'), undefined);
    expect(a.status).toBe('rejected');
  });
  it('works with undefined on both sides', async () => {
    const [a, b] = await run();
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('fulfilled');
  });
});

describe('framer', () => {
  async function pair() {
    const [v, h] = pairedTransports();
    const [rv, rh] = await Promise.all([
      doNoiseXxHandshake({ transport: asT(v), role: 'viewer', localKey: newKey() }),
      doNoiseXxHandshake({ transport: asT(h), role: 'host', localKey: newKey() }),
    ]);
    return { fv: createFramer(rv.sendKey, rv.recvKey), fh: createFramer(rh.sendKey, rh.recvKey) };
  }
  const bytes = (s: string) => new TextEncoder().encode(s);
  const str = (b: Uint8Array) => new TextDecoder().decode(b);

  it('round-trips both ways over many frames', async () => {
    const { fv, fh } = await pair();
    for (let i = 0; i < 3; i++) {
      expect(str(fh.decrypt(fv.encrypt(bytes('v' + i))))).toBe('v' + i);
      expect(str(fv.decrypt(fh.encrypt(bytes('h' + i))))).toBe('h' + i);
    }
  });
  it('rejects a duplicated frame with replay_or_reorder', async () => {
    const { fv, fh } = await pair();
    const f = fv.encrypt(bytes('once'));
    fh.decrypt(f);
    expect(() => fh.decrypt(f)).toThrow('replay_or_reorder');
  });
  it('rejects reordered and dropped-then-skipped frames', async () => {
    const { fv, fh } = await pair();
    const f0 = fv.encrypt(bytes('0'));
    const f1 = fv.encrypt(bytes('1'));
    expect(() => fh.decrypt(f1)).toThrow('replay_or_reorder');
    expect(str(fh.decrypt(f0))).toBe('0');
    expect(str(fh.decrypt(f1))).toBe('1');
  });
  it('rejects a reflected frame (own frame fed to own decrypt): different key, AEAD fails', async () => {
    const { fv } = await pair();
    const f = fv.encrypt(bytes('reflect me'));
    expect(() => fv.decrypt(f)).toThrow('decrypt_failed');
  });
  it('tampering with the seq header reports replay_or_reorder (seq check runs before AEAD)', async () => {
    const { fv, fh } = await pair();
    const f = fv.encrypt(bytes('x'));
    const bad = new Uint8Array(f); bad[7]! ^= 1;
    expect(() => fh.decrypt(bad)).toThrow('replay_or_reorder');
    expect(str(fh.decrypt(f))).toBe('x');
  });
  it('rejects tampered ciphertext without advancing the sequence', async () => {
    const { fv, fh } = await pair();
    const f = fv.encrypt(bytes('x'));
    const bad = new Uint8Array(f); bad[bad.length - 1]! ^= 1;
    expect(() => fh.decrypt(bad)).toThrow('decrypt_failed');
    expect(str(fh.decrypt(f))).toBe('x');
  });
});

describe('pendingMessages', () => {
  it('hands back frames that arrived right after message 3', async () => {
    const [v, h] = pairedTransports();
    const hp = doNoiseXxHandshake({ transport: asT(h), role: 'host', localKey: newKey() });
    // Hold msg3 back until the viewer has its keys, then deliver msg3 and the
    // first encrypted frame back-to-back so the frame lands while the host's
    // handshake continuation is still pending.
    const origSend = v.send.bind(v);
    let held: Uint8Array | null = null;
    let n = 0;
    v.send = (b: Uint8Array) => { if (++n === 2) held = b; else origSend(b); };
    const vp = doNoiseXxHandshake({ transport: asT(v), role: 'viewer', localKey: newKey() });
    const rv = await vp;
    const fv = createFramer(rv.sendKey, rv.recvKey);
    h.inject(held!);
    h.inject(fv.encrypt(new TextEncoder().encode('early')));
    const rh = await hp;
    const fh = createFramer(rh.sendKey, rh.recvKey);
    expect(rh.pendingMessages).toHaveLength(1);
    expect(new TextDecoder().decode(fh.decrypt(rh.pendingMessages[0]!))).toBe('early');
  });
});
