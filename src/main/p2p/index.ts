import { app } from 'electron';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  RpcMethods,
  type FleetEntry,
  type P2PSettings,
  type P2PSettingsView,
  type RpcMethodName,
} from '../../shared/p2p-contract';
import type { IpcEvents } from '../../shared/ipc-contract';
import { Secret, SignalingTypes, type Envelope } from '../../shared/signaling-wire';
import { runMigrations } from '../db/migrator';
import { emitAliveShellsChanged, emitProjectsChanged } from '../ipc/register';
import type { Services } from '../services';
import { wireHub, setHubServices } from './hub';
import {
  addKnownDevice,
  canonicalPubHex,
  isTrustedDevice,
  loadKnownDevices,
  loadOrCreateDeviceKey,
  removeKnownDevice,
  type DeviceKey,
} from './identity';
import { McClient, type McStatus } from './mcClient';
import { doNoiseXxHandshake, enrollmentPrologue, normalizeEnrollmentCode } from './pairing';
import { PairingSession } from './pairing-session';
import { RpcPeer } from './rpc';
import { SecureTransport } from './secure';
import { SignalingSession, type Effect } from './session';
import { WebRtcTransport } from './transport';
import type { P2PApi, PairRedeemResult } from './types';

/*
 * P2P lifecycle: wires MetaConnect signaling (McClient) -> SignalingSession FSM -> WebRTC transport ->
 * Noise XX -> RpcPeer -> hub (host) / rpcCall (viewer).
 *
 * ---- Host path ----
 *   mc connected -> arm a host slot (SignalingSession.start sends Register + HostCapabilities)
 *   session_invite -> slot is bound to the session id, a fresh slot is armed for the next invite
 *   -> transport opens data channel + offer -> answer -> transport 'open' -> Noise XX (responder)
 *   -> trust check (known_devices) -> RpcPeer + wireHub.
 *
 * ---- Handshake contract (pendingMessages) ----
 * `doNoiseXxHandshake` returns `pendingMessages`: encrypted frames the peer sent after message 3 but
 * before the handshake listener was detached. The caller MUST build its SecureTransport (which attaches
 * the post-handshake 'message' listener) SYNCHRONOUSLY in the continuation of `await doNoiseXxHandshake`
 * (no await in between), and the SecureTransport replays `pendingMessages` in order before any frame
 * received afterwards. See `handshake()` below; do not insert awaits between the two.
 *
 * ---- Assumptions to be confirmed by the MetaConnect integration test (Task 14) ----
 * - Wire token shape: handled by parseSessionToken (object {iat,exp}, or a JWT-like string).
 * - Rendezvous addressing: viewers put the target deviceId (canonical pub hex) in session_request.code;
 *   pairing sessions use pairRendezvous(code), a hash of the code so the relay never sees the secret.
 *   `pairing: true` rides on session_request / session_invite to tell the host to use the code prologue.
 * - Fleet online status needs a relay endpoint; v1 reports online only for devices connected right now.
 */

export const NEGOTIATION_TIMEOUT_MS = 30_000;
const PAIR_EXCHANGE_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;
const DC_LABEL = 'metaide';
/** Must match the message peerEngine emits when it rejects a data channel. */
const CHANNEL_NOT_RELIABLE_MSG = 'data channel must be ordered and reliable';

type EmitFn = <E extends 'p2p:rpc-event'>(channel: E, payload: IpcEvents[E]) => void;

/** The slice of McClient the lifecycle uses; tests supply a double. */
export interface SignalingClient extends EventEmitter {
  readonly status: McStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(env: Envelope): void;
}

export interface StartP2POpts {
  /** Defaults to services.homeDir. */
  homeDir?: string;
  /** Default: contents of ~/.metaide/agent.token. */
  readToken?: () => string | null;
  /** Test seam; default constructs a McClient (TLS to the relay). */
  createClient?: (cfg: { url: string; port: number; token: Secret<string> }) => SignalingClient;
  /** Test seam; default is a WebRtcTransport in a hidden worker window. */
  createTransport?: (role: 'host' | 'viewer', iceServers: RTCIceServer[]) => WebRtcTransport;
  /** Pushes main -> renderer events (`p2p:rpc-event`). */
  emit?: EmitFn;
  auditLogPath?: string;
  appVersion?: string;
  pairingMaxAttempts?: number;
  handshakeTimeoutMs?: number;
  now?: () => number;
}

