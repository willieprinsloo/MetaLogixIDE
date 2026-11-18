/**
 * One outbound session to a desktop, as an anonymous relay viewer (see the header of
 * src/main/p2p/index.ts for the protocol):
 *
 *   TCP relay -> Hello{viewer} -> session_request{code} -> session_granted -> offer/answer/ICE
 *   -> data channel open -> Noise XX (initiator) -> pairing name swap, or the RPC channel.
 *
 * Every resource (relay socket, peer connection) belongs to the caller's Scope: closing the scope is
 * how a link is ended.
 */
import { Deferred, Effect, Schema, type Scope } from 'effect';
import { utf8Decode, utf8Encode } from './bytes';
import { LinkError } from './errors';
import { canonicalPubHex, pairingPrologue, viewerHandshake, type DeviceKey } from './noise';
import { RpcClient } from './rpc';
import { ConnectCode, Envelope, IceServer, PairHello } from './schemas';
import { SecureChannel } from './secure';
import { Peers, Relay, type Peer } from './services';
import { createFrameDecoder, encodeFrame, Sig } from './wire';

export interface LinkOpts {
  relay: { host: string; port: number };
  /** The target desktop's connect code. */
  code: string;
  deviceKey: DeviceKey;
  /** How long relay + ICE negotiation may take before giving up, in milliseconds. */
  timeoutMs?: number;
}

export type PairResult = { deviceId: string; name: string; code: string };

export interface Connection {
  readonly deviceId: string;
  readonly rpc: RpcClient;
  /**
   * Why the desktop is ending the session (`untrusted_device`, `revoked`, ...), once it has said so over the
   * relay. That usually lands just after the channel itself closes, so callers wait on it briefly.
   */
  readonly remoteReason: Effect.Effect<string>;
}

interface Channel {
  readonly peer: Peer;
  readonly sessionId: string;
  readonly remoteReason: Effect.Effect<string>;
}

const NEGOTIATION_TIMEOUT_MS = 30_000;
const PAIR_EXCHANGE_TIMEOUT = '5 seconds';

const decodeEnvelope = Schema.decodeUnknownOption(Envelope);
const decodeIce = Schema.decodeUnknownOption(Schema.Array(IceServer));
const decodeHello = Schema.decodeUnknownOption(PairHello);
const isConnectCode = Schema.is(ConnectCode);

/** The relay keeps one session per host and closes the older one for the next viewer: bookkeeping, not a hang-up. */
const isSuperseded = (reason: string): boolean => /^superseded\b/i.test(reason);

/**
 * Runs signalling up to an open data channel. Fails with a short reason (`relay_unreachable`,
 * `host offline`, `negotiation_timeout`, ...). The socket stays open for the scope's lifetime: trickle
 * ICE continues over it, and it is how the host says why it hangs up.
 */
const openChannel = Effect.fnUntraced(function*(o: LinkOpts): Effect.fn.Return<Channel, LinkError, Relay | Peers | Scope.Scope> {
  const relay = yield* Relay;
  const peers = yield* Peers;
  const reason = yield* Deferred.make<string>();
  // Shared between the negotiation callbacks and the finalizer below.
  const st = { sockOpen: false, sessionId: '', peer: null as Peer | null };

  const sock = yield* Effect.acquireRelease(
    Effect.sync(() => relay.connect(o.relay.host, o.relay.port)),
    (s) => Effect.sync(() => {
      // Tell the host this session is over, then drop the relay connection that existed only for it.
      if (st.sockOpen && st.sessionId) s.write(encodeFrame(utf8Encode(JSON.stringify({ type: Sig.SessionClose, data: { session: st.sessionId, reason: 'closed' } }))));
      st.sockOpen = false;
      s.close();
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => { try { st.peer?.close(); } catch { /* already closed */ } }));

  const send = (env: { type: string; data?: unknown }) => { if (st.sockOpen) sock.write(encodeFrame(utf8Encode(JSON.stringify(env)))); };

  const peer = yield* Effect.callback<Peer, LinkError>((resume) => {
    const decoder = createFrameDecoder();
    let settled = false;
    let remoteSet = false;
    const earlyCandidates: string[] = [];

    const fail = (r: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resume(Effect.fail(new LinkError({ reason: r })));
    };
    const timer = setTimeout(() => fail(st.sockOpen ? 'negotiation_timeout' : 'relay_unreachable'), o.timeoutMs ?? NEGOTIATION_TIMEOUT_MS);

    sock.onOpen(() => {
      st.sockOpen = true;
      // Frame 1 is a bare Hello, not an envelope. Viewers are anonymous and get no reply.
      sock.write(encodeFrame(utf8Encode(JSON.stringify({ token: '', role: 'viewer' }))));
      send({ type: Sig.SessionRequest, data: { code: o.code.trim() } });
    });
    sock.onClose(() => {
      st.sockOpen = false;
      fail('relay_unreachable'); // after the data channel is up the relay is no longer needed
    });
    sock.onData((chunk) => {
      let frames: Uint8Array[];
      try { frames = decoder.push(chunk); } catch { fail('relay_protocol_error'); return; }
      for (const f of frames) {
        let json: unknown;
        try { json = JSON.parse(utf8Decode(f)); } catch { continue; }
        const env = decodeEnvelope(json);
        if (env._tag === 'Some') onEnvelope(env.value);
      }
    });

    const onEnvelope = (env: Envelope) => {
      const d = env.data ?? {};
      if (env.type === Sig.SessionDenied && !st.sessionId) { fail(d.reason || 'denied'); return; }
      if (env.type === Sig.SessionGranted && !st.sessionId) {
        if (!d.session) { fail('invalid_session'); return; }
        st.sessionId = d.session;
        const ice = decodeIce(d.ice_servers ?? d.iceServers ?? []);
        const p = (st.peer = peers.create(ice._tag === 'Some' ? ice.value : []));
        p.on('candidate', (c: string) => send({ type: Sig.IceCandidate, data: { session: st.sessionId, candidate: c } }));
        p.on('open', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resume(Effect.succeed(p));
        });
        p.on('close', () => fail('transport_closed'));
        return;
      }
      const p = st.peer;
      if (!st.sessionId || d.session !== st.sessionId || !p) return;
      switch (env.type) {
        case Sig.Offer:
          if (remoteSet || d.sdp === undefined) return;
          p.answer(d.sdp).then((sdp) => {
            remoteSet = true;
            send({ type: Sig.Answer, data: { session: st.sessionId, sdp } });
            for (const c of earlyCandidates.splice(0)) p.addCandidate(c).catch(() => {});
          }, () => fail('negotiation_failed'));
          break;
        case Sig.IceCandidate:
          if (!d.candidate) return;
          if (!remoteSet) earlyCandidates.push(d.candidate);
          else p.addCandidate(d.candidate).catch(() => { /* late or duplicate candidates are harmless */ });
          break;
        case Sig.SessionClose: {
          const r = d.reason || 'peer_closed';
          if (!settled) { fail(r); break; }
          // The channel is up. A supersede is the relay's bookkeeping and the link carries on; any other
          // reason is the host saying why it is about to close the channel.
          if (!isSuperseded(r)) Deferred.doneUnsafe(reason, Effect.succeed(r));
          break;
        }
      }
    };
    return Effect.sync(() => { settled = true; clearTimeout(timer); });
  });

  return { peer, sessionId: st.sessionId, remoteReason: Deferred.await(reason) };
});

