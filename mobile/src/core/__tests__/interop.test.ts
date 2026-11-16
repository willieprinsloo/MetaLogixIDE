/**
 * Runs the phone's protocol core against the desktop's real implementation (Noise responder,
 * SecureTransport, RpcPeer, PairingSession) over an in-memory relay and data channel. Run from the
 * repo root: `pnpm test mobile/src/core`.
 */
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { doNoiseXxHandshake } from '../../../../src/main/p2p/pairing';
import { PairingSession } from '../../../../src/main/p2p/pairing-session';
import { SecureTransport } from '../../../../src/main/p2p/secure';
import { RpcError as HostRpcError, RpcPeer } from '../../../../src/main/p2p/rpc';
import { canonicalPubHex as hostCanonical } from '../../../../src/main/p2p/identity';
import { Secret, createFrameDecoder, encodeFrame } from '../../../../src/shared/signaling-wire';
import { activeProjects, Fleet, type FleetState, type Storage } from '../fleet';
import { connect, pairWith, type Peer, type Platform, type RelaySocket } from '../link';
import { canonicalPubHex, deviceKeyFromSeed } from '../noise';

const HOST_CODE = 'ABCD-1234';
const enc = new TextEncoder();
const dec = new TextDecoder();

class Chan extends EventEmitter {
  other!: Chan;
  closed = false;
  send(bytes: Uint8Array): void {
    if (this.closed) return;
    const copy = new Uint8Array(bytes);
    setTimeout(() => { if (!this.other.closed) this.other.emit('message', copy); }, 0);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
    setTimeout(() => this.other.close(), 0);
  }
}

class FakePeer extends Chan {
  async answer(offer: string): Promise<string> { return `answer-to:${offer}`; }
  async addCandidate(): Promise<void> {}
}

type HostSession = { chan: Chan; sessionId: string };