/** Wire tokens arrive as `{iat,exp}` or as a JWT-like string; anything else is rejected (fail closed). */
export function parseSessionToken(t: unknown): { iat: number; exp: number } | null {
  const norm = (iat: unknown, exp: unknown) => {
    if (typeof iat !== 'number' || typeof exp !== 'number') return null;
    // Seconds-since-epoch values (< 1e12) are scaled to ms.
    const ms = (n: number) => (n < 1e12 ? n * 1000 : n);
    return { iat: ms(iat), exp: ms(exp) };
  };
  if (t && typeof t === 'object') return norm((t as { iat?: unknown }).iat, (t as { exp?: unknown }).exp);
  if (typeof t === 'string') {
    const seg = t.split('.')[1] ?? t.split('.')[0];
    try {
      const j = JSON.parse(Buffer.from(seg ?? '', 'base64url').toString('utf8')) as { iat?: unknown; exp?: unknown };
      return norm(j.iat, j.exp);
    } catch {
      return null;
    }
  }
  return null;
}

/** Relay-visible rendezvous for a pairing session: a hash, so the secret code never leaves the device. */
export function pairRendezvous(code: string): string {
  return 'pair-' + createHash('sha256').update('metaide-pair-rdv\0').update(normalizeEnrollmentCode(code)).digest('hex').slice(0, 32);
}

interface Link {
  role: 'host' | 'viewer';
  session: SignalingSession;
  sessionId: string;
  transport: WebRtcTransport | null;
  pairing: boolean;
  /** Pairing host: the prologue reserved from PairingSession.begin(). */
  prologue?: Uint8Array;
  /** Pairing viewer: the code's prologue. */
  codePrologue?: Uint8Array;
  /** Viewer normal path: device we expect on the other end. */
  expectedDevice?: string;
  remoteDevice?: string;
  rpc?: RpcPeer;
  secure?: SecureTransport;
  handshakeStarted: boolean;
  closed: boolean;
  timer: NodeJS.Timeout | null;
  settle?: (r: { ok: true } | { ok: false; error: string }) => void;
}

interface StreamEntry {
  deviceId: string;
  handle: { close(): void; readonly stream: number | undefined };
}

const reasonOf = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  return m.startsWith('handshake_failed') ? 'handshake_failed' : (m.split(':')[0] ?? m);
};

class P2PRuntime {
  readonly deviceKey: DeviceKey;
  readonly pairing: PairingSession;
  readonly knownPath: string;
  readonly home: string;
  client: SignalingClient | null = null;
  hostSlot: Link | null = null;
  readonly links = new Map<string, Link>();
  readonly viewerWaiting: Link[] = [];
  readonly allLinks = new Set<Link>();
  /** Established viewer connections by canonical device id. */
  readonly conns = new Map<string, { rpc: RpcPeer; link: Link }>();
  readonly connecting = new Map<string, Promise<RpcPeer>>();
  readonly hostLive = new Map<string, Set<Link>>();
  readonly streams = new Map<number, StreamEntry>();
  #streamSeq = 0;
  #stopped = false;

  constructor(readonly services: Services, readonly opts: StartP2POpts) {
    this.home = opts.homeDir ?? services.homeDir;
    this.knownPath = join(this.home, '.metaide', 'known_devices.json');
    this.deviceKey = loadOrCreateDeviceKey(join(this.home, '.metaide', 'device.key'));
    this.pairing = new PairingSession({ maxAttempts: opts.pairingMaxAttempts, now: opts.now });
  }

  // ---- settings ----

  settings(): P2PSettings {
    const r = this.services.db.prepare('SELECT relay_url, relay_port, device_name, serve_enabled FROM p2p_settings WHERE id = 1').get() as
      | { relay_url: string | null; relay_port: number | null; device_name: string | null; serve_enabled: number }
      | undefined;
    return {
      relayUrl: r?.relay_url ?? 'signal.metalogix.solutions',
      relayPort: r?.relay_port ?? 7000,
      deviceName: r?.device_name || hostname(),
      serveEnabled: (r?.serve_enabled ?? 1) === 1,
    };
  }

