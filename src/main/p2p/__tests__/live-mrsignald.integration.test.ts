/**
 * Live interop: two metaIDE P2P runtimes (host + viewer roles, real McClient over TCP) against a REAL mrsignald
 * process. Signaling, identity minting/reclaim, session brokering and Noise/RPC all run for real; only the WebRTC data
 * channel is replaced by an in-memory pair (the real one needs an Electron renderer worker, which cannot run under
 * ELECTRON_RUN_AS_NODE).
 *
 *   METAIDE_P2P_LIVE_INTEGRATION=1 ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *     src/main/p2p/__tests__/live-mrsignald.integration.test.ts
 *
 * Binary: $METAIDE_MRSIGNALD, default <metaconnect>/bin/mrsignald (cd metaconnect && go build -o bin/mrsignald ./cmd/mrsignald).
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

vi.mock('electron', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  app: { getVersion: () => '9.9.9-live' },
  clipboard: { readImage: () => ({ isEmpty: () => true }) },
}));

import { createP2P, type P2PHandle } from '../index';
import { buildServices, type Services } from '../../services';
import { runMigrations } from '../../db/migrator';
import { canonicalPubHex, loadKnownDevices } from '../identity';
import { loadHostIdentity } from '../host-identity';
import type { WebRtcTransport } from '../transport';
import { waitFor } from './_mockRelay';

const LIVE = process.env.METAIDE_P2P_LIVE_INTEGRATION === '1';
const MRSIGNALD = process.env.METAIDE_MRSIGNALD ?? '/Users/wlprinsloo/Documents/Projects/metaconnect/bin/mrsignald';
const migrationsDir = resolve(__dirname, '../../../../migrations');

/** In-memory data channel pair; SDP strings are exchanged for real through mrsignald. */
class Registry { byOffer = new Map<string, FakeTransport>(); n = 0; }
class FakeTransport extends EventEmitter {
  peer: FakeTransport | null = null;
  closed = false;
  id = '';
  constructor(readonly role: 'host' | 'viewer', readonly reg: Registry) { super(); }
  async openDataChannel() {}
  async createOffer() { this.id = String(++this.reg.n); this.reg.byOffer.set(this.id, this); return `offer:${this.id}`; }
  async createAnswer(sdp: string) { const h = this.reg.byOffer.get(sdp.slice(6))!; this.peer = h; h.peer = this; return `answer:${h.id}`; }
  async setRemoteDescription(sdp: string) { if (sdp.startsWith('answer:')) queueMicrotask(() => { this.emit('open'); this.peer?.emit('open'); }); }
  async addIceCandidate() {}
  send(b: Uint8Array) { const p = this.peer; if (p && !this.closed) queueMicrotask(() => p.emit('message', b)); }
  close() { if (this.closed) return; this.closed = true; queueMicrotask(() => { this.emit('close'); this.peer?.close(); }); }
}

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
    s.on('error', rej);
  });