/**
 * Pairs with the desktop that currently shows `code` under "Pair a new machine". Both sides swap
 * `{hello: name, code?}`; the phone sends no code because it never hosts, and `viewer: true` so the
 * desktop keeps it out of its fleet views.
 */
export const pairWith = Effect.fnUntraced(function*(o: LinkOpts & { deviceName: string }): Effect.fn.Return<PairResult, LinkError, Relay | Peers> {
  return yield* Effect.gen(function*() {
    const { peer, sessionId } = yield* openChannel(o);
    const noise = yield* viewerHandshake({ transport: peer, localKey: o.deviceKey, prologue: pairingPrologue(o.code, sessionId) });
    const secure = new SecureChannel(peer, noise); // synchronous after the handshake: see viewerHandshake
    const deviceId = canonicalPubHex(noise.remotePub);
    const hello = yield* Effect.callback<{ name: string; code?: string }, LinkError>((resume) => {
      secure.on('close', () => resume(Effect.fail(new LinkError({ reason: 'transport_closed' }))));
      secure.on('message', (m: Uint8Array) => {
        let json: unknown = null;
        try { json = JSON.parse(utf8Decode(m)); } catch { /* fall back to the id */ }
        const h = decodeHello(json);
        const name = (h._tag === 'Some' ? h.value.hello ?? '' : '').slice(0, 80) || deviceId.slice(0, 8);
        const code = h._tag === 'Some' && isConnectCode(h.value.code) ? h.value.code : undefined;
        resume(Effect.succeed({ name, code }));
      });
      secure.start();
      secure.send(utf8Encode(JSON.stringify({ hello: o.deviceName, viewer: true })));
    }).pipe(
      Effect.timeoutOrElse({ duration: PAIR_EXCHANGE_TIMEOUT, orElse: () => Effect.fail(new LinkError({ reason: 'pairing_exchange_timeout' })) }),
    );
    return { deviceId, name: hello.name, code: hello.code ?? o.code.trim() };
  }).pipe(Effect.scoped);
});

/**
 * Opens the RPC channel to an already-paired desktop for the lifetime of the scope. `expectedDevice` is
 * its canonical device id; a host with any other identity is refused before ours is revealed.
 */
export const connect = Effect.fnUntraced(function*(o: LinkOpts & { expectedDevice: string }): Effect.fn.Return<Connection, LinkError, Relay | Peers | Scope.Scope> {
  const { peer, remoteReason } = yield* openChannel(o);
  const noise = yield* viewerHandshake({ transport: peer, localKey: o.deviceKey, expectedRemote: o.expectedDevice });
  const secure = new SecureChannel(peer, noise); // synchronous after the handshake: see viewerHandshake
  const rpc = new RpcClient(secure);
  yield* Effect.addFinalizer(() => Effect.sync(() => rpc.close()));
  secure.start();
  return { deviceId: o.expectedDevice, rpc, remoteReason };
});
