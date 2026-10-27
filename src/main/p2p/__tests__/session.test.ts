import { describe, expect, test } from 'vitest';
import { SignalingSession } from '../session';
import { SignalingTypes } from '../../../shared/signaling-wire';

const NOW = 1_700_000_000_000;
const MIN = 60 * 1000;
const goodToken = { iat: NOW - 1000, exp: NOW + 10 * MIN };

const granted = (token: { iat: number; exp: number } = goodToken) => ({
  type: SignalingTypes.SessionGranted,
  data: { session: 's1', host: 'tower', hostFingerprint: 'f', iceServers: [], token },
});
const invite = (session = 's1', token: { iat: number; exp: number } = goodToken) => ({
  type: SignalingTypes.SessionInvite,
  data: { session, operator: 'op', requiresKey: false, iceServers: [], token },
});

describe('SignalingSession host', () => {
  test('Register matches mrsignald RegisterHost: nested snake_case capabilities, no code/secret without an identity', () => {
    const s = new SignalingSession({
      role: 'host',
      nowMs: () => NOW,
      capabilities: { agentVersion: '1.2.3', hostFingerprint: 'a b c d e f', monitors: [] },
    });
    expect(s.start()).toEqual([
      { kind: 'send', env: { type: SignalingTypes.Register, data: { capabilities: { agent_version: '1.2.3', host_fingerprint: 'a b c d e f', monitors: [] } } } },
    ]);
  });

  test('Register echoes the persisted code+secret when an identity is supplied', () => {
    const s = new SignalingSession({
      role: 'host',
      nowMs: () => NOW,
      identity: { code: '123456789', secret: 'sek' },
      capabilities: { agentVersion: '1', hostFingerprint: 'f', monitors: [] },
    });
    expect(s.start()).toEqual([
      { kind: 'send', env: { type: SignalingTypes.Register, data: { capabilities: { agent_version: '1', host_fingerprint: 'f', monitors: [] }, code: '123456789', secret: 'sek' } } },
    ]);
  });

  test('viewer session_request carries only the target code', () => {
    const s = new SignalingSession({ role: 'viewer', code: '123456789', nowMs: () => NOW });
    expect(s.start()).toEqual([{ kind: 'send', env: { type: SignalingTypes.SessionRequest, data: { code: '123456789' } } }]);
  });

  test('happy path through media_connected', () => {
    const s = new SignalingSession({ role: 'host', nowMs: () => NOW });
    expect(s.state).toBe('idle');
    expect(s.start()).toEqual([
      expect.objectContaining({ kind: 'send', env: expect.objectContaining({ type: SignalingTypes.Register }) }),
    ]);
    expect(s.state).toBe('registered');
    expect(s.onInbound(invite())).toEqual([]);
    expect(s.state).toBe('serving');
    const off = s.onLocalDescription('o-sdp', 'offer');
    expect(off).toEqual([{ kind: 'send', env: { type: SignalingTypes.Offer, data: { session: 's1', sdp: 'o-sdp' } } }]);
    const ans = s.onInbound({ type: SignalingTypes.Answer, data: { session: 's1', sdp: 'a-sdp' } });
    expect(ans).toEqual([{ kind: 'local_answer', sessionId: 's1', payload: 'a-sdp' }]);
    expect(s.state).toBe('connecting');
    expect(s.onLocalCandidate('cand1')).toEqual([
      { kind: 'send', env: { type: SignalingTypes.IceCandidate, data: { session: 's1', candidate: 'cand1' } } },
    ]);
    expect(s.onInbound({ type: SignalingTypes.IceCandidate, data: { session: 's1', candidate: 'rc' } })).toEqual([
      { kind: 'local_candidate', sessionId: 's1', payload: 'rc' },
    ]);
    expect(s.onMediaConnected()).toEqual([{ kind: 'media_connected', sessionId: 's1' }]);
    expect(s.state).toBe('connected');
  });

  test('duplicate session_invite is ignored', () => {
    const s = new SignalingSession({ role: 'host', nowMs: () => NOW });
    s.start();
    s.onInbound(invite());
    expect(s.onInbound(invite('s2'))).toEqual([]);
    expect(s.onLocalDescription('x', 'offer')[0]).toMatchObject({ env: { data: { session: 's1' } } });
  });

  test('offer for unknown session is silently dropped', () => {
    const s = new SignalingSession({ role: 'host', nowMs: () => NOW });
    s.start();
    const eff = s.onInbound({ type: SignalingTypes.Offer, data: { session: 'zzz', sdp: 'x' } });
    expect(eff).toEqual([]);
  });

  test('expired invite token rejected', () => {
    const s = new SignalingSession({ role: 'host', nowMs: () => NOW });
    s.start();
    const eff = s.onInbound(invite('s1', { iat: NOW - 20 * MIN, exp: NOW - 6 * MIN }));
    expect(eff).toContainEqual(expect.objectContaining({ kind: 'session_closed', reason: 'token_expired' }));
    expect(s.state).toBe('closed');
  });

  test('host answer via onLocalDescription throws role_mismatch', () => {
    const s = new SignalingSession({ role: 'host', nowMs: () => NOW });
    s.start();
    s.onInbound(invite());
    expect(() => s.onLocalDescription('x', 'answer')).toThrow(/role_mismatch/);
  });

  test('close before offer is clean and idempotent', () => {
    const s = new SignalingSession({ role: 'host', nowMs: () => NOW });
    s.start();
    expect(s.close('bye')).toEqual([{ kind: 'session_closed', sessionId: '', reason: 'bye' }]);
    expect(s.close('bye')).toEqual([]);
  });

  test('close is idempotent after session established', () => {
    const s = new SignalingSession({ role: 'host', nowMs: () => NOW });
    s.start();
    s.onInbound(invite());
    expect(s.close('done')).toEqual([
      { kind: 'send', env: { type: SignalingTypes.SessionClose, data: { session: 's1', reason: 'done' } } },
      { kind: 'session_closed', sessionId: 's1', reason: 'done' },
    ]);
    expect(s.state).toBe('closed');
    expect(s.close('done')).toEqual([]);
  });
});

