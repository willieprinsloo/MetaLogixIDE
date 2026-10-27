import { app } from 'electron';
import { EventEmitter } from 'node:events';
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
  CONNECT_CODE_RE,
  type DeviceKey,
} from './identity';
import { loadHostIdentity, saveHostIdentity, type HostIdentity } from './host-identity';
import { McClient, type McStatus, type TlsOpts } from './mcClient';
import { doNoiseXxHandshake, pairingPrologue } from './pairing';
import { PairingSession } from './pairing-session';
import { RpcPeer } from './rpc';
import { SecureTransport } from './secure';
import { SignalingSession, type Effect } from './session';
import { WebRtcTransport } from './transport';
import type { P2PApi, PairRedeemResult } from './types';

/*
 * P2P lifecycle against mrsignald (metaconnect internal/mrserver). Two kinds of relay connection per device:
 *
 *  - ONE persistent HOST connection (when serveEnabled). Hello {role:'host', code?, secret?}; on first run the
 *    relay mints (code, secret) and replies `assign_code`, which is persisted to ~/.metaide/host-identity.json (0600).
 *    The code is this machine's public address AND its pair code. The host arms a SignalingSession slot (Register),
 *    receives `session_invite`, then offers.
 *  - One short-lived anonymous VIEWER connection PER outbound session (Hello {role:'viewer'}), carrying
 *    `session_request{code: <target host's code>}`. The relay forbids a connection from being both roles, and a viewer
 *    connection that drops orphans its session, so viewer connections never reconnect and die with their link.
 *
 * Host path:  invite -> transport + offer -> answer -> 'open' -> Noise XX (responder) -> trust check -> RpcPeer + wireHub.
 * Viewer path: granted -> offer -> answer -> 'open' -> Noise XX (initiator) -> RpcPeer.
 *
 * ---- Pairing ----
 * "Pair a new machine" opens a pairing window on the host and shows the host's own connect code. The other machine
 * enters it ("Join a fleet"); that viewer session is a pairing session. The relay does not forward a pairing flag, so
 * the host treats the next invite that arrives while a window is open as the pairing session (a trusted peer
 * connecting in that window fails its handshake and costs one attempt; acceptable for a 5 min user-initiated window).
 * Noise prologue = SHA-256(code, session id). After Noise, both sides swap `{hello: name, code: <own host code>}` so each
 * stores the other's pub key AND the code needed to dial it later.
 *
 * ---- Handshake contract (pendingMessages) ----
 * `doNoiseXxHandshake` returns `pendingMessages`: encrypted frames the peer sent after message 3 but
 * before the handshake listener was detached. The caller MUST build its SecureTransport (which attaches
 * the post-handshake 'message' listener) SYNCHRONOUSLY in the continuation of `await doNoiseXxHandshake`
 * (no await in between), and the SecureTransport replays `pendingMessages` in order before any frame
 * received afterwards. See `handshake()` below; do not insert awaits between the two.
 *
 * ---- Relay wire facts (verified against mrsignald, see tests/live integration) ----
 * - Session tokens are opaque hex strings; ice servers arrive as `ice_servers` (snake_case); session_denied has no session.
 * - Fleet `online` heuristic (the relay's /presence endpoint is localhost-only, so not usable from clients):
 *   a device is online if a live session to/from it exists, or if the host connection is up and we completed a
 *   session with it (pairing or connect) within the last 60 s (ONLINE_GRACE_MS). Session end clears it.
 */

export const NEGOTIATION_TIMEOUT_MS = 30_000;
const PAIR_EXCHANGE_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;
/** See header: how long a completed session counts as proof the peer is reachable. */
export const ONLINE_GRACE_MS = 60_000;
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

/** What the lifecycle asks of the signaling client factory (one call per relay connection). */
export interface ClientCfg {
  url: string;
  port: number;
  role: 'host' | 'viewer';
  /** Host only; absent on first run. */
  identity?: { code: string; secret: Secret<string> };
  /** Host only: persist a freshly minted pair before the client reports `connected`. */
  onAssignCode?: (id: { code: string; secret: string }) => void | Promise<void>;
  tls?: TlsOpts;
}