  async setSettings(patch: Partial<P2PSettings>): Promise<void> {
    const cur = this.settings();
    const next: P2PSettings = { ...cur };
    if (patch.relayUrl !== undefined) {
      if (typeof patch.relayUrl !== 'string' || !patch.relayUrl.trim()) throw new Error('invalid relayUrl');
      next.relayUrl = patch.relayUrl.trim();
    }
    if (patch.relayPort !== undefined) {
      if (!Number.isInteger(patch.relayPort) || patch.relayPort < 1 || patch.relayPort > 65535) throw new Error('invalid relayPort');
      next.relayPort = patch.relayPort;
    }
    if (patch.deviceName !== undefined) next.deviceName = String(patch.deviceName).trim() || hostname();
    if (patch.serveEnabled !== undefined) next.serveEnabled = !!patch.serveEnabled;
    this.services.db
      .prepare('UPDATE p2p_settings SET relay_url = ?, relay_port = ?, device_name = ?, serve_enabled = ? WHERE id = 1')
      .run(next.relayUrl, next.relayPort, next.deviceName, next.serveEnabled ? 1 : 0);
    this.upsertSelf(next.deviceName);
    const relayChanged = next.relayUrl !== cur.relayUrl || next.relayPort !== cur.relayPort;
    if (relayChanged) await this.stopClient();
    if (!next.serveEnabled) {
      this.hostSlot = null;
      if (this.conns.size === 0) await this.stopClient();
    } else if (relayChanged || !this.client) {
      await this.startClientIfServing();
    } else {
      this.armHostSlot();
    }
  }

  view(): P2PSettingsView {
    return { ...this.settings(), deviceFingerprint: this.deviceKey.fingerprint };
  }

  upsertSelf(name: string): void {
    this.services.db
      .prepare(
        `INSERT INTO devices (id, name, last_seen_at, is_self) VALUES (?, ?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_self = 1`,
      )
      .run(canonicalPubHex(this.deviceKey.pub), name, Date.now());
  }

  recordDevice(id: string, name: string): void {
    this.services.db
      .prepare(
        `INSERT INTO devices (id, name, last_seen_at, is_self) VALUES (?, ?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_seen_at = excluded.last_seen_at`,
      )
      .run(id, name, Date.now());
  }

  touchDevice(id: string): void {
    this.services.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
  }

  // ---- signaling client ----

  token(): string | null {
    const read = this.opts.readToken ?? (() => {
      const f = join(this.home, '.metaide', 'agent.token');
      return existsSync(f) ? readFileSync(f, 'utf8').trim() : null;
    });
    const t = read();
    return t ? t : null;
  }

