/**
 * One outbound session to a desktop, as an anonymous relay viewer (see the header of
 * src/main/p2p/index.ts for the protocol):
 *
 *   TCP relay -> Hello{viewer} -> session_request{code} -> session_granted -> offer/answer/ICE
 *   -> data channel open -> Noise XX (initiator) -> pairing name swap, or the RPC channel.
 *
 * Platform pieces (TCP socket, RTCPeerConnection) are injected so this runs under Node in tests.
 */
import { utf8Decode, utf8Encode } from './bytes';
import { canonicalPubHex, pairingPrologue, viewerHandshake, type DeviceKey, type RawTransport } from './noise';
import { RpcClient } from './rpc';
import { SecureChannel } from './secure';
import { createFrameDecoder, encodeFrame, Sig, type Envelope } from './wire';

/** A connected-or-connecting byte socket to the relay. */
export interface RelaySocket {
  write(bytes: Uint8Array): void;
  close(): void;
  onOpen(cb: () => void): void;
  onData(cb: (bytes: Uint8Array) => void): void;
  /** Fires once, for errors and normal closes alike. */
  onClose(cb: () => void): void;
}

export type IceServer = { urls: string | string[]; username?: string; credential?: string };

/** The answering end of a WebRTC data channel. Events as RawTransport, plus 'open' and 'candidate' (JSON string). */
export interface Peer extends RawTransport {
  /** Applies the host's offer and returns the local answer SDP. */
  answer(offerSdp: string): Promise<string>;
  addCandidate(candidateJson: string): Promise<void>;
  on(ev: 'message', cb: (m: Uint8Array) => void): unknown;
  on(ev: 'close' | 'open', cb: () => void): unknown;
  on(ev: 'candidate', cb: (candidateJson: string) => void): unknown;
}

export interface Platform {
  connect(host: string, port: number): RelaySocket;
  createPeer(iceServers: IceServer[]): Peer;
}

export interface LinkOpts {
  platform: Platform;
  relay: { host: string; port: number };
  /** The target desktop's connect code. */
  code: string;
  deviceKey: DeviceKey;
  /** How long relay + ICE negotiation may take before giving up. */
  timeoutMs?: number;
}

export type PairResult = { deviceId: string; name: string; code: string };
export type Connection = {
  deviceId: string;
  rpc: RpcClient;
  close(): void;
  /** Why the desktop ended the session (`untrusted_device`, `revoked`, ...), once it has said so. */
  remoteReason(): string | null;
};

const CONNECT_CODE_RE = /^[A-Za-z0-9-]{4,32}$/;
const NEGOTIATION_TIMEOUT_MS = 30_000;
const PAIR_EXCHANGE_TIMEOUT_MS = 5_000;

/** Runs signalling up to an open data channel. Rejects with a short reason code (`relay_unreachable`, `denied`, ...). */
function openChannel(o: LinkOpts): Promise<{ peer: Peer; sessionId: string; closeSignalling(reason: string): void; remoteReason(): string | null }> {
  return new Promise((resolve, reject) => {
    const sock = o.platform.connect(o.relay.host, o.relay.port);
    const decoder = createFrameDecoder();
    let peer: Peer | null = null;
    let sessionId = '';
    let settled = false;
    let sockOpen = false;
    let remoteSet = false;
    let remoteReason: string | null = null;
    const earlyCandidates: string[] = [];

    const send = (env: Envelope) => { if (sockOpen) sock.write(encodeFrame(utf8Encode(JSON.stringify(env)))); };
    const closeSignalling = (reason: string) => {
      if (sessionId) send({ type: Sig.SessionClose, data: { session: sessionId, reason } });
      sockOpen = false;
      sock.close();
    };
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { peer?.close(); } catch { /* already closed */ }
      closeSignalling(reason);
      reject(new Error(reason));
    };
    const timer = setTimeout(() => fail(sockOpen ? 'negotiation_timeout' : 'relay_unreachable'), o.timeoutMs ?? NEGOTIATION_TIMEOUT_MS);

    sock.onOpen(() => {
      sockOpen = true;
      // Frame 1 is a bare Hello, not an envelope. Viewers are anonymous and get no reply.
      sock.write(encodeFrame(utf8Encode(JSON.stringify({ token: '', role: 'viewer' }))));
      send({ type: Sig.SessionRequest, data: { code: o.code.trim() } });
    });
    sock.onClose(() => {
      sockOpen = false;
      // After the data channel is up the relay is no longer needed.
      fail('relay_unreachable');
    });
    sock.onData((chunk) => {
      let frames: Uint8Array[];
      try { frames = decoder.push(chunk); } catch { fail('relay_protocol_error'); return; }
      for (const f of frames) {
        let env: Envelope;
        try { env = JSON.parse(utf8Decode(f)) as Envelope; } catch { continue; }
        if (env && typeof env.type === 'string') onEnvelope(env);
      }
    });

    const onEnvelope = (env: Envelope) => {
      const d = (env.data ?? {}) as { session?: unknown; sdp?: unknown; candidate?: unknown; reason?: unknown; ice_servers?: unknown; iceServers?: unknown };
      if (env.type === Sig.SessionDenied && !sessionId) { fail(typeof d.reason === 'string' && d.reason ? d.reason : 'denied'); return; }
      if (env.type === Sig.SessionGranted && !sessionId) {
        if (typeof d.session !== 'string' || !d.session) { fail('invalid_session'); return; }
        sessionId = d.session;
        const ice = Array.isArray(d.ice_servers) ? d.ice_servers : Array.isArray(d.iceServers) ? d.iceServers : [];
        const p = (peer = o.platform.createPeer(ice as IceServer[]));
        p.on('candidate', (c: string) => send({ type: Sig.IceCandidate, data: { session: sessionId, candidate: c } }));
        p.on('open', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ peer: p, sessionId, closeSignalling, remoteReason: () => remoteReason });
        });
        p.on('close', () => fail('transport_closed'));
        return;
      }
      if (!sessionId || d.session !== sessionId || !peer) return;
      const p = peer;
      switch (env.type) {
        case Sig.Offer:
          if (remoteSet || typeof d.sdp !== 'string') return;
          p.answer(d.sdp).then((sdp) => {
            remoteSet = true;
            send({ type: Sig.Answer, data: { session: sessionId, sdp } });
            for (const c of earlyCandidates.splice(0)) p.addCandidate(c).catch(() => {});
          }, () => fail('negotiation_failed'));
          break;
        case Sig.IceCandidate:
          if (typeof d.candidate !== 'string' || !d.candidate) return;
          if (!remoteSet) earlyCandidates.push(d.candidate);
          else p.addCandidate(d.candidate).catch(() => { /* late or duplicate candidates are harmless */ });
          break;
        case Sig.SessionClose:
          remoteReason = typeof d.reason === 'string' && d.reason ? d.reason : 'peer_closed';
          fail(remoteReason);
          break;
      }
    };
  });
}