describe('SignalingSession viewer', () => {
  test('happy path through media_connected', () => {
    const s = new SignalingSession({ role: 'viewer', code: 'abc', nowMs: () => NOW });
    expect(s.start()).toEqual([{ kind: 'send', env: { type: SignalingTypes.SessionRequest, data: { code: 'abc' } } }]);
    expect(s.state).toBe('requesting');
    expect(s.onInbound(granted())).toEqual([]);
    expect(s.state).toBe('granted');
    // duplicate grant ignored
    expect(s.onInbound(granted())).toEqual([]);
    expect(s.onInbound({ type: SignalingTypes.Offer, data: { session: 's1', sdp: 'o' } })).toEqual([
      { kind: 'local_offer', sessionId: 's1', payload: 'o' },
    ]);
    expect(s.onLocalDescription('a', 'answer')).toEqual([
      { kind: 'send', env: { type: SignalingTypes.Answer, data: { session: 's1', sdp: 'a' } } },
    ]);
    expect(s.state).toBe('connecting');
    expect(s.onMediaConnected()).toEqual([{ kind: 'media_connected', sessionId: 's1' }]);
    expect(s.state).toBe('connected');
  });

  test('viewer requires a code', () => {
    expect(() => new SignalingSession({ role: 'viewer' })).toThrow();
  });

  test('session_denied closes', () => {
    const s = new SignalingSession({ role: 'viewer', code: 'abc', nowMs: () => NOW });
    s.start();
    const eff = s.onInbound({ type: SignalingTypes.SessionDenied, data: { host: 'h', reason: 'nope' } });
    expect(eff).toEqual([{ kind: 'session_closed', sessionId: '', reason: 'nope' }]);
    expect(s.state).toBe('closed');
    expect(s.close('x')).toEqual([]);
  });

  test('viewer offer via onLocalDescription throws role_mismatch', () => {
    const s = new SignalingSession({ role: 'viewer', code: 'abc', nowMs: () => NOW });
    s.start();
    s.onInbound(granted());
    expect(() => s.onLocalDescription('x', 'offer')).toThrow(/role_mismatch/);
  });

  test('accepts a session token issued ±5 min from now', () => {
    const now = 1_700_000_000_000;
    const s = new SignalingSession({ role: 'viewer', code: 't', nowMs: () => now });
    s.start();
    const effects = s.onInbound({
      type: SignalingTypes.SessionGranted,
      data: {
        session: 's1',
        host: 'tower',
        hostFingerprint: 'f',
        iceServers: [],
        token: { iat: now - 5 * 60 * 1000, exp: now + 60 * 1000 },
      },
    });
    expect(effects.some((e) => e.kind === 'session_closed')).toBe(false);
  });

  test('rejects a session token issued more than 5 min in the future', () => {
    const now = 1_700_000_000_000;
    const s = new SignalingSession({ role: 'viewer', code: 't', nowMs: () => now });
    s.start();
    const effects = s.onInbound({
      type: SignalingTypes.SessionGranted,
      data: {
        session: 's1',
        host: 'tower',
        hostFingerprint: 'f',
        iceServers: [],
        token: { iat: now + 6 * 60 * 1000, exp: now + 10 * 60 * 1000 },
      },
    });
    expect(effects).toContainEqual(expect.objectContaining({ kind: 'session_closed', reason: 'clock_skew' }));
  });

  test('exactly +5 min iat is accepted (boundary)', () => {
    const s = new SignalingSession({ role: 'viewer', code: 't', nowMs: () => NOW });
    s.start();
    const eff = s.onInbound(granted({ iat: NOW + 5 * MIN, exp: NOW + 10 * MIN }));
    expect(eff.some((e) => e.kind === 'session_closed')).toBe(false);
  });
});