export interface StartP2POpts {
  /** Defaults to services.homeDir. */
  homeDir?: string;
  /** Test seam; default constructs a McClient. */
  createClient?: (cfg: ClientCfg) => SignalingClient;
  /** Transport security for the default McClient (production: TLS; local mrsignald: { plaintext: true }). */
  relayTls?: TlsOpts;
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

/** Lifetime granted to an opaque relay token (mrsignald's tokens carry no timestamps). */
const OPAQUE_TOKEN_TTL_MS = 10 * 60_000;

/**
 * Wire tokens arrive as `{iat,exp}`, a JWT-like string, or (mrsignald) an opaque hex string with no timestamps; for the
 * last, validity is synthesised from `nowMs` since the relay will not honour it later than the session anyway.
 * Anything else is rejected (fail closed).
 */
export function parseSessionToken(t: unknown, nowMs: number = Date.now()): { iat: number; exp: number } | null {
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
      return /^[0-9a-fA-F]{16,256}$/.test(t) ? { iat: nowMs, exp: nowMs + OPAQUE_TOKEN_TTL_MS } : null;
    }
  }
  return null;
}

interface Link {
  role: 'host' | 'viewer';
  /** The relay connection this link signals over (the host connection, or this viewer's own). */
  client: SignalingClient;
  session: SignalingSession;
  sessionId: string;
  transport: WebRtcTransport | null;
  pairing: boolean;
  /** Pairing host: the prologue reserved from PairingSession.begin(). */
  prologue?: Uint8Array;
  /** Pairing viewer: the host code being joined (prologue = SHA-256(code, session id), known once granted). */
  pairCode?: string;
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
  readonly identityPath: string;
  /** The persistent host connection. */
  client: SignalingClient | null = null;
  hostIdentity: HostIdentity | null = null;
  hostSlot: Link | null = null;
  readonly links = new Map<string, Link>();
  /** Last completed session per device id (online heuristic). */
  readonly lastOkAt = new Map<string, number>();
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
    this.identityPath = join(this.home, '.metaide', 'host-identity.json');
    this.hostIdentity = loadHostIdentity(this.identityPath);
    this.deviceKey = loadOrCreateDeviceKey(join(this.home, '.metaide', 'device.key'));
    this.pairing = new PairingSession({ maxAttempts: opts.pairingMaxAttempts, now: opts.now });
  }

  nowMs(): number {
    return (this.opts.now ?? Date.now)();
  }

  // ---- settings ----

  settings(): P2PSettings {
    const r = this.services.db.prepare('SELECT relay_url, relay_port, device_name, serve_enabled FROM p2p_settings WHERE id = 1').get() as
      | { relay_url: string | null; relay_port: number | null; device_name: string | null; serve_enabled: number }
      | undefined;
    return {
      relayUrl: r?.relay_url ?? 'remote.metalogix.solutions',
      relayPort: r?.relay_port ?? 7100,
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
      await this.stopClient();
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

  // ---- signaling clients ----

  /** The host code to show as "Your pair code" (null until the relay has minted one). */
  connectCode(): string | null {
    return this.hostIdentity?.code ?? null;
  }

  #makeClient(cfg: ClientCfg): SignalingClient {
    if (this.opts.createClient) return this.opts.createClient(cfg);
    return new McClient({
      url: cfg.url,
      port: cfg.port,
      role: cfg.role,
      identity: cfg.identity,
      onAssignCode: cfg.onAssignCode,
      tls: cfg.tls,
      reconnect: cfg.role === 'host',
    });
  }

  async startClientIfServing(): Promise<void> {
    if (this.#stopped || !this.settings().serveEnabled) return;
    await this.ensureHostClient();
  }

  /** Creates and starts the single persistent host connection (does not wait for it). */
  async ensureHostClient(): Promise<SignalingClient> {
    if (this.client) return this.client;
    const s = this.settings();
    const id = this.hostIdentity;
    const c = this.#makeClient({
      url: s.relayUrl,
      port: s.relayPort,
      role: 'host',
      identity: id ? { code: id.code, secret: new Secret(id.secret) } : undefined,
      tls: this.opts.relayTls,
      onAssignCode: (minted) => {
        saveHostIdentity(minted, this.identityPath); // throws -> client never reports connected
        this.hostIdentity = minted;
      },
    });
    c.on('error', () => { /* surfaced through status; McClient reconnects on its own */ });
    c.on('envelope', (env: Envelope) => this.onHostEnvelope(env));
    c.on('status', (st: McStatus) => this.onHostStatus(st));
    this.client = c;
    await c.start();
    return c;
  }

  async stopClient(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.hostSlot = null;
    if (c) { c.removeAllListeners('envelope'); c.removeAllListeners('status'); await c.stop(); }
  }

  onHostStatus(st: McStatus): void {
    if (st === 'connected') this.armHostSlot();
    else this.hostSlot = null;
  }

  armHostSlot(): void {
    const c = this.client;
    if (!c || c.status !== 'connected' || this.hostSlot || !this.settings().serveEnabled) return;
    const session = new SignalingSession({
      role: 'host',
      nowMs: this.opts.now,
      identity: this.hostIdentity ?? undefined,
      capabilities: {
        agentVersion: this.opts.appVersion ?? app.getVersion(),
        hostFingerprint: this.deviceKey.fingerprint,
        monitors: [], // the IDE does not advertise displays
      },
    });
    const link = this.newLink('host', c, session, false);
    this.hostSlot = link;
    this.run(link, session.start());
  }

  newLink(role: 'host' | 'viewer', client: SignalingClient, session: SignalingSession, pairing: boolean): Link {
    const link: Link = { role, client, session, sessionId: '', transport: null, pairing, handshakeStarted: false, closed: false, timer: null };
    this.allLinks.add(link);
    return link;
  }

  // ---- inbound signaling ----

  /** Host connection: invites open new links; everything else is routed by session id. */
  onHostEnvelope(env: Envelope): void {
    if (this.#stopped) return;
    const d = (env.data ?? {}) as { session?: string; token?: unknown; ice_servers?: unknown; iceServers?: unknown };
    if (env.type === SignalingTypes.SessionInvite) return this.onInvite(env, d);
    const link = d.session ? this.links.get(d.session) : undefined;
    if (link && link.role === 'host') this.run(link, link.session.onInbound(env));
  }

  /** A viewer connection serves exactly one link. */
  onViewerEnvelope(link: Link, env: Envelope): void {
    if (this.#stopped || link.closed) return;
    const d = (env.data ?? {}) as { session?: string; token?: unknown; ice_servers?: unknown; iceServers?: unknown };
    switch (env.type) {
      case SignalingTypes.SessionGranted: return this.onGranted(link, env, d);
      case SignalingTypes.SessionDenied: return this.run(link, link.session.onInbound(env));
      default:
        // After the grant, only this session's messages are meaningful.
        if (d.session && d.session === link.sessionId) this.run(link, link.session.onInbound(env));
    }
  }

  #withToken(env: Envelope, d: { token?: unknown }): Envelope | null {
    const token = parseSessionToken(d.token, this.nowMs());
    if (!token) return null;
    return { ...env, data: { ...(env.data as object), token } };
  }

  #iceOf(d: { ice_servers?: unknown; iceServers?: unknown }): RTCIceServer[] {
    const v = Array.isArray(d.ice_servers) ? d.ice_servers : d.iceServers;
    return Array.isArray(v) ? (v as RTCIceServer[]) : [];
  }

  onInvite(env: Envelope, d: { session?: string; ice_servers?: unknown; iceServers?: unknown; token?: unknown }): void {
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

    // The relay forwards no pairing flag: an open pairing window claims the next invite (see header).
    if (this.pairing.active) {
      link.pairing = true;
      const b = this.pairing.begin(link.sessionId);
      if (!b.ok) { this.run(link, link.session.close(b.error)); return; }
      link.prologue = b.prologue;
    }
    this.startNegotiationTimer(link);
    this.setupTransport(link, this.#iceOf(d));
    void this.hostOffer(link);
  }

  onGranted(link: Link, env: Envelope, d: { session?: string; ice_servers?: unknown; iceServers?: unknown; token?: unknown }): void {
    const fixed = this.#withToken(env, d);
    if (!fixed) { this.run(link, link.session.close('invalid_token')); return; }
    this.run(link, link.session.onInbound(fixed));
    if (link.session.state !== 'granted') return;
    link.sessionId = d.session as string;
    this.links.set(link.sessionId, link);
    if (link.pairing && link.pairCode) link.codePrologue = pairingPrologue(link.pairCode, link.sessionId);
    this.setupTransport(link, this.#iceOf(d));
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
          try { link.client.send(fx.env); } catch { this.finishLink(link, 'relay_unreachable'); }
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
      await this.exchangeNames(secure, remote);
      this.lastOkAt.set(remote, this.nowMs());
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
      await this.exchangeNames(secure, remote, link.pairCode);
      this.lastOkAt.set(remote, this.nowMs());
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
    this.lastOkAt.set(remote, this.nowMs());
    this.touchDevice(remote);
    secure.start();
    link.settle?.({ ok: true });
  }

  /**
   * Pairing: both sides send `{hello: name, code: <own host connect code>}` as the first secure message, then persist
   * each other (pub key + the code needed to dial back). `fallbackCode` is the code the joiner already dialled.
   */
  exchangeNames(secure: SecureTransport, remote: string, fallbackCode?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('pairing_exchange_timeout')), PAIR_EXCHANGE_TIMEOUT_MS);
      secure.on('close', () => { clearTimeout(timer); reject(new Error('transport_closed')); });
      secure.on('message', (m: Uint8Array) => {
        clearTimeout(timer);
        let name = '';
        let code: string | undefined;
        try {
          const j = JSON.parse(new TextDecoder().decode(m)) as { hello?: unknown; code?: unknown };
          name = String(j.hello ?? '');
          if (typeof j.code === 'string' && CONNECT_CODE_RE.test(j.code)) code = j.code;
        } catch { /* ignore */ }
        name = name.slice(0, 80) || remote.slice(0, 8);
        try {
          addKnownDevice(remote, name, this.knownPath, Date.now(), code ?? fallbackCode);
          this.recordDevice(remote, name);
          resolve(name);
        } catch (e) {
          reject(e);
        }
      });
      secure.start();
      secure.send(new TextEncoder().encode(JSON.stringify({ hello: this.settings().deviceName, ...(this.hostIdentity && this.settings().serveEnabled ? { code: this.hostIdentity.code } : {}) })));
    });
  }

  /**
   * Transient link drops while the signaling client is still up (or coming up) are reported to streams as
   * 'reconnecting' so the renderer shows the Reconnecting pill; terminal reasons pass through unchanged.
   */
  private streamCloseReason(link: Link, reason: string): string {
    if (reason !== 'transport_closed' && reason !== 'negotiation_timeout' && reason !== 'relay_unreachable') return reason;
    const st = link.client.status;
    return st === 'connected' || st === 'connecting' ? 'reconnecting' : reason;
  }

  finishLink(link: Link, reason: string): void {
    if (link.closed) return;
    link.closed = true;
    if (link.timer) { clearTimeout(link.timer); link.timer = null; }
    if (this.hostSlot === link) this.hostSlot = null;
    if (link.sessionId) this.links.delete(link.sessionId);
    this.allLinks.delete(link);
    if (link.role === 'host' && link.pairing && link.prologue && !link.handshakeStarted) this.pairing.abort();
    if (link.remoteDevice) {
      if (!link.pairing) this.lastOkAt.delete(link.remoteDevice); // a pairing link ending is the normal outcome, not a loss of reachability
      this.hostLive.get(link.remoteDevice)?.delete(link);
      const c = this.conns.get(link.remoteDevice);
      if (c && c.link === link) {
        this.conns.delete(link.remoteDevice);
        for (const [id, s] of this.streams) {
          if (s.deviceId === link.remoteDevice) { this.streams.delete(id); this.opts.emit?.('p2p:rpc-event', { deviceId: s.deviceId, streamId: id, closed: true, reason: this.streamCloseReason(link, reason) }); }
        }
      }
    }
    link.settle?.({ ok: false, error: reason });
    try { link.rpc?.close(); } catch { /* already closed */ }
    try { link.secure?.close(); } catch { /* already closed */ }
    try { link.transport?.close(); } catch { /* already closed */ }
    // Tell the peer why when signaling is still live (no-op if the FSM already closed).
    if (link.session.state !== 'closed' && link.sessionId) {
      try { link.client.send({ type: SignalingTypes.SessionClose, data: { session: link.sessionId, reason } }); } catch { /* relay down */ }
    }
    // A viewer connection exists only for its link.
    if (link.role === 'viewer') { link.client.removeAllListeners('envelope'); link.client.removeAllListeners('status'); void link.client.stop().catch(() => {}); }
  }

  // ---- viewer operations ----

  /**
   * Opens a dedicated viewer relay connection, requests a session with the host owning `code`, and resolves when the
   * link is established (RPC ready, or pairing finished) or fails.
   */
  async connectViewer(opts: { code: string; pairing: boolean; expectedDevice?: string }): Promise<{ ok: true } | { ok: false; error: string }> {
    const st = this.settings();
    let client: SignalingClient;
    try {
      client = this.#makeClient({ url: st.relayUrl, port: st.relayPort, role: 'viewer', tls: this.opts.relayTls });
      client.on('error', () => { /* surfaced as status / negotiation timeout */ });
      await client.start();
      if (client.status !== 'connected') {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => { client.off('status', on); reject(new Error('relay_unreachable')); }, CONNECT_TIMEOUT_MS);
          const on = (s2: McStatus) => { if (s2 === 'connected') { clearTimeout(t); client.off('status', on); resolve(); } };
          client.on('status', on);
        });
      }
    } catch (e) {
      return { ok: false, error: reasonOf(e) };
    }
    if (this.#stopped) { void client.stop(); return { ok: false, error: 'shutdown' }; }
    return new Promise((resolve) => {
      const session = new SignalingSession({ role: 'viewer', code: opts.code, nowMs: this.opts.now });
      const link = this.newLink('viewer', client, session, opts.pairing);
      link.expectedDevice = opts.expectedDevice;
      if (opts.pairing) link.pairCode = opts.code;
      link.settle = resolve;
      client.on('envelope', (env: Envelope) => this.onViewerEnvelope(link, env));
      // Viewer connections never reconnect; a drop before the data channel is up can't be recovered.
      client.on('status', (s2: McStatus) => { if (s2 === 'disconnected' && !link.handshakeStarted) this.finishLink(link, 'relay_unreachable'); });
      this.startNegotiationTimer(link);
      this.run(link, session.start());
    });
  }

  async ensureConn(deviceId: string): Promise<RpcPeer> {
    const id = canonicalPubHex(deviceId);
    const live = this.conns.get(id);
    if (live) return live.rpc;
    if (!isTrustedDevice(id, this.knownPath)) throw new Error('unknown_device');
    const code = loadKnownDevices(this.knownPath).find((d) => d.pub === id)?.code;
    if (!code) throw new Error('no_device_code'); // paired before connect codes existed: re-pair
    let p = this.connecting.get(id);
    if (!p) {
      p = (async () => {
        const r = await this.connectViewer({ code, pairing: false, expectedDevice: id });
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
      return this.#callWithReconnect(id, rpc, method as RpcMethodName, { ...p, stream: wire } as never);
    }
    return this.#callWithReconnect(id, rpc, method as RpcMethodName, params as never);
  }

  /** Reconnect-on-hang: if an RPC comes back with request_timeout (or the peer
   * reports it's closed), the WebRTC data channel is wedged. Tearing down the
   * link here means the NEXT rpcCall goes through ensureConn and builds a
   * fresh viewer session — the user sees one failed call, then it recovers. */
  async #callWithReconnect(id: string, rpc: RpcPeer, method: RpcMethodName, params: never): Promise<unknown> {
    try {
      return await rpc.call(method, params);
    } catch (e) {
      const code = (e as { code?: string } | undefined)?.code;
      if (code === 'request_timeout' || code === 'closed') {
        const c = this.conns.get(id);
        if (c && c.rpc === rpc) this.finishLink(c.link, code === 'request_timeout' ? 'request_timeout' : 'rpc_closed');
      }
      throw e;
    }
  }

  async redeemPairCode(code: string): Promise<PairRedeemResult> {
    if (!code || typeof code !== 'string') return { ok: false, error: 'invalid_code' };
    const target = code.trim();
    if (!CONNECT_CODE_RE.test(target)) return { ok: false, error: 'invalid_code' };
    if (target === this.hostIdentity?.code) return { ok: false, error: 'own_code' };
    return this.connectViewer({ code: target, pairing: true });
  }

  /** Opens a pairing window bound to this machine's connect code and returns it as the pair code. */
  generatePairCode(): { code: string; expiresAt: number } {
    if (!this.settings().serveEnabled) throw new Error('serve_disabled');
    const code = this.connectCode();
    if (!code) throw new Error('relay_not_ready'); // no code minted yet: the host connection has not completed its first Hello
    return this.pairing.generate(code);
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const id = canonicalPubHex(deviceId);
    removeKnownDevice(id, this.knownPath);
    this.services.db.prepare('DELETE FROM devices WHERE id = ? AND is_self = 0').run(id);
    for (const l of [...(this.hostLive.get(id) ?? [])]) this.finishLink(l, 'revoked');
    const c = this.conns.get(id);
    if (c) this.finishLink(c.link, 'revoked');
  }

  /** Manual reconnect: tear down any live viewer link so the next RPC rebuilds it.
   * Idempotent — safe to call when nothing is connected. The user-facing "Reconnect"
   * button in the sidebar invokes this when a device looks stuck. */
  async reconnectDevice(deviceId: string): Promise<void> {
    const id = canonicalPubHex(deviceId);
    const c = this.conns.get(id);
    if (c) this.finishLink(c.link, 'manual_reconnect');
  }

  /** See header: live session, or host connection up and a session completed within ONLINE_GRACE_MS. */
  isOnline(id: string): boolean {
    if (this.conns.has(id) || (this.hostLive.get(id)?.size ?? 0) > 0) return true;
    const ok = this.lastOkAt.get(id);
    return this.client?.status === 'connected' && ok !== undefined && this.nowMs() - ok < ONLINE_GRACE_MS;
  }

  fleet(): FleetEntry[] {
    const seen = new Map(
      (this.services.db.prepare('SELECT id, last_seen_at FROM devices WHERE is_self = 0').all() as Array<{ id: string; last_seen_at: number | null }>).map((r) => [r.id, r.last_seen_at]),
    );
    return loadKnownDevices(this.knownPath).map((d) => ({
      deviceId: d.pub,
      name: d.name,
      online: this.isOnline(d.pub),
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
    generatePairCode: () => need().generatePairCode(),
    redeemPairCode: (code) => need().redeemPairCode(code),
    revokeDevice: (id) => need().revokeDevice(id),
    reconnectDevice: (id) => need().reconnectDevice(id),
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
      await r.startClientIfServing();
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
 * serving is enabled) opens the host connection to the relay. Idempotent.
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