/** A desktop: identity, pairing window, trusted set, and RPC handlers, behind a fake relay. */
function makeHost(name = 'Studio') {
  const seed = new Uint8Array(randomBytes(32));
  const key = { pub: ed25519.getPublicKey(seed), priv: new Secret(seed) };
  const pairing = new PairingSession();
  const trusted = new Map<string, string>();
  const input: string[] = [];
  const sizes: Array<[number, number]> = [];
  const peers: RpcPeer[] = [];
  const hellos: unknown[] = [];
  let projects = [{ id: 1, name: 'alpha', path: '/p/alpha', extra: true }, { id: 2, name: 'beta', path: '/p/beta' }];
  let shells: Array<{ projectId: number; shellIndex: number; agentState?: 'idle' | 'busy' | 'blocked' | null }> = [
    { projectId: 2, shellIndex: 0, agentState: 'idle' }, { projectId: 2, shellIndex: 1, agentState: 'blocked' },
  ];
  let seq = 0;
  let denyReason: string | null = null;

  async function serve({ chan, sessionId }: HostSession): Promise<void> {
    const isPairing = pairing.active;
    let prologue: Uint8Array | undefined;
    if (isPairing) {
      const b = pairing.begin(sessionId);
      if (!b.ok) { chan.close(); return; }
      prologue = b.prologue;
    }
    let noise;
    try {
      noise = await doNoiseXxHandshake({ transport: chan as never, role: 'host', localKey: key, prologue, timeoutMs: 2000 });
    } catch {
      if (isPairing) pairing.settle(false);
      return;
    }
    const secure = new SecureTransport(chan as never, noise);
    const remote = hostCanonical(noise.remotePub);
    if (isPairing) {
      pairing.settle(true);
      secure.on('message', (m: Uint8Array) => {
        const j = JSON.parse(dec.decode(m)) as { hello: string };
        hellos.push(j);
        trusted.set(remote, j.hello);
      });
      secure.start();
      secure.send(enc.encode(JSON.stringify({ hello: name, code: HOST_CODE })));
      return;
    }
    if (!trusted.has(remote)) { secure.close(); return; }
    const rpc = new RpcPeer(secure.asRpcTransport());
    rpc.on('error', () => {});
    peers.push(rpc);
    const attached = new Set<number>();
    rpc.handle('projects.list', async () => projects as never);
    rpc.handle('shells.alive', async () => shells);
    rpc.handle('shells.attach', ({ projectId, shellIndex }, ctx) => {
      if (!shells.some((s) => s.projectId === projectId && s.shellIndex === shellIndex)) throw new HostRpcError('unknown_shell', 'no such shell');
      attached.add(ctx.stream!);
      return (async function* () {
        yield { kind: 'out', bytes: 'snapshot ' };
        yield { kind: 'out', bytes: 'x'.repeat(40_000) };
        yield { kind: 'out', bytes: ' héllo → 🙂' };
        await new Promise((r) => setTimeout(r, 30));
        yield { kind: 'exit', code: 0 };
      })();
    });
    rpc.handle('shells.input', async ({ stream, bytes }) => {
      if (!attached.has(stream)) throw new HostRpcError('unknown_stream', 'stream not attached');
      input.push(Buffer.from(bytes, 'base64').toString('utf8'));
      return { ok: true } as const;
    });
    rpc.handle('shells.resize', async ({ cols, rows }) => { sizes.push([cols, rows]); return { ok: true } as const; });
    secure.start();
  }

  const platform: Platform = {
    connect(): RelaySocket {
      const decoder = createFrameDecoder();
      let onData: (b: Uint8Array) => void = () => {};
      let onOpen = () => {};
      let onClose = () => {};
      let frames = 0;
      let closed = false;
      const sessionId = `sess-${++seq}`;
      const reply = (env: unknown) => setTimeout(() => { if (!closed) onData(encodeFrame(enc.encode(JSON.stringify(env)))); }, 0);
      setTimeout(() => onOpen(), 0);
      return {
        onOpen: (cb) => { onOpen = cb; },
        onData: (cb) => { onData = cb; },
        onClose: (cb) => { onClose = cb; },
        close: () => { if (!closed) { closed = true; setTimeout(onClose, 0); } },
        write: (bytes) => {
          for (const f of decoder.push(bytes)) {
            const j = JSON.parse(dec.decode(f)) as { type?: string; role?: string; token?: string; data?: { code?: string; sdp?: string } };
            if (frames++ === 0) { expect(j).toEqual({ token: '', role: 'viewer' }); continue; }
            if (j.type === 'session_request') {
              if (denyReason || j.data?.code !== HOST_CODE) { reply({ type: 'session_denied', data: { reason: denyReason ?? 'unknown_code' } }); continue; }
              reply({ type: 'session_granted', data: { session: sessionId, token: 'a1b2c3d4e5f60718', ice_servers: [{ urls: 'stun:example.org' }] } });
              reply({ type: 'ice_candidate', data: { session: sessionId, candidate: '{"candidate":"early"}' } });
              reply({ type: 'offer', data: { session: sessionId, sdp: 'offer-sdp' } });
            } else if (j.type === 'answer') {
              expect(j.data?.sdp).toBe('answer-to:offer-sdp');
              const p = lastPeer!;
              void serve({ chan: p.other, sessionId });
              setTimeout(() => p.emit('open'), 0);
            }
          }
        },
      };
    },
    createPeer(ice): Peer {
      expect(ice).toEqual([{ urls: 'stun:example.org' }]);
      const a = new FakePeer();
      const b = new Chan();
      a.other = b;
      b.other = a;
      lastPeer = a;
      return a as unknown as Peer;
    },
  };
  let lastPeer: FakePeer | null = null;

  return {
    id: hostCanonical(key.pub), platform, pairing, trusted, input, sizes, peers, hellos,
    setShells: (s: typeof shells) => { shells = s; },
    setProjects: (p: typeof projects) => { projects = p; },
    deny: (r: string | null) => { denyReason = r; },
    dropLinks: () => { for (const p of peers.splice(0)) p.close(); },
  };
}