async function waitForPort(port: number, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    const ok = await new Promise<boolean>((r) => { const c = net.connect(port, '127.0.0.1', () => { c.destroy(); r(true); }); c.on('error', () => r(false)); });
    if (ok) return;
    if (Date.now() > end) throw new Error('mrsignald did not start');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!LIVE)('live mrsignald interop', () => {
  let relay: ChildProcess;
  let relayLog = '';
  let port = 0;
  let work = '';
  const reg = new Registry();
  interface Node { home: string; services: Services; p2p: P2PHandle }
  const nodes: Node[] = [];

  function makeNode(name: string): Node {
    const home = mkdtempSync(join(work, `${name}-`));
    const services = buildServices({ homeDir: home, migrationsDir });
    runMigrations(services.db, migrationsDir);
    services.db.prepare('UPDATE p2p_settings SET relay_url = ?, relay_port = ?, device_name = ?, serve_enabled = 1 WHERE id = 1').run('127.0.0.1', port, name);
    const p2p = createP2P(services, {
      homeDir: home,
      relayTls: { plaintext: true }, // local mrsignald without -tls-cert
      createTransport: (role) => new FakeTransport(role, reg) as unknown as WebRtcTransport,
      appVersion: '9.9.9-live',
    });
    const n = { home, services, p2p };
    nodes.push(n);
    return n;
  }
  const idFile = (n: Node) => join(n.home, '.metaide', 'host-identity.json');

  beforeAll(async () => {
    expect(existsSync(MRSIGNALD), `mrsignald binary at ${MRSIGNALD}`).toBe(true);
    work = mkdtempSync(join(tmpdir(), 'mide-live-'));
    port = await freePort();
    relay = spawn(MRSIGNALD, ['-addr', `127.0.0.1:${port}`, '-code-store', join(work, 'codes.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
    relay.stdout?.on('data', (b: Buffer) => { relayLog += b; });
    relay.stderr?.on('data', (b: Buffer) => { relayLog += b; });
    await waitForPort(port);
  }, 20_000);

  afterAll(async () => {
    for (const n of nodes) await n.p2p.stop().catch(() => {});
    relay?.kill('SIGTERM');
    if (process.env.METAIDE_LIVE_VERBOSE) console.log(relayLog);
    if (work) rmSync(work, { recursive: true, force: true });
  });

  test('mint -> pair-code -> join -> remote shells.list, then host restart reclaims its code', async () => {
    const host = makeNode('Tower');
    const viewer = makeNode('Laptop');
    await host.p2p.start();
    await viewer.p2p.start();

    // 1. The relay mints each host a code; it is persisted 0600.
    await waitFor(() => existsSync(idFile(host)) && existsSync(idFile(viewer)), 10_000);
    const hostId = loadHostIdentity(idFile(host))!;
    const viewerId = loadHostIdentity(idFile(viewer))!;
    expect(hostId.code).toMatch(/^\d{9}$/);
    expect(viewerId.code).not.toBe(hostId.code);
    expect(statSync(idFile(host)).mode & 0o777).toBe(0o600);
    // the relay stores only a hash of the secret
    const store = JSON.parse(readFileSync(join(work, 'codes.json'), 'utf8')) as Record<string, string>;
    expect(Object.keys(store)).toEqual(expect.arrayContaining([hostId.code, viewerId.code]));
    expect(JSON.stringify(store)).not.toContain(hostId.secret);

    // 2. Pair: host shows its connect code, viewer joins it (a real viewer connection -> session_request -> granted).
    await waitFor(() => { try { return host.p2p.api.generatePairCode().code === hostId.code; } catch { return false; } }, 10_000);
    const { code } = host.p2p.api.generatePairCode();
    expect(code).toBe(hostId.code);
    await expect(viewer.p2p.api.redeemPairCode(code)).resolves.toEqual({ ok: true });

    const hostPub = canonicalPubHex(host.services.p2p!.deviceKey.pub);
    const viewerPub = canonicalPubHex(viewer.services.p2p!.deviceKey.pub);
    const kv = loadKnownDevices(join(viewer.home, '.metaide', 'known_devices.json'));
    expect(kv).toEqual([expect.objectContaining({ pub: hostPub, name: 'Tower', code: hostId.code })]);
    await waitFor(() => loadKnownDevices(join(host.home, '.metaide', 'known_devices.json')).length === 1);
    expect(loadKnownDevices(join(host.home, '.metaide', 'known_devices.json'))).toEqual([expect.objectContaining({ pub: viewerPub, name: 'Laptop', code: viewerId.code })]);

    // 3. A fresh viewer session to the paired host; remote RPC over Noise.
    const list = await viewer.p2p.api.rpcCall(hostPub, 'shells.list', { projectId: 1 });
    expect(Array.isArray(list)).toBe(true);
    const info = await viewer.p2p.api.rpcCall(hostPub, 'device.info', {});
    expect(info).toMatchObject({ platform: process.platform });

    // 4. Restart the host: it must present (code, secret) and keep the SAME code (no new assign_code).
    await host.p2p.stop();
    const host2 = createP2P(host.services, {
      homeDir: host.home,
      relayTls: { plaintext: true },
      createTransport: (role) => new FakeTransport(role, reg) as unknown as WebRtcTransport,
      appVersion: '9.9.9-live',
    });
    nodes.push({ home: host.home, services: host.services, p2p: host2 });
    await host2.start();
    expect(loadHostIdentity(idFile(host))).toEqual(hostId);
    // the viewer's old connection died with the old host; dialling by the unchanged code works again
    let again: unknown;
    for (const deadline = Date.now() + 15_000; !Array.isArray(again) && Date.now() < deadline; ) {
      again = await viewer.p2p.api.rpcCall(hostPub, 'shells.list', { projectId: 1 }).catch(() => undefined);
      if (!Array.isArray(again)) await new Promise((r) => setTimeout(r, 200));
    }
    expect(Array.isArray(again)).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(join(work, 'codes.json'), 'utf8')))).toHaveLength(2); // no third code minted
  }, 60_000);
});