const reasonOf = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  return m.startsWith('handshake_failed') ? 'handshake_failed' : (m.split(':')[0] ?? m);
};

/**
 * Pairs with the desktop that currently shows `code` under "Pair a new machine". Both sides swap
 * `{hello: name, code?}`; the phone sends no code because it never hosts.
 */
export async function pairWith(o: LinkOpts & { deviceName: string }): Promise<PairResult> {
  const { peer, sessionId, closeSignalling } = await openChannel(o);
  try {
    const noise = await viewerHandshake({ transport: peer, localKey: o.deviceKey, prologue: pairingPrologue(o.code, sessionId) });
    const secure = new SecureChannel(peer, noise); // synchronous after the await: see viewerHandshake
    const deviceId = canonicalPubHex(noise.remotePub);
    const hello = await new Promise<{ name: string; code?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('pairing_exchange_timeout')), PAIR_EXCHANGE_TIMEOUT_MS);
      secure.on('close', () => { clearTimeout(timer); reject(new Error('transport_closed')); });
      secure.on('message', (m: Uint8Array) => {
        clearTimeout(timer);
        let name = '';
        let code: string | undefined;
        try {
          const j = JSON.parse(utf8Decode(m)) as { hello?: unknown; code?: unknown };
          name = String(j.hello ?? '');
          if (typeof j.code === 'string' && CONNECT_CODE_RE.test(j.code)) code = j.code;
        } catch { /* fall back to the id */ }
        resolve({ name: name.slice(0, 80) || deviceId.slice(0, 8), code });
      });
      secure.start();
      secure.send(utf8Encode(JSON.stringify({ hello: o.deviceName })));
    });
    return { deviceId, name: hello.name, code: hello.code ?? o.code.trim() };
  } catch (e) {
    throw new Error(reasonOf(e));
  } finally {
    try { peer.close(); } catch { /* already closed */ }
    closeSignalling('paired');
  }
}

/** Opens the RPC channel to an already-paired desktop. `expectedDevice` is its canonical device id. */
export async function connect(o: LinkOpts & { expectedDevice: string }): Promise<Connection> {
  const { peer, closeSignalling, remoteReason } = await openChannel(o);
  try {
    const noise = await viewerHandshake({ transport: peer, localKey: o.deviceKey, expectedRemote: o.expectedDevice });
    const secure = new SecureChannel(peer, noise); // synchronous after the await: see viewerHandshake
    const rpc = new RpcClient(secure);
    // The relay connection exists only for this link: drop it whichever side ends the channel.
    secure.on('close', () => closeSignalling('closed'));
    secure.start();
    return { deviceId: o.expectedDevice, rpc, close: () => rpc.close(), remoteReason };
  } catch (e) {
    try { peer.close(); } catch { /* already closed */ }
    closeSignalling(reasonOf(e));
    throw new Error(reasonOf(e));
  }
}