describe('fix round 1: silent drops', () => {
  const hostConnecting = () => {
    const s = new SignalingSession({ role: 'host', nowMs: () => NOW });
    s.start();
    s.onInbound(invite());
    s.onInbound({ type: SignalingTypes.Answer, data: { session: 's1', sdp: 'a' } });
    return s;
  };
  const viewerConnecting = () => {
    const s = new SignalingSession({ role: 'viewer', code: 'c', nowMs: () => NOW });
    s.start();
    s.onInbound(granted());
    s.onLocalDescription('a', 'answer');
    return s;
  };

  test('host in connecting ignores Offer for its own session', () => {
    const s = hostConnecting();
    expect(s.onInbound({ type: SignalingTypes.Offer, data: { session: 's1', sdp: 'x' } })).toEqual([]);
    expect(s.state).toBe('connecting');
  });

  test('viewer in connecting ignores Answer for its own session', () => {
    const s = viewerConnecting();
    expect(s.onInbound({ type: SignalingTypes.Answer, data: { session: 's1', sdp: 'x' } })).toEqual([]);
    expect(s.state).toBe('connecting');
  });

  test('SessionClose for an unknown session is dropped', () => {
    const s = hostConnecting();
    expect(s.onInbound({ type: SignalingTypes.SessionClose, data: { session: 'nope', reason: 'r' } })).toEqual([]);
    expect(s.state).toBe('connecting');
  });

  test('viewer receiving Offer while still requesting returns []', () => {
    const s = new SignalingSession({ role: 'viewer', code: 'c', nowMs: () => NOW });
    s.start();
    expect(s.onInbound({ type: SignalingTypes.Offer, data: { session: 's1', sdp: 'x' } })).toEqual([]);
    expect(s.state).toBe('requesting');
  });

  test('session_denied outside requesting is ignored', () => {
    const s = new SignalingSession({ role: 'viewer', code: 'c', nowMs: () => NOW });
    s.start();
    s.onInbound(granted());
    expect(s.onInbound({ type: SignalingTypes.SessionDenied, data: { host: 'h', reason: 'late' } })).toEqual([]);
    expect(s.state).toBe('granted');
  });

  test('host invite with iat > +5 min rejects with clock_skew', () => {
    const s = new SignalingSession({ role: 'host', nowMs: () => NOW });
    s.start();
    const eff = s.onInbound(invite('s1', { iat: NOW + 6 * MIN, exp: NOW + 10 * MIN }));
    expect(eff).toContainEqual(expect.objectContaining({ kind: 'session_closed', reason: 'clock_skew' }));
    expect(s.state).toBe('closed');
  });
});

describe('fix round 1: non-finite token numerics', () => {
  const closedWith = (token: unknown) => {
    const s = new SignalingSession({ role: 'viewer', code: 'c', nowMs: () => NOW });
    s.start();
    const eff = s.onInbound({
      type: SignalingTypes.SessionGranted,
      data: { session: 's1', host: 'h', hostFingerprint: 'f', iceServers: [], token },
    });
    expect(s.state).toBe('closed');
    return eff;
  };

  test('NaN iat/exp -> invalid_token', () => {
    expect(closedWith({ iat: NaN, exp: NaN })).toContainEqual(
      expect.objectContaining({ kind: 'session_closed', reason: 'invalid_token' }),
    );
  });

  test('Infinity iat -> invalid_token', () => {
    expect(closedWith({ iat: Infinity, exp: 0 })).toContainEqual(
      expect.objectContaining({ kind: 'session_closed', reason: 'invalid_token' }),
    );
  });

  test('missing token -> invalid_token', () => {
    expect(closedWith(undefined)).toContainEqual(
      expect.objectContaining({ kind: 'session_closed', reason: 'invalid_token' }),
    );
  });
});
