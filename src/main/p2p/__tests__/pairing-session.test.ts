import { describe, expect, test } from 'vitest';
import { PairingSession } from '../pairing-session';
import { enrollmentPrologue, normalizeEnrollmentCode } from '../pairing';

describe('normalizeEnrollmentCode / prologue', () => {
  test('NFKC + trim + collapse whitespace + lowercase', () => {
    expect(normalizeEnrollmentCode('  Able　BAKER   charlie ')).toBe('able baker charlie');
    expect(normalizeEnrollmentCode('ＡＢ')).toBe('ab'); // full-width AB
    expect(Buffer.from(enrollmentPrologue(' A  b '))).toEqual(Buffer.from('a b'));
  });
});

describe('PairingSession', () => {
  test('happy path then single-use', () => {
    const p = new PairingSession();
    const { code } = p.generate();
    expect(p.redeem(code.toUpperCase())).toEqual({ ok: true });
    expect(p.redeem(code)).toEqual({ ok: false, error: 'code_consumed' });
    expect(p.active).toBe(false);
  });

  test('wrong codes count; the 6th attempt fails even with the right code', () => {
    const p = new PairingSession();
    const { code } = p.generate();
    for (let i = 0; i < 5; i++) expect(p.redeem('nope')).toEqual({ ok: false, error: 'wrong_code' });
    expect(p.redeem(code)).toEqual({ ok: false, error: 'attempts_exceeded' });
  });

  test('a successful redemption before the limit still works', () => {
    const p = new PairingSession();
    const { code } = p.generate();
    for (let i = 0; i < 4; i++) p.redeem('nope');
    expect(p.redeem(code)).toEqual({ ok: true });
  });

  test('expires after the TTL', () => {
    let now = 1000;
    const p = new PairingSession({ now: () => now });
    const { code, expiresAt } = p.generate();
    now = expiresAt;
    expect(p.redeem(code)).toEqual({ ok: false, error: 'code_expired' });
  });

  test('no code issued', () => {
    expect(new PairingSession().redeem('x')).toEqual({ ok: false, error: 'no_active_code' });
    expect(new PairingSession().begin()).toEqual({ ok: false, error: 'no_active_code' });
  });

  test('generate() replaces the code and resets state', () => {
    const p = new PairingSession();
    const a = p.generate();
    p.redeem(a.code);
    const b = p.generate();
    expect(p.redeem(a.code)).toEqual({ ok: false, error: 'wrong_code' });
    expect(p.redeem(b.code)).toEqual({ ok: true });
  });

  test('handshake path: begin/settle shares the budget and permits one in flight', () => {
    const p = new PairingSession({ maxAttempts: 2 });
    p.generate();
    const b1 = p.begin();
    expect(b1.ok).toBe(true);
    expect(p.begin()).toEqual({ ok: false, error: 'busy' });
    p.settle(false);
    p.begin();
    p.settle(false);
    expect(p.begin()).toEqual({ ok: false, error: 'attempts_exceeded' });
  });

  test('handshake success consumes the code', () => {
    const p = new PairingSession();
    p.generate();
    p.begin();
    p.settle(true);
    expect(p.begin()).toEqual({ ok: false, error: 'code_consumed' });
  });
});