  async startClientIfServing(): Promise<void> {
    if (this.#stopped || !this.settings().serveEnabled) return;
    await this.ensureClient(false);
  }

  /** Creates and starts the signaling client; with `wait`, resolves once it is connected. */
  async ensureClient(wait: boolean): Promise<SignalingClient> {
    if (!this.client) {
      const tok = this.token();
      if (!tok) throw new Error('no_agent_token');
      const s = this.settings();
      const cfg = { url: s.relayUrl, port: s.relayPort, token: new Secret(tok) };
      // TODO(task-14-or-followup): wrap socket in yamux + ctrl stream if MetaConnect integration test shows
      // the relay requires it. The default McClient socket is plain tls.connect(); it may be that the
      // TypeMetaIDE route is registered on a raw-TCP sibling listener, which would avoid yamux entirely.
      const c = this.opts.createClient ? this.opts.createClient(cfg) : new McClient(cfg);
      c.on('error', () => { /* surfaced through status; McClient reconnects on its own */ });
      c.on('envelope', (env: Envelope) => this.onEnvelope(env));
      c.on('status', (st: McStatus) => this.onStatus(st));
      this.client = c;
      await c.start();
    }
    const c = this.client;
    if (wait && c.status !== 'connected') {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => { c.off('status', on); reject(new Error('relay_unreachable')); }, CONNECT_TIMEOUT_MS);
        const on = (st: McStatus) => { if (st === 'connected') { clearTimeout(t); c.off('status', on); resolve(); } };
        c.on('status', on);
      });
    }
    return c;
  }

  async stopClient(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.hostSlot = null;
    if (c) { c.removeAllListeners('envelope'); c.removeAllListeners('status'); await c.stop(); }
  }

  onStatus(st: McStatus): void {
    if (st === 'connected') this.armHostSlot();
    else this.hostSlot = null;
  }

  armHostSlot(): void {
    const c = this.client;
    if (!c || c.status !== 'connected' || this.hostSlot || !this.settings().serveEnabled) return;
    const session = new SignalingSession({
      role: 'host',
      nowMs: this.opts.now,
      capabilities: {
        agentVersion: this.opts.appVersion ?? app.getVersion(),
        hostFingerprint: this.deviceKey.fingerprint,
        monitors: [], // the IDE does not advertise displays
      },
    });
    const link = this.newLink('host', session, false);
    this.hostSlot = link;
    this.run(link, session.start());
  }

  newLink(role: 'host' | 'viewer', session: SignalingSession, pairing: boolean): Link {
    const link: Link = { role, session, sessionId: '', transport: null, pairing, handshakeStarted: false, closed: false, timer: null };
    this.allLinks.add(link);
    return link;
  }

  // ---- inbound signaling ----

  onEnvelope(env: Envelope): void {
    if (this.#stopped) return;
    const d = (env.data ?? {}) as { session?: string; token?: unknown; iceServers?: unknown; pairing?: unknown };
    switch (env.type) {
      case SignalingTypes.SessionInvite: return this.onInvite(env, d);
      case SignalingTypes.SessionGranted: return this.onGranted(env, d);
      case SignalingTypes.SessionDenied: {
        const link = this.viewerWaiting.shift();
        if (link) this.run(link, link.session.onInbound(env));
        return;
      }
      default: {
        const link = d.session ? this.links.get(d.session) : undefined;
        if (link) this.run(link, link.session.onInbound(env));
      }
    }
  }

  #withToken(env: Envelope, d: { token?: unknown }): Envelope | null {
    const token = parseSessionToken(d.token);
    if (!token) return null;
    return { ...env, data: { ...(env.data as object), token } };
  }

  onInvite(env: Envelope, d: { session?: string; iceServers?: unknown; pairing?: unknown; token?: unknown }): void {
    const link = this.hostSlot;
    if (!link || !this.settings().serveEnabled) return;
    const fixed = this.#withToken(env, d);
    if (!fixed) { this.hostSlot = null; this.run(link, link.session.close('invalid_token')); this.armHostSlot(); return; }
    this.run(link, link.session.onInbound(fixed));
    if (link.session.state !== 'serving') { // rejected (clock skew, expiry, ...): FSM already closed it
      if (this.hostSlot === link) this.hostSlot = null;
      this.armHostSlot();
      return;
    }
    link.sessionId = d.session as string;
    this.links.set(link.sessionId, link);
    this.hostSlot = null;
    this.armHostSlot(); // ready for the next invite while this one negotiates

    link.pairing = d.pairing === true;
    if (link.pairing) {
      const b = this.pairing.begin();
      if (!b.ok) { this.run(link, link.session.close(b.error)); return; }
      link.prologue = b.prologue;
    }
    this.startNegotiationTimer(link);
    this.setupTransport(link, Array.isArray(d.iceServers) ? (d.iceServers as RTCIceServer[]) : []);
    void this.hostOffer(link);
  }

  onGranted(env: Envelope, d: { session?: string; iceServers?: unknown; token?: unknown }): void {
    const link = this.viewerWaiting.shift();
    if (!link) return;
    const fixed = this.#withToken(env, d);
    if (!fixed) { this.run(link, link.session.close('invalid_token')); return; }
    this.run(link, link.session.onInbound(fixed));
    if (link.session.state !== 'granted') return;
    link.sessionId = d.session as string;
    this.links.set(link.sessionId, link);
    this.setupTransport(link, Array.isArray(d.iceServers) ? (d.iceServers as RTCIceServer[]) : []);
  }

  startNegotiationTimer(link: Link): void {
    if (link.timer) clearTimeout(link.timer);
    link.timer = setTimeout(() => this.finishLink(link, 'negotiation_timeout'), NEGOTIATION_TIMEOUT_MS);
    link.timer.unref?.();
  }

  setupTransport(link: Link, iceServers: RTCIceServer[]): void {
    const t = this.opts.createTransport ? this.opts.createTransport(link.role, iceServers) : new WebRtcTransport({ role: link.role, iceServers });
    link.transport = t;
    t.on('local-candidate', (c: string) => this.run(link, link.session.onLocalCandidate(c)));
    t.on('open', () => {
      this.run(link, link.session.onMediaConnected());
      void this.onOpen(link);
    });
    t.on('close', () => {
      // Mid-handshake the Noise mailbox observes the close and rejects with the precise reason.
      if (link.handshakeStarted && !link.secure) return;
      this.finishLink(link, 'transport_closed');
    });
    t.on('error', (e: Error) => {
      // The engine rejects unordered/unreliable channels with this error; do not wait for the 30 s negotiation timeout.
      if (e?.message === CHANNEL_NOT_RELIABLE_MSG) this.finishLink(link, 'channel_not_reliable');
      // Other errors: connection state is reported via 'close'.
    });
  }

  async hostOffer(link: Link): Promise<void> {
    try {
      const t = link.transport!;
      // The data channel is created ordered+reliable (peerEngine verifies this).
      await t.openDataChannel(DC_LABEL);
      const sdp = await t.createOffer();
      this.run(link, link.session.onLocalDescription(sdp, 'offer'));
    } catch (e) {
      this.finishLink(link, reasonOf(e));
    }
  }

  async viewerAnswer(link: Link, offerSdp: string): Promise<void> {
    try {
      const sdp = await link.transport!.createAnswer(offerSdp);
      this.run(link, link.session.onLocalDescription(sdp, 'answer'));
    } catch (e) {
      this.finishLink(link, reasonOf(e));
    }
  }

  run(link: Link, effects: Effect[]): void {
    for (const fx of effects) {
      switch (fx.kind) {
        case 'send':
          try { this.client?.send(fx.env); } catch { this.finishLink(link, 'relay_unreachable'); }
          break;
        case 'local_offer': void this.viewerAnswer(link, fx.payload); break;
        case 'local_answer':
          link.transport?.setRemoteDescription(fx.payload).catch((e: unknown) => this.finishLink(link, reasonOf(e)));
          break;
        case 'local_candidate':
          link.transport?.addIceCandidate(fx.payload).catch(() => { /* late/duplicate candidates are harmless */ });
          break;
        case 'media_connected': break;
        case 'session_closed': this.finishLink(link, fx.reason); break;
      }
    }
  }

  // ---- post-ICE: Noise, trust, RPC ----

  async onOpen(link: Link): Promise<void> {
    if (link.handshakeStarted || link.closed) return;
    link.handshakeStarted = true;
    if (link.timer) { clearTimeout(link.timer); link.timer = null; }
    try {
      if (link.role === 'host') await this.hostFlow(link);
      else await this.viewerFlow(link);
    } catch (e) {
      this.finishLink(link, reasonOf(e));
    }
  }

  /** Runs Noise XX and builds the SecureTransport in the same synchronous continuation (see header contract). */
  async handshake(link: Link, role: 'host' | 'viewer', prologue?: Uint8Array): Promise<{ secure: SecureTransport; remote: string }> {
    const t = link.transport!;
    const noise = await doNoiseXxHandshake({
      transport: t,
      role,
      localKey: this.deviceKey,
      prologue,
      timeoutMs: this.opts.handshakeTimeoutMs,
    });
    // SYNCHRONOUS after the await: attaches the post-handshake listener and queues pendingMessages first.
    const secure = new SecureTransport(t, noise);
    link.secure = secure;
    return { secure, remote: canonicalPubHex(noise.remotePub) };
  }

  async hostFlow(link: Link): Promise<void> {
    let res: { secure: SecureTransport; remote: string };
    try {
      res = await this.handshake(link, 'host', link.pairing ? link.prologue : undefined);
    } catch (e) {
      if (link.pairing) this.pairing.settle(false);
      throw e;
    }
    const { secure, remote } = res;
    link.remoteDevice = remote;
    if (link.pairing) {
      this.pairing.settle(true); // a completed code-bound handshake consumes the code
      const name = await this.exchangeNames(secure, remote);
      void name;
      // The viewer closes first; this is only a backstop.
      setTimeout(() => this.finishLink(link, 'paired'), 3000).unref?.();
      return;
    }
    if (!isTrustedDevice(remote, this.knownPath)) {
      secure.close();
      throw new Error('untrusted_device');
    }
    const rpc = new RpcPeer(secure.asRpcTransport());
    rpc.on('error', () => { /* audited in the hub; channel stays up */ });
    wireHub(rpc, {
      remoteDeviceId: remote,
      services: this.services,
      auditLogPath: this.opts.auditLogPath ?? join(this.home, '.metaide', 'logs', 'p2p-audit.log'),
      events: { aliveShellsChanged: emitAliveShellsChanged, projectsChanged: emitProjectsChanged },
    });
    link.rpc = rpc;
    let set = this.hostLive.get(remote);
    if (!set) this.hostLive.set(remote, (set = new Set()));
    set.add(link);
    this.touchDevice(remote);
    secure.start();
  }

  async viewerFlow(link: Link): Promise<void> {
    const { secure, remote } = await this.handshake(link, 'viewer', link.pairing ? link.codePrologue : undefined);
    link.remoteDevice = remote;
    if (link.pairing) {
      await this.exchangeNames(secure, remote);
      link.settle?.({ ok: true });
      this.finishLink(link, 'paired');
      return;
    }
    if (remote !== link.expectedDevice || !isTrustedDevice(remote, this.knownPath)) {
      secure.close();
      throw new Error('untrusted_device');
    }
    const rpc = new RpcPeer(secure.asRpcTransport(), { allowIncomingStreams: false });
    rpc.on('error', () => { /* per-call errors reach the caller */ });
    link.rpc = rpc;
    this.conns.set(remote, { rpc, link });
    this.touchDevice(remote);
    secure.start();
    link.settle?.({ ok: true });
  }

  /** Pairing: both sides send their device name as the first secure message, then persist each other. */
  exchangeNames(secure: SecureTransport, remote: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('pairing_exchange_timeout')), PAIR_EXCHANGE_TIMEOUT_MS);
      secure.on('close', () => { clearTimeout(timer); reject(new Error('transport_closed')); });
      secure.on('message', (m: Uint8Array) => {
        clearTimeout(timer);
        let name = '';
        try { name = String((JSON.parse(new TextDecoder().decode(m)) as { hello?: unknown }).hello ?? ''); } catch { /* ignore */ }
        name = name.slice(0, 80) || remote.slice(0, 8);
        try {
          addKnownDevice(remote, name, this.knownPath);
          this.recordDevice(remote, name);
          resolve(name);
        } catch (e) {
          reject(e);
        }
      });
      secure.start();
      secure.send(new TextEncoder().encode(JSON.stringify({ hello: this.settings().deviceName })));
    });
  }

  /**
   * Transient link drops while the signaling client is still up (or coming up) are reported to streams as
   * 'reconnecting' so the renderer shows the Reconnecting pill; terminal reasons pass through unchanged.
   */
  private streamCloseReason(reason: string): string {
    if (reason !== 'transport_closed' && reason !== 'negotiation_timeout' && reason !== 'relay_unreachable') return reason;
    const st = this.client?.status;
    return st === 'connected' || st === 'connecting' ? 'reconnecting' : reason;
  }

  finishLink(link: Link, reason: string): void {
    if (link.closed) return;
    link.closed = true;
    if (link.timer) { clearTimeout(link.timer); link.timer = null; }
    if (this.hostSlot === link) this.hostSlot = null;
    if (link.sessionId) this.links.delete(link.sessionId);
    const wi = this.viewerWaiting.indexOf(link);
    if (wi >= 0) this.viewerWaiting.splice(wi, 1);
    this.allLinks.delete(link);
    if (link.role === 'host' && link.pairing && link.prologue && !link.handshakeStarted) this.pairing.abort();
    if (link.remoteDevice) {
      this.hostLive.get(link.remoteDevice)?.delete(link);
      const c = this.conns.get(link.remoteDevice);
      if (c && c.link === link) {
        this.conns.delete(link.remoteDevice);
        for (const [id, s] of this.streams) {
          if (s.deviceId === link.remoteDevice) { this.streams.delete(id); this.opts.emit?.('p2p:rpc-event', { deviceId: s.deviceId, streamId: id, closed: true, reason: this.streamCloseReason(reason) }); }
        }
      }
    }
    link.settle?.({ ok: false, error: reason });
    try { link.rpc?.close(); } catch { /* already closed */ }
    try { link.secure?.close(); } catch { /* already closed */ }
    try { link.transport?.close(); } catch { /* already closed */ }
    // Tell the peer why when signaling is still live (no-op if the FSM already closed).
    if (link.session.state !== 'closed' && link.sessionId) {
      try { this.client?.send({ type: SignalingTypes.SessionClose, data: { session: link.sessionId, reason } }); } catch { /* relay down */ }
    }
  }

  // ---- viewer operations ----

  async connectViewer(opts: { code: string; pairing: boolean; expectedDevice?: string; codePrologue?: Uint8Array }): Promise<{ ok: true } | { ok: false; error: string }> {
    let client: SignalingClient;
    try { client = await this.ensureClient(true); } catch (e) { return { ok: false, error: reasonOf(e) }; }
    void client;
    return new Promise((resolve) => {
      const session = new SignalingSession({ role: 'viewer', code: opts.code, pairing: opts.pairing, nowMs: this.opts.now });
      const link = this.newLink('viewer', session, opts.pairing);
      link.expectedDevice = opts.expectedDevice;
      link.codePrologue = opts.codePrologue;
      link.settle = resolve;
      this.viewerWaiting.push(link);
      this.startNegotiationTimer(link);
      this.run(link, session.start());
    });
  }

  async ensureConn(deviceId: string): Promise<RpcPeer> {
    const id = canonicalPubHex(deviceId);
    const live = this.conns.get(id);
    if (live) return live.rpc;
    if (!isTrustedDevice(id, this.knownPath)) throw new Error('unknown_device');
    let p = this.connecting.get(id);
    if (!p) {
      p = (async () => {
        const r = await this.connectViewer({ code: id, pairing: false, expectedDevice: id });
        if (!r.ok) throw new Error(r.error);
        return this.conns.get(id)!.rpc;
      })();
      this.connecting.set(id, p);
      const clear = () => this.connecting.delete(id);
      p.then(clear, clear);
    }
    return p;
  }

  async rpcCall(deviceId: string, method: string, params: unknown): Promise<unknown> {
    if (!Object.prototype.hasOwnProperty.call(RpcMethods, method)) throw new Error(`unknown_method: ${method}`);
    const id = canonicalPubHex(deviceId);
    const rpc = await this.ensureConn(id);
    if (method === 'shells.attach') {
      const streamId = ++this.#streamSeq;
      const handle = rpc.openStream('shells.attach', params as never, (data) => this.opts.emit?.('p2p:rpc-event', { deviceId: id, streamId, data }),
        () => {
          // Remote ended the stream (handler finished, shell exited): tell the renderer once.
          if (this.streams.delete(streamId)) this.opts.emit?.('p2p:rpc-event', { deviceId: id, streamId, closed: true, reason: 'remote_ended' });
        },
      );
      this.streams.set(streamId, { deviceId: id, handle });
      return { streamId };
    }
    if (method === 'shells.input' || method === 'shells.resize') {
      // The renderer addresses streams by its local id; the host knows them by wire id.
      const p = (params ?? {}) as { stream?: number };
      const entry = typeof p.stream === 'number' ? this.streams.get(p.stream) : undefined;
      const wire = entry && entry.deviceId === id ? entry.handle.stream : undefined;
      if (wire === undefined) throw new Error('unknown_stream: stream not attached');
      return rpc.call(method as RpcMethodName, { ...p, stream: wire } as never);
    }
    return rpc.call(method as RpcMethodName, params as never);
  }

  async redeemPairCode(code: string): Promise<PairRedeemResult> {
    if (!code || typeof code !== 'string') return { ok: false, error: 'invalid_code' };
    return this.connectViewer({ code: pairRendezvous(code), pairing: true, codePrologue: enrollmentPrologue(code) });
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const id = canonicalPubHex(deviceId);
    removeKnownDevice(id, this.knownPath);
    this.services.db.prepare('DELETE FROM devices WHERE id = ? AND is_self = 0').run(id);
    for (const l of [...(this.hostLive.get(id) ?? [])]) this.finishLink(l, 'revoked');
    const c = this.conns.get(id);
    if (c) this.finishLink(c.link, 'revoked');
  }

  fleet(): FleetEntry[] {
    const seen = new Map(
      (this.services.db.prepare('SELECT id, last_seen_at FROM devices WHERE is_self = 0').all() as Array<{ id: string; last_seen_at: number | null }>).map((r) => [r.id, r.last_seen_at]),
    );
    return loadKnownDevices(this.knownPath).map((d) => ({
      deviceId: d.pub,
      name: d.name,
      online: this.conns.has(d.pub) || (this.hostLive.get(d.pub)?.size ?? 0) > 0,
      lastSeenAt: seen.get(d.pub) ?? null,
    }));
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const l of [...this.allLinks]) this.finishLink(l, 'shutdown');
    for (const s of this.streams.values()) s.handle.close();
    this.streams.clear();
    await this.stopClient();
  }
}

