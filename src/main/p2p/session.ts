/**
 * Signaling session FSM. Pure logic: no timers, no I/O, no emitters.
 * Inputs arrive via method calls; outputs are returned as `Effect[]` for the
 * caller (Task 9 lifecycle) to route to the signaling client / WebRTC transport.
 *
 * Mirrors mr-core's `SignalingSession`:
 *   Host:   idle -> registered -> serving (session_invite) -> connecting (answer) -> connected
 *   Viewer: idle -> requesting -> granted (session_granted) -> connecting (local answer) -> connected
 *   Any:    -> closed (terminal; also entered on denial, bad token, or close())
 *
 * NOTE on `token`: in `SessionGranted.data` / `SessionInvite.data` the token is
 * a structured `{ iat, exp }` (ms since epoch), NOT the opaque string used on
 * MetaConnect's Go wire. This is a deliberate deviation for the IDE path so the
 * FSM can check timestamps directly. Task 9 parses the wire token into this
 * shape before calling `onInbound`.
 *
 * Clock skew: `iat` more than `sessionTokenSkewMs` (default 5 min) in the
 * future -> `clock_skew`; `exp` more than that in the past -> `token_expired`.
 *
 * Fail-closed choices:
 *  - session_denied and token rejection land in the terminal `closed` state.
 *  - session-scoped messages (offer/answer/ice/close) naming an unknown session,
 *    or a role-invalid message (host Offer, viewer Answer), are silently dropped
 *    (`[]`); hostile peers are guarded upstream and a rogue message must not
 *    tear down a good session.
 */
import { SignalingTypes } from '../../shared/signaling-wire';
import type { Envelope } from '../../shared/signaling-wire';

export type Role = 'host' | 'viewer';

/**
 * `local_*` kinds mean "deliver to the local transport"; `payload` carries the
 * REMOTE peer's data (SDP or candidate).
 */
export type Effect =
  | { kind: 'send'; env: Envelope }
  | { kind: 'local_offer' | 'local_answer' | 'local_candidate'; sessionId: string; payload: string }
  | { kind: 'media_connected'; sessionId: string }
  | { kind: 'session_closed'; sessionId: string; reason: string };

export type SessionState =
  | 'idle'
  | 'registered'
  | 'requesting'
  | 'serving'
  | 'granted'
  | 'connecting'
  | 'connected'
  | 'closed';

export interface SessionToken {
  iat: number;
  exp: number;
}

export interface SignalingSessionOptions {
  role: Role;
  code?: string;
  nowMs?: () => number;
  sessionTokenSkewMs?: number;
  /** Host only: advertised on Register. Monitors is always empty for the IDE (no displays). */
  capabilities?: HostCapabilities;
}

export interface HostCapabilities {
  agentVersion: string;
  hostFingerprint: string;
  monitors: unknown[];
}

const DEFAULT_SKEW_MS = 5 * 60 * 1000;

interface SessionData {
  session?: string;
  token?: SessionToken;
  sdp?: string;
  candidate?: string;
  reason?: string;
}

export class SignalingSession {
  readonly #role: Role;
  readonly #code: string | undefined;
  readonly #nowMs: () => number;
  readonly #skewMs: number;
  readonly #capabilities: HostCapabilities;
  #state: SessionState = 'idle';
  #sessionId = '';

  constructor(opts: SignalingSessionOptions) {
    if (opts.role === 'viewer' && !opts.code) throw new Error('viewer requires a code');
    this.#role = opts.role;
    this.#code = opts.code;
    this.#nowMs = opts.nowMs ?? (() => Date.now());
    this.#skewMs = opts.sessionTokenSkewMs ?? DEFAULT_SKEW_MS;
    this.#capabilities = opts.capabilities ?? { agentVersion: '', hostFingerprint: '', monitors: [] };
  }

  get state(): SessionState {
    return this.#state;
  }

