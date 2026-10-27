import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

vi.mock('electron', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  app: { getVersion: () => '9.9.9-test' },
  clipboard: { readImage: () => ({ isEmpty: () => true }) },
}));

import { createP2P, parseSessionToken, ONLINE_GRACE_MS, type ClientCfg, type P2PHandle, type SignalingClient } from '../index';
import { buildServices, type Services } from '../../services';
import { loadKnownDevices, addKnownDevice, canonicalPubHex } from '../identity';
import { doNoiseXxHandshake, pairingPrologue } from '../pairing';
import { loadHostIdentity } from '../host-identity';
import { SecureTransport } from '../secure';
import { RpcPeer } from '../rpc';
import { pairedTransports } from './_pairedTransports';
import { waitFor } from './_mockRelay';
import { encodeFrame } from '../../../shared/signaling-wire';
import { loadOrCreateDeviceKey } from '../identity';
import type { Envelope } from '../../../shared/signaling-wire';
import type { WebRtcTransport } from '../transport';
import type { McStatus } from '../mcClient';

const migrationsDir = resolve(__dirname, '../../../../migrations');

// ---- fakes -----------------------------------------------------------------

/**
 * Routes signaling between fake clients like a (very) small mrsignald: hosts are addressed by connect code, a host
 * without an identity is minted one (assign_code semantics via cfg.onAssignCode), and a registration persists
 * (it is not consumed per session).
 */
class FakeRelay {
  clients: FakeClient[] = [];
  hosts = new Map<string, FakeClient>();
  sessions = new Map<string, { host: FakeClient; viewer: FakeClient }>();
  seq = 0;
  codeSeq = 0;
  sent: Array<{ from: string; env: Envelope }> = [];

  newClient(name: string, cfg: ClientCfg): FakeClient {
    const c = new FakeClient(name, this, cfg);
    this.clients.push(c);
    return c;
  }

  route(from: FakeClient, env: Envelope): void {
    this.sent.push({ from: from.name, env });
    const d = (env.data ?? {}) as { session?: string; code?: string };
    const deliver = (to: FakeClient, e: Envelope) => queueMicrotask(() => { to.emit('envelope', e); });
    const token = 'ab'.repeat(16); // mrsignald tokens are opaque hex
    switch (env.type) {
      case 'register':
        if (from.code) this.hosts.set(from.code, from);
        return;
      case 'session_request': {
        const host = d.code ? this.hosts.get(d.code) : undefined;
        if (!host || host.status !== 'connected') return deliver(from, { type: 'session_denied', data: { host: d.code, reason: 'host offline' } });
        const session = `s${++this.seq}`;
        this.sessions.set(session, { host, viewer: from });
        deliver(host, { type: 'session_invite', data: { session, operator: 'op-1', requires_key: false, ice_servers: [], token } });
        deliver(from, { type: 'session_granted', data: { session, host: d.code, host_fingerprint: 'f', ice_servers: [], token } });
        return;
      }
      default: {
        const s = d.session ? this.sessions.get(d.session) : undefined;
        if (!s) return;
        deliver(from === s.host ? s.viewer : s.host, env);
      }
    }
  }
}

class FakeClient extends EventEmitter implements SignalingClient {
  status: McStatus = 'disconnected';
  started = 0;
  code = '';
  constructor(readonly name: string, readonly relay: FakeRelay, readonly cfg: ClientCfg) { super(); }
  async start() {
    this.started++;
    queueMicrotask(async () => {
      if (this.cfg.role === 'host') {
        if (this.cfg.identity) this.code = this.cfg.identity.code;
        else {
          this.code = `10000000${++this.relay.codeSeq}`;
          await this.cfg.onAssignCode?.({ code: this.code, secret: 'fake-secret' });
        }
      }
      this.status = 'connected';
      this.emit('status', 'connected');
    });
  }
  async stop() { this.status = 'disconnected'; this.emit('status', 'disconnected'); }
  send(env: Envelope) { this.relay.route(this, env); }
}

class TransportRegistry { onCreate?: (t: FakeTransport) => void; byOffer = new Map<string, FakeTransport>(); n = 0; all: FakeTransport[] = []; }

