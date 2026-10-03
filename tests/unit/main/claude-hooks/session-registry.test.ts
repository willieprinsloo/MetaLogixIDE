import { describe, it, expect } from 'vitest';
import { SessionRegistry } from '@main/claude-hooks/session-registry';

const A = { projectId: 1, shellIndex: 0 };
const B = { projectId: 2, shellIndex: 3 };

describe('SessionRegistry', () => {
  it('issues a UUID id and a 32-byte base64url token', () => {
    const { id, token } = new SessionRegistry().issue(A);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('issues fresh values on every call', () => {
    const reg = new SessionRegistry();
    const one = reg.issue(A);
    const two = reg.issue(B);
    expect(two.id).not.toBe(one.id);
    expect(two.token).not.toBe(one.token);
  });

  it('verify returns the shell for the matching id and token', () => {
    const reg = new SessionRegistry();
    const s = reg.issue(B);
    expect(reg.verify(s.id, s.token)).toEqual(B);
  });

  it.each([
    ['a wrong token of the same length', (t: string) => `${t.slice(0, -1)}${t.endsWith('A') ? 'B' : 'A'}`],
    ['a shorter token', (t: string) => t.slice(0, 10)],
    ['an empty token', () => ''],
    ['a longer token', (t: string) => `${t}x`],
    ['the token with non-alphabet characters inserted', (t: string) => `${t.slice(0, 5)}!*${t.slice(5)}`],
    ['the token with trailing base64 padding', (t: string) => `${t}=`],
  ])('verify rejects %s (AC24)', (_label, mutate) => {
    const reg = new SessionRegistry();
    const s = reg.issue(A);
    expect(reg.verify(s.id, mutate(s.token))).toBeNull();
  });

  it('verify rejects an unknown id', () => {
    const reg = new SessionRegistry();
    const s = reg.issue(A);
    expect(reg.verify('00000000-0000-4000-8000-000000000000', s.token)).toBeNull();
  });

  it("a secret only authenticates the shell it was issued to (AC24)", () => {
    const reg = new SessionRegistry();
    const a = reg.issue(A);
    const b = reg.issue(B);
    expect(reg.verify(a.id, b.token)).toBeNull();
    expect(reg.verify(b.id, a.token)).toBeNull();
  });

  it('release invalidates the shell session (AC26)', () => {
    const reg = new SessionRegistry();
    const s = reg.issue(A);
    reg.release(A);
    expect(reg.verify(s.id, s.token)).toBeNull();
  });

  it('release leaves other shells intact', () => {
    const reg = new SessionRegistry();
    reg.issue(A);
    const b = reg.issue(B);
    reg.release(A);
    expect(reg.verify(b.id, b.token)).toEqual(B);
  });

  it('re-issuing for the same shell replaces the previous session', () => {
    const reg = new SessionRegistry();
    const old = reg.issue(A);
    const fresh = reg.issue(A);
    expect(reg.verify(old.id, old.token)).toBeNull();
    expect(reg.verify(fresh.id, fresh.token)).toEqual(A);
  });

  it('a shell is unconfirmed until confirm is called for its session', () => {
    const reg = new SessionRegistry();
    const s = reg.issue(A);
    expect(reg.isConfirmed(A)).toBe(false);
    expect(reg.confirm(s.id)).toBe(true);
    expect(reg.isConfirmed(A)).toBe(true);
    expect(reg.isConfirmed(B)).toBe(false);
  });

  it('confirm returns false for an unknown or released session', () => {
    const reg = new SessionRegistry();
    expect(reg.confirm('nope')).toBe(false);
    const s = reg.issue(A);
    reg.release(A);
    expect(reg.confirm(s.id)).toBe(false);
    expect(reg.isConfirmed(A)).toBe(false);
  });

  it('a respawned shell starts unconfirmed', () => {
    const reg = new SessionRegistry();
    reg.confirm(reg.issue(A).id);
    reg.release(A);
    reg.issue(A);
    expect(reg.isConfirmed(A)).toBe(false);
  });
  it('currentId is null for a shell that was never issued a session', () => {
    expect(new SessionRegistry().currentId(A)).toBeNull();
  });

  it('currentId returns the issued id, per shell', () => {
    const reg = new SessionRegistry();
    const a = reg.issue(A);
    const b = reg.issue(B);
    expect(reg.currentId(A)).toBe(a.id);
    expect(reg.currentId(B)).toBe(b.id);
  });

  it('currentId is null after release, and other shells keep theirs', () => {
    const reg = new SessionRegistry();
    reg.issue(A);
    const b = reg.issue(B);
    reg.release(A);
    expect(reg.currentId(A)).toBeNull();
    expect(reg.currentId(B)).toBe(b.id);
  });

  it('currentId follows a re-issue to the new id', () => {
    const reg = new SessionRegistry();
    const old = reg.issue(A);
    const fresh = reg.issue(A);
    expect(reg.currentId(A)).toBe(fresh.id);
    expect(reg.currentId(A)).not.toBe(old.id);
  });
});