const phoneKey = () => deviceKeyFromSeed(new Uint8Array(randomBytes(32)));
const relay = { host: 'relay.test', port: 7100 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await wait(5);
  }
}

describe('phone core against the desktop implementation', () => {
  it('pairs: both sides learn each other, and the phone gets the code to dial back', async () => {
    const host = makeHost();
    const key = phoneKey();
    host.pairing.generate(HOST_CODE);
    const r = await pairWith({ platform: host.platform, relay, code: ` ${HOST_CODE} `, deviceKey: key, deviceName: 'Pixel' });
    expect(r).toEqual({ deviceId: host.id, name: 'Studio', code: HOST_CODE });
    await until(() => host.trusted.size === 1);
    expect(host.trusted.get(canonicalPubHex(key.pub))).toBe('Pixel');
    expect(host.hellos).toEqual([{ hello: 'Pixel' }]);
  });

  it('refuses to pair when the host has no pairing window open (prologue mismatch)', async () => {
    const host = makeHost();
    await expect(pairWith({ platform: host.platform, relay, code: HOST_CODE, deviceKey: phoneKey(), deviceName: 'Pixel' })).rejects.toThrow('handshake_failed');
    expect(host.trusted.size).toBe(0);
  });

  it('reports the relay denial reason', async () => {
    const host = makeHost();
    host.deny('host_offline');
    await expect(connect({ platform: host.platform, relay, code: HOST_CODE, deviceKey: phoneKey(), expectedDevice: host.id })).rejects.toThrow('host_offline');
  });

  it('refuses a host whose identity is not the paired one, before revealing its own', async () => {
    const host = makeHost();
    const other = makeHost();
    await expect(connect({ platform: host.platform, relay, code: HOST_CODE, deviceKey: phoneKey(), expectedDevice: other.id })).rejects.toThrow('trust_failed');
  });

  it('calls RPC methods and streams a shell, including frames larger than one secure chunk', async () => {
    const host = makeHost();
    const key = phoneKey();
    host.trusted.set(canonicalPubHex(key.pub), 'Pixel');
    host.setProjects(Array.from({ length: 400 }, (_, i) => ({ id: i + 1, name: `project-${i}`, path: `/very/long/path/${'d'.repeat(200)}/${i}` })));
    const conn = await connect({ platform: host.platform, relay, code: HOST_CODE, deviceKey: key, expectedDevice: host.id });
    const projects = await conn.rpc.call('projects.list', {});
    expect(projects).toHaveLength(400);
    expect(projects[399]!.name).toBe('project-399');

    let out = '';
    let exit: number | null | undefined;
    let closed = '';
    const h = conn.rpc.attach({ projectId: 2, shellIndex: 1 }, (d) => {
      const e = d as { kind: string; bytes?: string; code?: number };
      if (e.kind === 'out') out += e.bytes;
      else exit = e.code;
    }, (reason) => { closed = reason; });
    const stream = await h.ready;
    await conn.rpc.call('shells.input', { stream, bytes: Buffer.from('ls → ✓\r').toString('base64') });
    await until(() => closed !== '');
    expect(out).toBe(`snapshot ${'x'.repeat(40_000)} héllo → 🙂`);
    expect(exit).toBe(0);
    expect(closed).toBe('remote_ended');
    expect(host.input).toEqual(['ls → ✓\r']);

    let failed = '';
    conn.rpc.attach({ projectId: 9, shellIndex: 0 }, () => {}, (reason) => { failed = reason; }).ready.catch(() => {});
    await until(() => failed !== '');
    expect(failed).toBe('attach_failed: unknown_shell');
    await expect(conn.rpc.call('shells.input', { stream: 999, bytes: '' })).rejects.toMatchObject({ code: 'unknown_stream' });
    conn.close();
  });

  it('is turned away by a host that does not trust it', async () => {
    const host = makeHost();
    const conn = await connect({ platform: host.platform, relay, code: HOST_CODE, deviceKey: phoneKey(), expectedDevice: host.id });
    await expect(conn.rpc.call('projects.list', {}, 1000)).rejects.toMatchObject({ code: 'closed' });
  });
});