class FakeTransport extends EventEmitter {
  peer: FakeTransport | null = null;
  closed = false;
  id = '';
  constructor(readonly role: 'host' | 'viewer', readonly reg: TransportRegistry) { super(); reg.all.push(this); reg.onCreate?.(this); }
  async openDataChannel() {}
  async createOffer() { this.id = String(++this.reg.n); this.reg.byOffer.set(this.id, this); return `offer:${this.id}`; }
  async createAnswer(sdp: string) {
    const host = this.reg.byOffer.get(sdp.slice(6))!;
    this.peer = host; host.peer = this;
    return `answer:${host.id}`;
  }
  async setRemoteDescription(sdp: string) {
    if (sdp.startsWith('answer:')) queueMicrotask(() => { this.emit('open'); this.peer?.emit('open'); });
  }
  async addIceCandidate() {}
  send(bytes: Uint8Array) {
    const p = this.peer;
    if (p && !this.closed) queueMicrotask(() => p.emit('message', bytes));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => { this.emit('close'); this.peer?.close(); });
  }
}

interface Node { name: string; home: string; services: Services; p2p: P2PHandle; client: () => FakeClient | undefined; clients: FakeClient[]; events: unknown[] }

let tmps: string[] = [];
let nodes: Node[] = [];

function makeNode(relay: FakeRelay, reg: TransportRegistry, name: string, extra: Partial<Parameters<typeof createP2P>[1]> = {}): Node {
  const home = mkdtempSync(join(tmpdir(), `p2p-${name}-`));
  tmps.push(home);
  const services = buildServices({ homeDir: home, migrationsDir });
  const events: unknown[] = [];
  const clients: FakeClient[] = [];
  const p2p = createP2P(services, {
    homeDir: home,
    createClient: (cfg) => { const c = relay.newClient(name, cfg); clients.push(c); return c; },
    createTransport: (role) => new FakeTransport(role, reg) as unknown as WebRtcTransport,
    emit: (_c, p) => events.push(p),
    appVersion: '9.9.9-test',
    ...extra,
  });
  const node = { name, home, services, p2p, client: () => clients.find((c) => c.cfg.role === 'host'), clients, events };
  nodes.push(node);
  return node;
}

const idOf = (n: Node) => canonicalPubHex(n.services.p2p!.deviceKey.pub);
const identityFile = (n: Node) => join(n.home, '.metaide', 'host-identity.json');
/** Resolves once the node's host connection has been minted a code and persisted it. */
const hostCode = async (n: Node) => { await waitFor(() => existsSync(identityFile(n))); return loadHostIdentity(identityFile(n))!.code; };
const known = (n: Node) => loadKnownDevices(join(n.home, '.metaide', 'known_devices.json'));

/** Pairs viewer -> host (host trusts viewer, viewer trusts host). */
async function pair(host: Node, viewer: Node) {
  await hostCode(host);
  const { code } = host.p2p.api.generatePairCode();
  return { code, result: await viewer.p2p.api.redeemPairCode(code) };
}