  start(): Effect[] {
    if (this.#state !== 'idle') return [];
    if (this.#role === 'host') {
      this.#state = 'registered';
      return [{ kind: 'send', env: { type: SignalingTypes.Register, data: { ...this.#capabilities } } }];
    }
    this.#state = 'requesting';
    return [{ kind: 'send', env: { type: SignalingTypes.SessionRequest, data: { code: this.#code } } }];
  }

  onInbound(env: Envelope): Effect[] {
    if (this.#state === 'closed') return [];
    const d = (env.data ?? {}) as SessionData;
    switch (env.type) {
      case SignalingTypes.SessionInvite:
        return this.#role === 'host' && this.#state === 'registered' ? this.#accept(d, 'serving') : [];
      case SignalingTypes.SessionGranted:
        return this.#role === 'viewer' && this.#state === 'requesting' ? this.#accept(d, 'granted') : [];
      case SignalingTypes.SessionDenied:
        if (this.#role !== 'viewer' || this.#state !== 'requesting') return [];
        this.#state = 'closed';
        return [{ kind: 'session_closed', sessionId: '', reason: d.reason ?? 'denied' }];
      case SignalingTypes.Offer:
        if (this.#role === 'host' || !this.#matches(d.session)) return [];
        return this.#state === 'granted' ? [{ kind: 'local_offer', sessionId: this.#sessionId, payload: d.sdp ?? '' }] : [];
      case SignalingTypes.Answer:
        if (this.#role === 'viewer' || !this.#matches(d.session)) return [];
        if (this.#state !== 'serving') return [];
        this.#state = 'connecting';
        return [{ kind: 'local_answer', sessionId: this.#sessionId, payload: d.sdp ?? '' }];
      case SignalingTypes.IceCandidate:
        if (!this.#matches(d.session)) return [];
        if (this.#state === 'registered' || this.#state === 'requesting') return [];
        return [{ kind: 'local_candidate', sessionId: this.#sessionId, payload: d.candidate ?? '' }];
      case SignalingTypes.SessionClose:
        if (!this.#matches(d.session)) return [];
        return this.#terminate(d.reason ?? 'peer_closed', false);
      default:
        return [];
    }
  }

  onLocalDescription(sdp: string, kind: 'offer' | 'answer'): Effect[] {
    if ((kind === 'offer') !== (this.#role === 'host')) {
      throw new Error(`role_mismatch: ${this.#role} cannot produce a local ${kind}`);
    }
    if (this.#role === 'host') {
      if (this.#state !== 'serving') return [];
      return [{ kind: 'send', env: { type: SignalingTypes.Offer, data: { session: this.#sessionId, sdp } } }];
    }
    if (this.#state !== 'granted') return [];
    this.#state = 'connecting';
    return [{ kind: 'send', env: { type: SignalingTypes.Answer, data: { session: this.#sessionId, sdp } } }];
  }

  onLocalCandidate(cand: string): Effect[] {
    if (!this.#sessionId || this.#state === 'closed') return [];
    return [{ kind: 'send', env: { type: SignalingTypes.IceCandidate, data: { session: this.#sessionId, candidate: cand } } }];
  }

  onMediaConnected(): Effect[] {
    if (this.#state !== 'connecting') return [];
    this.#state = 'connected';
    return [{ kind: 'media_connected', sessionId: this.#sessionId }];
  }

  close(reason: string): Effect[] {
    return this.#terminate(reason, true);
  }

  #terminate(reason: string, sendClose: boolean): Effect[] {
    if (this.#state === 'closed') return [];
    this.#state = 'closed';
    const out: Effect[] = [];
    if (sendClose && this.#sessionId) {
      out.push({ kind: 'send', env: { type: SignalingTypes.SessionClose, data: { session: this.#sessionId, reason } } });
    }
    out.push({ kind: 'session_closed', sessionId: this.#sessionId, reason });
    return out;
  }

  #accept(d: SessionData, next: 'serving' | 'granted'): Effect[] {
    this.#sessionId = d.session ?? '';
    const bad = this.#checkToken(d.token);
    if (bad || !this.#sessionId) return this.#terminate(bad ?? 'invalid_session', true);
    this.#state = next;
    return [];
  }

  #checkToken(t: SessionToken | undefined): string | null {
    if (!t || !Number.isFinite(t.iat) || !Number.isFinite(t.exp)) return 'invalid_token';
    const now = this.#nowMs();
    if (t.iat > now + this.#skewMs) return 'clock_skew';
    if (t.exp < now - this.#skewMs) return 'token_expired';
    return null;
  }

  #matches(session: string | undefined): boolean {
    return !!this.#sessionId && session === this.#sessionId;
  }

}
