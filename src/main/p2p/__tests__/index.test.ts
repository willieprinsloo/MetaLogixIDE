import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

vi.mock('electron', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  app: { getVersion: () => '9.9.9-test' },
  clipboard: { readImage: () => ({ isEmpty: () => true }) },
}));

import { createP2P, parseSessionToken, pairRendezvous, type P2PHandle, type SignalingClient } from '../index';
import { buildServices, type Services } from '../../services';
import { loadKnownDevices, addKnownDevice, canonicalPubHex } from '../identity';
import { doNoiseXxHandshake, enrollmentPrologue } from '../pairing';
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

/** Routes signaling between fake clients like a (very) small MetaConnect. Ignores rendezvous codes by design. */
class FakeRelay {
  clients = new Map<string, FakeClient>();
  hosts: FakeClient[] = [];
  sessions = new Map<string, { host: FakeClient; viewer: FakeClient }>();
  seq = 0;
  sent: Array<{ from: string; env: Envelope }> = [];

  newClient(name: string): FakeClient {
    const c = new FakeClient(name, this);
    this.clients.set(name, c);
    return c;
  }

  route(from: FakeClient, env: Envelope): void {
    this.sent.push({ from: from.name, env });
    const d = (env.data ?? {}) as { session?: string; pairing?: boolean; code?: string };
    const deliver = (to: FakeClient, e: Envelope) => queueMicrotask(() => { to.emit('envelope', e); });
    const token = { iat: Date.now(), exp: Date.now() + 60_000 };
    switch (env.type) {
      case 'register':
        this.hosts.push(from);
        return;
      case 'session_request': {
        const host = this.hosts.find((h) => h.name !== from.name && h.status === 'connected');
        if (!host) return deliver(from, { type: 'session_denied', data: { reason: 'no_host' } });
        this.hosts.splice(this.hosts.indexOf(host), 1);
        const session = `s${++this.seq}`;
        this.sessions.set(session, { host, viewer: from });
        deliver(host, { type: 'session_invite', data: { session, operator: 'op', requiresKey: false, iceServers: [], token, pairing: d.pairing === true } });
        deliver(from, { type: 'session_granted', data: { session, host: host.name, hostFingerprint: 'f', iceServers: [], token } });
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
  constructor(readonly name: string, readonly relay: FakeRelay) { super(); }
  async start() {
    this.started++;
    queueMicrotask(() => { this.status = 'connected'; this.emit('status', 'connected'); });
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

interface Node { name: string; home: string; services: Services; p2p: P2PHandle; client: () => FakeClient | undefined; events: unknown[] }

let tmps: string[] = [];
let nodes: Node[] = [];

function makeNode(relay: FakeRelay, reg: TransportRegistry, name: string, extra: Partial<Parameters<typeof createP2P>[1]> = {}, token: string | null = 'tok'): Node {
  const home = mkdtempSync(join(tmpdir(), `p2p-${name}-`));
  tmps.push(home);
  const services = buildServices({ homeDir: home, migrationsDir });
  const events: unknown[] = [];
  let client: FakeClient | undefined;
  const p2p = createP2P(services, {
    homeDir: home,
    readToken: () => token,
    createClient: () => (client = relay.newClient(name)),
    createTransport: (role) => new FakeTransport(role, reg) as unknown as WebRtcTransport,
    emit: (_c, p) => events.push(p),
    appVersion: '9.9.9-test',
    ...extra,
  });
  const node = { name, home, services, p2p, client: () => client, events };
  nodes.push(node);
  return node;
}

const idOf = (n: Node) => canonicalPubHex(n.services.p2p!.deviceKey.pub);
const known = (n: Node) => loadKnownDevices(join(n.home, '.metaide', 'known_devices.json'));

/** Pairs viewer -> host (host trusts viewer, viewer trusts host). */
async function pair(host: Node, viewer: Node) {
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
    expect(relay.clients.size).toBe(0);
    // flipping it on at runtime brings the client up and registers the host
    await n.p2p.api.setSettings({ serveEnabled: true });
    await waitFor(() => relay.hosts.length === 1);
    expect(n.client()?.started).toBe(1);
  });

  test('no agent token: dormant, no client', async () => {
    const relay = new FakeRelay();
    const n = makeNode(relay, new TransportRegistry(), 'a', {}, null);
    await n.p2p.start();
    expect(relay.clients.size).toBe(0);
    await expect(n.p2p.api.fleetList()).resolves.toEqual([]);
  });

  test('Register carries HostCapabilities (version, fingerprint, no monitors)', async () => {
    const relay = new FakeRelay();
    const n = makeNode(relay, new TransportRegistry(), 'a');
    await n.p2p.start();
    await waitFor(() => relay.sent.some((s) => s.env.type === 'register'));
    expect(relay.sent.find((s) => s.env.type === 'register')!.env.data).toEqual({
      agentVersion: '9.9.9-test',
      hostFingerprint: n.services.p2p!.deviceKey.fingerprint,
      monitors: [],
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
  test('happy path: both sides end up in each other\'s known_devices.json', async () => {
    const relay = new FakeRelay();
    const reg = new TransportRegistry();
    const host = makeNode(relay, reg, 'host');
    const viewer = makeNode(relay, reg, 'viewer');
    await host.p2p.start();
    await viewer.p2p.start();
    await host.p2p.api.setSettings({ deviceName: 'Tower' });
    await viewer.p2p.api.setSettings({ deviceName: 'Laptop', serveEnabled: false });
    await waitFor(() => relay.hosts.length >= 1);

    const { result } = await pair(host, viewer);
    expect(result).toEqual({ ok: true });
    expect(known(viewer)).toEqual([expect.objectContaining({ pub: idOf(host), name: 'Tower' })]);
    await waitFor(() => known(host).length === 1);
    expect(known(host)).toEqual([expect.objectContaining({ pub: idOf(viewer), name: 'Laptop' })]);
    expect((await host.p2p.api.fleetList())[0]).toMatchObject({ deviceId: idOf(viewer), name: 'Laptop' });
  });

  test('a code is single-use: the second redemption reports code_consumed', async () => {
    const relay = new FakeRelay();
    const reg = new TransportRegistry();
    const host = makeNode(relay, reg, 'host');
    const viewer = makeNode(relay, reg, 'viewer');
    await host.p2p.start();
    await viewer.p2p.start();
    await viewer.p2p.api.setSettings({ serveEnabled: false });
    await waitFor(() => relay.hosts.length >= 1);
    const { code, result } = await pair(host, viewer);
    expect(result).toEqual({ ok: true });
    await waitFor(() => relay.hosts.length >= 1); // host re-armed
    await expect(viewer.p2p.api.redeemPairCode(code)).resolves.toEqual({ ok: false, error: 'code_consumed' });
  });

  test('attempt limit: after 5 wrong codes even the right code is refused (attempts_exceeded)', async () => {
    const relay = new FakeRelay();
    const reg = new TransportRegistry();
    const host = makeNode(relay, reg, 'host', { handshakeTimeoutMs: 2000 });
    const viewer = makeNode(relay, reg, 'viewer');
    await host.p2p.start();
    await viewer.p2p.start();
    await viewer.p2p.api.setSettings({ serveEnabled: false });
    const { code } = host.p2p.api.generatePairCode();
    for (let i = 0; i < 5; i++) {
      await waitFor(() => relay.hosts.length >= 1);
      const r = await viewer.p2p.api.redeemPairCode('able able able able able able');
      expect(r).toEqual({ ok: false, error: 'handshake_failed' });
      await waitFor(() => host.services.p2p!.pairing.attempts === i + 1);
    }
    await waitFor(() => relay.hosts.length >= 1);
    await expect(viewer.p2p.api.redeemPairCode(code)).resolves.toEqual({ ok: false, error: 'attempts_exceeded' });
    expect(known(host)).toEqual([]);
  });

  test('prologue is bound to the normalized code: a tampered code fails the handshake', async () => {
    const [ta, tb] = pairedTransports();
    const hostKey = loadOrCreateDeviceKey(join(mkdtempSync(join(tmpdir(), 'k1-')), 'k'));
    const viewerKey = loadOrCreateDeviceKey(join(mkdtempSync(join(tmpdir(), 'k2-')), 'k'));
    const run = (code: string) =>
      Promise.allSettled([
        doNoiseXxHandshake({ transport: tb as never, role: 'host', localKey: hostKey, prologue: enrollmentPrologue('one two three four five six'), timeoutMs: 300 }),
        doNoiseXxHandshake({ transport: ta as never, role: 'viewer', localKey: viewerKey, prologue: enrollmentPrologue(code), timeoutMs: 300 }),
      ]);
    const bad = await run('one two three four five seven');
    expect(bad.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(String((bad[1] as PromiseRejectedResult).reason.message)).toMatch(/handshake_failed/);
    const [ta2, tb2] = pairedTransports();
    const ok = await Promise.allSettled([
      doNoiseXxHandshake({ transport: tb2 as never, role: 'host', localKey: hostKey, prologue: enrollmentPrologue('one two three four five six') }),
      // cosmetic differences normalize away
      doNoiseXxHandshake({ transport: ta2 as never, role: 'viewer', localKey: viewerKey, prologue: enrollmentPrologue('  ONE two  three four five SIX ') }),
    ]);
    expect(ok.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
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
    await waitFor(() => relay.hosts.length >= 1);
    const { result } = await pair(host, viewer);
    expect(result).toEqual({ ok: true });
    await waitFor(() => known(host).length === 1 && relay.hosts.length >= 1);
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
    await waitFor(() => relay.hosts.length >= 1);
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
    expect(parseSessionToken(undefined)).toBeNull();
  });

  test('pairRendezvous hides the code and is normalization-stable', () => {
    const r = pairRendezvous('Able  Baker');
    expect(r).toBe(pairRendezvous(' able baker '));
    expect(r).not.toContain('able');
  });

  test('known device helper used by trust: addKnownDevice canonicalizes', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'kd-')), 'k.json');
    tmps.push(f);
    addKnownDevice('ff'.repeat(32), 'x', f);
    expect(loadKnownDevices(f)[0]!.pub).toBe('ff'.repeat(31) + '7f');
    void encodeFrame;
  });
});