beforeEach(() => { tmps = []; nodes = []; });
afterEach(async () => {
  for (const n of nodes) await n.p2p.stop().catch(() => {});
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

// ---- tests -----------------------------------------------------------------

describe('startP2P lifecycle', () => {
  test('creates the devices + p2p_settings tables on a fresh database', async () => {
    const relay = new FakeRelay();
    const n = makeNode(relay, new TransportRegistry(), 'a');
    n.services.db.exec('DROP TABLE devices; DROP TABLE p2p_settings; DELETE FROM schema_version WHERE version = 3;');
    await n.p2p.start();
    for (const t of ['devices', 'p2p_settings']) {
      expect(n.services.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)).toBeTruthy();
    }
    expect(n.services.db.prepare('SELECT serve_enabled FROM p2p_settings WHERE id = 1').get()).toEqual({ serve_enabled: 1 });
    expect(n.services.p2p?.deviceKey.fingerprint).toMatch(/\w+( \w+){5}/);
    expect(n.p2p.api.getSettings().deviceFingerprint).toBe(n.services.p2p!.deviceKey.fingerprint);
  });

  test('serve_enabled=0 keeps the signaling client offline', async () => {
    const relay = new FakeRelay();
    const n = makeNode(relay, new TransportRegistry(), 'a');
    n.services.db.exec('UPDATE p2p_settings SET serve_enabled = 0 WHERE id = 1');
    await n.p2p.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(n.client()).toBeUndefined();
    expect(relay.clients.length).toBe(0);
    // flipping it on at runtime brings the host connection up and registers it
    await n.p2p.api.setSettings({ serveEnabled: true });
    await waitFor(() => relay.hosts.size === 1);
    expect(n.client()?.started).toBe(1);
    // ...and flipping it off tears it down
    await n.p2p.api.setSettings({ serveEnabled: false });
    expect(n.client()?.status).toBe('disconnected');
  });

  test('first run: the host connection mints a code, persists it 0600, and registers with it', async () => {
    const relay = new FakeRelay();
    const n = makeNode(relay, new TransportRegistry(), 'a');
    await n.p2p.start();
    const code = await hostCode(n);
    expect(statSync(identityFile(n)).mode & 0o777).toBe(0o600);
    expect(n.client()!.cfg.identity).toBeUndefined(); // nothing to present yet
    await waitFor(() => relay.hosts.has(code));
  });

  test('restart reuses the persisted identity instead of minting a new code', async () => {
    const relay = new FakeRelay();
    const n = makeNode(relay, new TransportRegistry(), 'a');
    await n.p2p.start();
    const code = await hostCode(n);
    await n.p2p.stop();
    const again = createP2P(n.services, { homeDir: n.home, createClient: (cfg) => relay.newClient('a2', cfg), createTransport: () => { throw new Error('unused'); }, appVersion: 't' });
    await again.start();
    await waitFor(() => relay.clients.length === 2);
    const cfg = relay.clients[1]!.cfg;
    expect(cfg.identity?.code).toBe(code);
    expect(cfg.identity?.secret.reveal()).toBe('fake-secret');
    expect(loadHostIdentity(identityFile(n))!.code).toBe(code);
    await again.stop();
  });

  test('pair code needs a minted identity and serving enabled', async () => {
    const relay = new FakeRelay();
    const n = makeNode(relay, new TransportRegistry(), 'a');
    n.services.db.exec('UPDATE p2p_settings SET serve_enabled = 0 WHERE id = 1');
    await n.p2p.start();
    expect(() => n.p2p.api.generatePairCode()).toThrow(/serve_disabled/);
    await n.p2p.api.setSettings({ serveEnabled: true });
    const code = await hostCode(n);
    expect(n.p2p.api.generatePairCode().code).toBe(code); // "Your pair code" is the host's own connect code
  });

  test('Register carries HostCapabilities (version, fingerprint, no monitors)', async () => {
    const relay = new FakeRelay();
    const n = makeNode(relay, new TransportRegistry(), 'a');
    await n.p2p.start();
    await waitFor(() => relay.sent.some((s) => s.env.type === 'register'));
    const id = loadHostIdentity(identityFile(n))!;
    expect(relay.sent.find((s) => s.env.type === 'register')!.env.data).toEqual({
      capabilities: { agent_version: '9.9.9-test', host_fingerprint: n.services.p2p!.deviceKey.fingerprint, monitors: [] },
      code: id.code,
      secret: id.secret,
    });
  });

  test('settings round-trip and validation', async () => {
    const relay = new FakeRelay();
    const n = makeNode(relay, new TransportRegistry(), 'a');
    await n.p2p.start();
    await n.p2p.api.setSettings({ deviceName: 'Tower', relayUrl: 'relay.example', relayPort: 7443 });
    expect(n.p2p.api.getSettings()).toMatchObject({ deviceName: 'Tower', relayUrl: 'relay.example', relayPort: 7443, serveEnabled: true });
    await expect(n.p2p.api.setSettings({ relayPort: 70000 })).rejects.toThrow();
  });
});

describe('pairing over the full stack', () => {
  test('happy path: both sides store each other\'s pub key AND connect code', async () => {
    const relay = new FakeRelay();
    const reg = new TransportRegistry();
    const host = makeNode(relay, reg, 'host');
    const viewer = makeNode(relay, reg, 'viewer');
    await host.p2p.start();
    await viewer.p2p.start();
    await host.p2p.api.setSettings({ deviceName: 'Tower' });
    await viewer.p2p.api.setSettings({ deviceName: 'Laptop' });
    const hCode = await hostCode(host);
    const vCode = await hostCode(viewer);

    const { result } = await pair(host, viewer);
    expect(result).toEqual({ ok: true });
    expect(known(viewer)).toEqual([expect.objectContaining({ pub: idOf(host), name: 'Tower', code: hCode })]);
    await waitFor(() => known(host).length === 1);
    expect(known(host)).toEqual([expect.objectContaining({ pub: idOf(viewer), name: 'Laptop', code: vCode })]);
    expect((await host.p2p.api.fleetList())[0]).toMatchObject({ deviceId: idOf(viewer), name: 'Laptop' });
  });

  test('a viewer that does not serve still pairs; the host just has no code to dial back', async () => {
    const relay = new FakeRelay();
    const reg = new TransportRegistry();
    const host = makeNode(relay, reg, 'host');
    const viewer = makeNode(relay, reg, 'viewer');
    await host.p2p.start();
    await viewer.p2p.start();
    await viewer.p2p.api.setSettings({ deviceName: 'Laptop', serveEnabled: false });
    expect((await pair(host, viewer)).result).toEqual({ ok: true });
    await waitFor(() => known(host).length === 1);
    expect(known(host)[0]!.code).toBeUndefined();
  });

  test('the pair modal code is the host code: joining your own code is refused, unknown codes are denied by the relay', async () => {
    const relay = new FakeRelay();
    const n = makeNode(relay, new TransportRegistry(), 'a');
    await n.p2p.start();
    const code = await hostCode(n);
    await expect(n.p2p.api.redeemPairCode(code)).resolves.toEqual({ ok: false, error: 'own_code' });
    await expect(n.p2p.api.redeemPairCode('not a code!')).resolves.toEqual({ ok: false, error: 'invalid_code' });
    await expect(n.p2p.api.redeemPairCode('999999999')).resolves.toEqual({ ok: false, error: 'host offline' });
  });

  test('a code is single-use: once consumed the window is closed, so a second join fails the handshake', async () => {
    const relay = new FakeRelay();
    const reg = new TransportRegistry();
    const host = makeNode(relay, reg, 'host', { handshakeTimeoutMs: 1000 });
    const viewer = makeNode(relay, reg, 'viewer');
    await host.p2p.start();
    await viewer.p2p.start();
    await viewer.p2p.api.setSettings({ serveEnabled: false });
    const { code, result } = await pair(host, viewer);
    expect(result).toEqual({ ok: true });
    expect(host.services.p2p!.pairing.active).toBe(false);
    // No window: the host runs a normal (unprefixed) handshake, which cannot match the viewer's pairing prologue.
    await expect(viewer.p2p.api.redeemPairCode(code)).resolves.toEqual({ ok: false, error: 'handshake_failed' });
    expect(known(host)).toHaveLength(1);
  });

  test('a failed pairing handshake spends one attempt of the host budget (a trusted peer dialling during an open window)', async () => {
    const relay = new FakeRelay();
    const reg = new TransportRegistry();
    const host = makeNode(relay, reg, 'host', { handshakeTimeoutMs: 1000 });
    const viewer = makeNode(relay, reg, 'viewer');
    await host.p2p.start();
    await viewer.p2p.start();
    await viewer.p2p.api.setSettings({ serveEnabled: false });
    expect((await pair(host, viewer)).result).toEqual({ ok: true });
    await waitFor(() => known(host).length === 1);
    // A fresh window is open; the (already trusted) viewer connects normally, so its handshake has no pairing prologue.
    host.p2p.api.generatePairCode();
    expect(host.services.p2p!.pairing.attempts).toBe(0);
    await expect(viewer.p2p.api.rpcCall(idOf(host), 'device.info', {})).rejects.toThrow();
    await waitFor(() => host.services.p2p!.pairing.attempts === 1);
  });

  test('prologue is bound to code AND session id: a different session id fails the handshake', async () => {
    const hostKey = loadOrCreateDeviceKey(join(mkdtempSync(join(tmpdir(), 'k1-')), 'k'));
    const viewerKey = loadOrCreateDeviceKey(join(mkdtempSync(join(tmpdir(), 'k2-')), 'k'));
    const run = (code: string, session: string) => {
      const [ta, tb] = pairedTransports();
      return Promise.allSettled([
        doNoiseXxHandshake({ transport: tb as never, role: 'host', localKey: hostKey, prologue: pairingPrologue('123456789', 's1'), timeoutMs: 300 }),
        doNoiseXxHandshake({ transport: ta as never, role: 'viewer', localKey: viewerKey, prologue: pairingPrologue(code, session), timeoutMs: 300 }),
      ]);
    };
    for (const [code, session] of [['123456780', 's1'], ['123456789', 's2']] as const) {
      const bad = await run(code, session);
      expect(bad.map((r) => r.status)).toEqual(['rejected', 'rejected']);
      expect(String((bad[1] as PromiseRejectedResult).reason.message)).toMatch(/handshake_failed/);
    }
    const [ta2, tb2] = pairedTransports();
    const ok = await Promise.allSettled([
      doNoiseXxHandshake({ transport: tb2 as never, role: 'host', localKey: hostKey, prologue: pairingPrologue('123456789', 's1') }),
      doNoiseXxHandshake({ transport: ta2 as never, role: 'viewer', localKey: viewerKey, prologue: pairingPrologue(' 123456789 ', 's1') }),
    ]);
    expect(ok.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
  });
});

describe('fleet online heuristic', () => {
  test('online = host connection up AND a session completed within ONLINE_GRACE_MS (or a live session)', async () => {
    let clock = 1_000_000;
    const relay = new FakeRelay();
    const reg = new TransportRegistry();
    const host = makeNode(relay, reg, 'host', { now: () => clock });
    const viewer = makeNode(relay, reg, 'viewer');
    await host.p2p.start();
    await viewer.p2p.start();
    await viewer.p2p.api.setSettings({ serveEnabled: false });
    expect((await pair(host, viewer)).result).toEqual({ ok: true });
    await waitFor(() => known(host).length === 1);
    expect((await host.p2p.api.fleetList())[0]!.online).toBe(true); // paired just now, no live session left
    clock += ONLINE_GRACE_MS - 1;
    expect((await host.p2p.api.fleetList())[0]!.online).toBe(true);
    clock += 2;
    expect((await host.p2p.api.fleetList())[0]!.online).toBe(false);
    // the viewer runs no host connection, so it never claims a device is online from the grace window alone
    expect((await viewer.p2p.api.fleetList())[0]!.online).toBe(false);
  });
});

describe('paired sessions', () => {
  async function pairedFleet() {
    const relay = new FakeRelay();
    const reg = new TransportRegistry();
    const host = makeNode(relay, reg, 'host', { auditLogPath: undefined });
    const viewer = makeNode(relay, reg, 'viewer');
    await host.p2p.start();
    await viewer.p2p.start();
    await viewer.p2p.api.setSettings({ serveEnabled: false });
    const { result } = await pair(host, viewer);
    expect(result).toEqual({ ok: true });
    await waitFor(() => known(host).length === 1);
    return { relay, reg, host, viewer };
  }

  test('a session_invite wires the hub: remote shells.list resolves through the paired peer', async () => {
    const { host, viewer } = await pairedFleet();
    await expect(viewer.p2p.api.rpcCall(idOf(host), 'shells.list', { projectId: 1 })).resolves.toEqual([]);
    await expect(viewer.p2p.api.rpcCall(idOf(host), 'device.info', {})).resolves.toMatchObject({ platform: process.platform });
    expect((await viewer.p2p.api.fleetList())[0]!.online).toBe(true);
  });

  test('audit log records invalid_params rejections (onCall hook)', async () => {
    const { host, viewer } = await pairedFleet();
    await expect(viewer.p2p.api.rpcCall(idOf(host), 'projects.get', { id: -1 })).rejects.toMatchObject({ code: 'invalid_params' });
    const log = join(host.home, '.metaide', 'logs', 'p2p-audit.log');
    await waitFor(() => existsSync(log));
    const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toContainEqual(expect.objectContaining({ method: 'projects.get', outcome: { error: 'invalid_params' }, remoteDeviceId: idOf(viewer) }));
  });

  test('revoke-device removes the pub, drops the live session and refuses future handshakes from it', async () => {
    const { host, viewer } = await pairedFleet();
    await viewer.p2p.api.rpcCall(idOf(host), 'device.info', {}); // live connection exists
    const logPath = join(host.home, '.metaide', 'logs', 'p2p-audit.log');
    const served = () => readFileSync(logPath, 'utf8').trim().split('\n').length;
    const before = served();

    await host.p2p.api.revokeDevice(idOf(viewer));
    expect(known(host)).toEqual([]);
    expect(host.services.db.prepare('SELECT 1 FROM devices WHERE id = ?').get(idOf(viewer))).toBeUndefined();
    // the host tore the session down, so the viewer's connection goes away
    const deadline = Date.now() + 3000;
    while ((await viewer.p2p.api.fleetList())[0]!.online && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect((await viewer.p2p.api.fleetList())[0]!.online).toBe(false);

    // a fresh handshake from the revoked pub completes cryptographically but the host refuses to serve it
    await expect(viewer.p2p.api.rpcCall(idOf(host), 'device.info', {})).rejects.toThrow();
    expect(served()).toBe(before);
  });

  test('a rejected (non-reliable) data channel finishes the link as channel_not_reliable, not after 30 s', async () => {
    const relay = new FakeRelay();
    const reg = new TransportRegistry();
    const host = makeNode(relay, reg, 'host');
    const viewer = makeNode(relay, reg, 'viewer');
    await host.p2p.start();
    await viewer.p2p.start();
    await viewer.p2p.api.setSettings({ serveEnabled: false });
    await hostCode(host);
    const { code } = host.p2p.api.generatePairCode();
    const started = Date.now();
    // listeners are attached synchronously after creation, so a microtask-delayed emit lands mid-negotiation
    reg.onCreate = (t) => { if (t.role === 'viewer') queueMicrotask(() => t.emit('error', new Error('data channel must be ordered and reliable'))); };
    const p = viewer.p2p.api.redeemPairCode(code);
    await expect(p).resolves.toEqual({ ok: false, error: 'channel_not_reliable' });
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('natural stream end is reported to the renderer as closed/remote_ended', async () => {
    const { host, viewer } = await pairedFleet();
    const pty = host.services.ptyManager;
    vi.spyOn(pty, 'isAlive').mockReturnValue(true);
    vi.spyOn(pty, 'getSnapshot').mockResolvedValue('snapshot');
    const r = (await viewer.p2p.api.rpcCall(idOf(host), 'shells.attach', { projectId: 1, shellIndex: 0 })) as { streamId: number };
    await waitFor(() => viewer.events.length >= 1); // snapshot replay
    pty.emit('exit', { projectId: 1, shellIndex: 0, code: 0 });
    await waitFor(() => viewer.events.length >= 3);
    expect(viewer.events).toEqual([
      expect.objectContaining({ streamId: r.streamId, data: { kind: 'out', bytes: 'snapshot' } }),
      expect.objectContaining({ streamId: r.streamId, data: { kind: 'exit', code: 0 } }),
      { deviceId: idOf(host), streamId: r.streamId, closed: true, reason: 'remote_ended' },
    ]);
    // the stream is gone: a later explicit close is a harmless no-op and nothing more is emitted
    viewer.p2p.api.rpcCloseStream(r.streamId);
    await new Promise((res) => setTimeout(res, 30));
    expect(viewer.events).toHaveLength(3);
  });

  describe('stream close reason on link drop', () => {
    async function dropWith(status: McStatus) {
      const { host, viewer, reg } = await pairedFleet();
      const pty = host.services.ptyManager;
      vi.spyOn(pty, 'isAlive').mockReturnValue(true);
      vi.spyOn(pty, 'getSnapshot').mockResolvedValue('snapshot');
      const r = (await viewer.p2p.api.rpcCall(idOf(host), 'shells.attach', { projectId: 1, shellIndex: 0 })) as { streamId: number };
      await waitFor(() => viewer.events.length >= 1);
      viewer.clients.filter((c) => c.cfg.role === 'viewer').at(-1)!.status = status;
      reg.all.find((t) => t.role === 'viewer' && !t.closed)!.emit('close');
      await waitFor(() => viewer.events.some((e) => (e as { closed?: boolean }).closed === true));
      return viewer.events.find((e) => (e as { closed?: boolean }).closed === true);
    }

    test('transport close while McClient is connected reports reason reconnecting', async () => {
      expect(await dropWith('connected')).toEqual(expect.objectContaining({ closed: true, reason: 'reconnecting' }));
    });

    test('transport close while McClient is down keeps the terminal reason', async () => {
      expect(await dropWith('disconnected')).toEqual(expect.objectContaining({ closed: true, reason: 'transport_closed' }));
    });
  });

  test('pendingMessages: a data frame delivered in the same burst as handshake message 3 is not dropped', async () => {
    // Batching transport: everything sent in one tick is delivered synchronously in one burst, so the
    // data frame lands in the handshake mailbox right behind message 3 (the first-frame race).
    class Batch extends EventEmitter {
      peer!: Batch;
      buf: Uint8Array[] = [];
      scheduled = false;
      send(b: Uint8Array) {
        const p = this.peer;
        p.buf.push(b);
        if (!p.scheduled) { p.scheduled = true; setImmediate(() => { p.scheduled = false; const q = p.buf.splice(0); for (const m of q) p.emit('message', m); }); }
      }
      close() { this.emit('close'); }
    }
    const ta = new Batch(); const tb = new Batch(); ta.peer = tb; tb.peer = ta;
    const hostKey = loadOrCreateDeviceKey(join(mkdtempSync(join(tmpdir(), 'k1-')), 'k'));
    const viewerKey = loadOrCreateDeviceKey(join(mkdtempSync(join(tmpdir(), 'k2-')), 'k'));
    const hostHs = doNoiseXxHandshake({ transport: tb as never, role: 'host', localKey: hostKey });
    const viewerHs = doNoiseXxHandshake({ transport: ta as never, role: 'viewer', localKey: viewerKey });
    // viewer completes right after sending message 3, then immediately sends an RPC request
    const vNoise = await viewerHs;
    const viewerSecure = new SecureTransport(ta as never, vNoise);
    const client = new RpcPeer(viewerSecure.asRpcTransport());
    client.on('error', () => {});
    viewerSecure.start();
    const pending = client.call('device.info', {});
    // host: await, then attach synchronously (the contract)
    const hNoise = await hostHs;
    const hostSecure = new SecureTransport(tb as never, hNoise);
    expect(hNoise.pendingMessages).toHaveLength(1); // the data frame rode in behind message 3
    const server = new RpcPeer(hostSecure.asRpcTransport());
    server.on('error', () => {});
    server.handle('device.info', async () => ({ name: 'n', platform: 'p', version: '1', uptime: 1 }));
    hostSecure.start();
    await expect(pending).resolves.toMatchObject({ name: 'n' });
  });
});

describe('helpers', () => {
  test('parseSessionToken accepts objects and JWT-like strings, rejects junk', () => {
    expect(parseSessionToken({ iat: 1, exp: 2 })).toEqual({ iat: 1000, exp: 2000 });
    expect(parseSessionToken({ iat: 1_700_000_000_000, exp: 1_700_000_100_000 })).toEqual({ iat: 1_700_000_000_000, exp: 1_700_000_100_000 });
    const body = Buffer.from(JSON.stringify({ iat: 10, exp: 20 })).toString('base64url');
    expect(parseSessionToken(`h.${body}.s`)).toEqual({ iat: 10_000, exp: 20_000 });
    expect(parseSessionToken('opaque')).toBeNull();
    // mrsignald's opaque 32-hex token carries no timestamps: validity is synthesised from now
    expect(parseSessionToken('ab'.repeat(16), 5_000)).toEqual({ iat: 5_000, exp: 5_000 + 600_000 });
    expect(parseSessionToken(undefined)).toBeNull();
  });

  test('pairingPrologue is a 32-byte digest, stable under whitespace, distinct per code and per session', () => {
    const p = pairingPrologue('123456789', 's1');
    expect(p).toHaveLength(32);
    expect(Buffer.from(pairingPrologue(' 123456789 ', 's1'))).toEqual(Buffer.from(p));
    expect(Buffer.from(pairingPrologue('123456789', 's2'))).not.toEqual(Buffer.from(p));
    expect(Buffer.from(pairingPrologue('123456788', 's1'))).not.toEqual(Buffer.from(p));
  });

  test('known device helper used by trust: addKnownDevice canonicalizes', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'kd-')), 'k.json');
    tmps.push(f);
    addKnownDevice('ff'.repeat(32), 'x', f);
    expect(loadKnownDevices(f)[0]!.pub).toBe('ff'.repeat(31) + '7f');
    void encodeFrame;
  });
});