export interface P2PHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  api: P2PApi;
}

/**
 * Builds an independent P2P instance (tests run a host and a viewer side by side; the app uses the
 * `startP2P` singleton below). Nothing happens until `start()`.
 */
export function createP2P(services: Services, opts: StartP2POpts = {}): P2PHandle {
  let rt: P2PRuntime | null = null;
  const need = (): P2PRuntime => {
    if (!rt) throw new Error('p2p_not_started');
    return rt;
  };
  const api: P2PApi = {
    fleetList: async () => need().fleet(),
    getSettings: () => need().view(),
    setSettings: (p) => need().setSettings(p),
    generatePairCode: () => need().pairing.generate(),
    redeemPairCode: (code) => need().redeemPairCode(code),
    revokeDevice: (id) => need().revokeDevice(id),
    rpcCall: (id, m, p) => need().rpcCall(id, m, p),
    rpcCloseStream: (streamId) => {
      const s = need().streams.get(streamId);
      if (s) { need().streams.delete(streamId); s.handle.close(); }
    },
  };
  return {
    api,
    async start() {
      if (rt) return;
      runMigrations(services.db, services.migrationsDir);
      const r = new P2PRuntime(services, opts);
      rt = r;
      setHubServices(services);
      r.upsertSelf(r.settings().deviceName);
      services.p2p = { deviceKey: r.deviceKey, pairing: r.pairing, knownDevicesPath: r.knownPath, api };
      try {
        await r.startClientIfServing();
      } catch (e) {
        if (reasonOf(e) !== 'no_agent_token') throw e; // no token yet: stays dormant until one is provisioned
      }
    },
    async stop() {
      const r = rt;
      rt = null;
      if (!r) return;
      services.p2p = undefined;
      await r.stop();
    },
  };
}

let current: P2PHandle | null = null;

/**
 * Starts the P2P subsystem: ensures the schema, loads the device key, publishes `services.p2p`, and (if
 * serving is enabled and an agent token exists) connects to the relay. Idempotent.
 */
export async function startP2P(services: Services, opts: StartP2POpts = {}): Promise<void> {
  if (current) return;
  const h = createP2P(services, opts);
  current = h;
  try {
    await h.start();
  } catch (e) {
    current = null;
    throw e;
  }
}

export async function stopP2P(): Promise<void> {
  const c = current;
  current = null;
  await c?.stop();
}

export async function listFleet(): Promise<FleetEntry[]> {
  return current ? current.api.fleetList() : [];
}