describe('Fleet', () => {
  function memoryStorage(): Storage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      get: async (k) => data.get(k) ?? null,
      set: async (k, v) => { data.set(k, v); },
      getSecret: async (k) => data.get(`secret:${k}`) ?? null,
      setSecret: async (k, v) => { data.set(`secret:${k}`, v); },
    };
  }
  const newFleet = (host: ReturnType<typeof makeHost>, storage = memoryStorage()) =>
    new Fleet({ platform: host.platform, storage, randomBytes: (n) => new Uint8Array(randomBytes(n)), defaultDeviceName: 'Phone' });
  const machine = (s: FleetState) => s.machines[0]!;

  it('pairs, comes online, lists active projects, and drives a shell', async () => {
    const host = makeHost();
    const storage = memoryStorage();
    const fleet = newFleet(host, storage);
    await fleet.init();
    expect(fleet.getSnapshot().machines).toEqual([]);
    await expect(fleet.pair('no')).rejects.toThrow('invalid_code');

    host.pairing.generate(HOST_CODE);
    const device = await fleet.pair(HOST_CODE);
    expect(device.name).toBe('Studio');
    await until(() => machine(fleet.getSnapshot()).loaded);
    const m = machine(fleet.getSnapshot());
    expect(m.status).toBe('online');
    expect(activeProjects(m)).toEqual([{
      project: { id: 2, name: 'beta', path: '/p/beta' },
      shells: [{ projectId: 2, shellIndex: 0, agentState: 'idle' }, { projectId: 2, shellIndex: 1, agentState: 'blocked' }],
      agentState: 'blocked',
    }]);

    let out = '';
    let closed = '';
    const sh = fleet.openShell(device.id, 2, 0, { onData: (t) => { out += t; }, onExit: () => {}, onClose: (r) => { closed = r; } });
    sh.send('a');
    sh.send('b');
    sh.send('c\r');
    sh.resize(40, 20);
    sh.resize(42.9, 21);
    await until(() => closed !== '');
    expect(out.startsWith('snapshot ')).toBe(true);
    expect(host.input.join('')).toBe('abc\r');
    expect(host.sizes.at(-1)).toEqual([42, 21]);

    // A second launch restores the device from storage and reconnects with the stored key.
    const again = newFleet(host, storage);
    await again.init();
    await until(() => again.getSnapshot().machines[0]?.status === 'online');
    expect(again.deviceId).toBe(fleet.deviceId);
  });

  it('goes offline when the link drops, reconnects, and marks a machine that revoked it', async () => {
    const host = makeHost();
    const fleet = newFleet(host);
    await fleet.init();
    host.pairing.generate(HOST_CODE);
    const device = await fleet.pair(HOST_CODE);
    await until(() => machine(fleet.getSnapshot()).status === 'online');

    let closed = '';
    fleet.openShell(device.id, 2, 0, { onData: () => {}, onExit: () => {}, onClose: (r) => { closed = r; } });
    await wait(10);
    host.dropLinks();
    await until(() => machine(fleet.getSnapshot()).status === 'offline');
    expect(closed).not.toBe('');
    fleet.reconnect(device.id);
    await until(() => machine(fleet.getSnapshot()).status === 'online');

    host.trusted.clear();
    host.dropLinks();
    await until(() => machine(fleet.getSnapshot()).status === 'offline');
    fleet.reconnect(device.id);
    await until(() => machine(fleet.getSnapshot()).status === 'offline' && machine(fleet.getSnapshot()).error === 'link_lost');

    await fleet.remove(device.id);
    expect(fleet.getSnapshot().machines).toEqual([]);
  });
});
