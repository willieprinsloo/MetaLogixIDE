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
import { Effect, Exit, Layer, Scope, Stream } from 'effect';
import { activeProjects, Fleet, shellName, tabLabels, type FleetState } from '../fleet';
import { connect, pairWith, type Connection } from '../link';
import { Peers, Platform, Relay, Storage, type Peer, type RelaySocket } from '../services';
import { canonicalPubHex, deviceKeyFromSeed } from '../noise';
import { parsePairLink } from '../pairLink';
import { buildPairLink } from '../../../../src/shared/pair-link';

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

type HostSession = { chan: Chan; sessionId: string; relay(env: unknown, delayMs?: number): void };

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
  /** Says something over the relay to the viewer of the most recent session. */
  let sayToViewer: (env: unknown) => void = () => {};
  let lastSession = '';
  let projects = [{ id: 1, name: 'alpha', path: '/p/alpha', extra: true }, { id: 2, name: 'beta', path: '/p/beta' }];
  let shells: Array<{ projectId: number; shellIndex: number; agentState?: 'idle' | 'busy' | 'blocked' | null; launchArgv?: string[]; agent?: string | null }> = [
    { projectId: 2, shellIndex: 0, agentState: 'idle', launchArgv: ['/opt/homebrew/bin/claude', '--continue'], agent: 'claude' },
    { projectId: 2, shellIndex: 1, agentState: 'blocked', launchArgv: ['opencode'], agent: 'opencode' },
  ];
  let seq = 0;
  let denyReason: string | null = null;

  async function serve({ chan, sessionId, relay: say }: HostSession): Promise<void> {
    sayToViewer = say;
    lastSession = sessionId;
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
    if (!trusted.has(remote)) {
      // As the desktop does: hang up, then say why over the relay. The reason lands after the close.
      secure.close();
      say({ type: 'session_close', data: { session: sessionId, reason: 'untrusted_device' } }, 40);
      return;
    }
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

  const platform = {
    connect(): RelaySocket {
      const decoder = createFrameDecoder();
      let onData: (b: Uint8Array) => void = () => {};
      let onOpen = () => {};
      let onClose = () => {};
      let frames = 0;
      let closed = false;
      const sessionId = `sess-${++seq}`;
      const reply = (env: unknown, delayMs = 0) => setTimeout(() => { if (!closed) onData(encodeFrame(enc.encode(JSON.stringify(env)))); }, delayMs);
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
              void serve({ chan: p.other, sessionId, relay: reply });
              setTimeout(() => p.emit('open'), 0);
            }
          }
        },
      };
    },
    createPeer(ice: unknown): Peer {
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
  /** The relay and the peer connections, as the services the core asks for. */
  const layer = Layer.mergeAll(
    Layer.succeed(Relay, Relay.of({ connect: () => platform.connect() })),
    Layer.succeed(Peers, Peers.of({ create: (ice) => platform.createPeer(ice) })),
  );

  return {
    id: hostCanonical(key.pub), layer, pairing, trusted, input, sizes, peers, hellos,
    setShells: (s: typeof shells) => { shells = s; },
    setProjects: (p: typeof projects) => { projects = p; },
    deny: (r: string | null) => { denyReason = r; },
    dropLinks: () => { for (const p of peers.splice(0)) p.close(); },
    /** The relay (or the host through it) closes the latest session's signalling, giving `reason`. */
    relayClose: (reason: string) => sayToViewer({ type: 'session_close', data: { session: lastSession, reason } }),
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

type Host = ReturnType<typeof makeHost>;

/** Runs a core effect against a host's relay and peers. A failure rejects with the tagged error itself. */
const run = <A, E>(host: Host, effect: Effect.Effect<A, E, Relay | Peers>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(host.layer)));

/** Opens a connection in a Scope of its own, so a test can hold it across steps and close it when done. */
async function open(host: Host, opts: Parameters<typeof connect>[0]): Promise<Connection & { close(): Promise<void>; reason(): string | null }> {
  const scope = Effect.runSync(Scope.make());
  const conn = await run(host, connect(opts).pipe(Scope.provide(scope)));
  let reason: string | null = null;
  Effect.runFork(conn.remoteReason.pipe(Effect.map((r) => { reason = r; })));
  return { ...conn, close: () => Effect.runPromise(Scope.close(scope, Exit.void)), reason: () => reason };
}

describe('phone core against the desktop implementation', () => {
  it('pairs: both sides learn each other, and the phone gets the code to dial back', async () => {
    const host = makeHost();
    const key = phoneKey();
    host.pairing.generate(HOST_CODE);
    const r = await run(host, pairWith({ relay, code: ` ${HOST_CODE} `, deviceKey: key, deviceName: 'Pixel' }));
    expect(r).toEqual({ deviceId: host.id, name: 'Studio', code: HOST_CODE });
    await until(() => host.trusted.size === 1);
    expect(host.trusted.get(canonicalPubHex(key.pub))).toBe('Pixel');
    expect(host.hellos).toEqual([{ hello: 'Pixel', viewer: true }]);
  });

  it('refuses to pair when the host has no pairing window open (prologue mismatch)', async () => {
    const host = makeHost();
    await expect(run(host, pairWith({ relay, code: HOST_CODE, deviceKey: phoneKey(), deviceName: 'Pixel' }))).rejects.toMatchObject({ _tag: 'LinkError', reason: 'handshake_failed' });
    expect(host.trusted.size).toBe(0);
  });

  it('reports the relay denial reason', async () => {
    const host = makeHost();
    host.deny('host_offline');
    await expect(open(host, { relay, code: HOST_CODE, deviceKey: phoneKey(), expectedDevice: host.id })).rejects.toMatchObject({ reason: 'host_offline' });
  });

  it('refuses a host whose identity is not the paired one, before revealing its own', async () => {
    const host = makeHost();
    const other = makeHost();
    await expect(open(host, { relay, code: HOST_CODE, deviceKey: phoneKey(), expectedDevice: other.id })).rejects.toMatchObject({ reason: 'trust_failed' });
  });

  it('calls RPC methods and streams a shell, including frames larger than one secure chunk', async () => {
    const host = makeHost();
    const key = phoneKey();
    host.trusted.set(canonicalPubHex(key.pub), 'Pixel');
    host.setProjects(Array.from({ length: 400 }, (_, i) => ({ id: i + 1, name: `project-${i}`, path: `/very/long/path/${'d'.repeat(200)}/${i}` })));
    const conn = await open(host, { relay, code: HOST_CODE, deviceKey: key, expectedDevice: host.id });
    const projects = await Effect.runPromise(conn.rpc.call('projects.list', {}));
    expect(projects).toHaveLength(400);
    expect(projects[399]!.name).toBe('project-399');

    let out = '';
    let exit: number | null | undefined;
    // The stream lives for the scope: it ends by itself when the host closes it (the shell exited).
    await Effect.runPromise(Effect.gen(function*() {
      const shell = yield* conn.rpc.attach({ projectId: 2, shellIndex: 1 });
      yield* conn.rpc.call('shells.input', { stream: shell.stream, bytes: Buffer.from('ls → ✓\r').toString('base64') });
      yield* Stream.runForEach(shell.events, (e) => Effect.sync(() => {
        if (e.kind === 'out') out += e.bytes;
        else exit = e.code;
      }));
    }).pipe(Effect.scoped));
    expect(out).toBe(`snapshot ${'x'.repeat(40_000)} héllo → 🙂`);
    expect(exit).toBe(0);
    expect(host.input).toEqual(['ls → ✓\r']);

    await expect(Effect.runPromise(conn.rpc.attach({ projectId: 9, shellIndex: 0 }).pipe(Effect.scoped))).rejects.toMatchObject({ _tag: 'RpcError', code: 'unknown_shell' });
    await expect(Effect.runPromise(conn.rpc.call('shells.input', { stream: 999, bytes: '' }))).rejects.toMatchObject({ code: 'unknown_stream' });
    // A result that is not what the method promises is refused rather than passed on.
    host.setProjects([{ id: 'one', name: 1 }] as never);
    await expect(Effect.runPromise(conn.rpc.call('projects.list', {}))).rejects.toMatchObject({ code: 'invalid_result' });
    await conn.close();
    expect(conn.rpc.isClosed).toBe(true);
  });

  it('stays connected when the relay supersedes its session for another viewer of the same host', async () => {
    const host = makeHost();
    const key = phoneKey();
    host.trusted.set(canonicalPubHex(key.pub), 'Pixel');
    const conn = await open(host, { relay, code: HOST_CODE, deviceKey: key, expectedDevice: host.id });
    await Effect.runPromise(conn.rpc.call('projects.list', {}));
    host.relayClose('superseded by a new connection');
    await wait(30);
    expect(conn.rpc.isClosed).toBe(false);
    await expect(Effect.runPromise(conn.rpc.call('shells.alive', {}))).resolves.toHaveLength(2);
    expect(conn.reason()).toBeNull(); // relay bookkeeping, not the host's reason for anything
    await conn.close();
  });

  it('keeps the reason a host gives over the relay before it hangs up', async () => {
    const host = makeHost();
    const key = phoneKey();
    host.trusted.set(canonicalPubHex(key.pub), 'Pixel');
    const conn = await open(host, { relay, code: HOST_CODE, deviceKey: key, expectedDevice: host.id });
    host.relayClose('revoked');
    await until(() => conn.reason() === 'revoked');
    expect(conn.rpc.isClosed).toBe(false); // the channel closing is what ends the link
    host.dropLinks();
    await Effect.runPromise(conn.rpc.closed);
    expect(conn.rpc.isClosed).toBe(true);
  });

  it('is turned away by a host that does not trust it', async () => {
    const host = makeHost();
    const conn = await open(host, { relay, code: HOST_CODE, deviceKey: phoneKey(), expectedDevice: host.id });
    await expect(Effect.runPromise(conn.rpc.call('projects.list', {}, 1000))).rejects.toMatchObject({ code: 'closed' });
    // The reason arrives over the relay after the channel has gone, and is still picked up.
    expect(conn.reason()).toBeNull();
    await until(() => conn.reason() === 'untrusted_device');
  });
});

describe('pairing QR link', () => {
  it('reads what the desktop encodes', () => {
    expect(parsePairLink(buildPairLink({ code: '921782718', relayUrl: 'remote.metalogix.solutions', relayPort: 7100 })))
      .toEqual({ code: '921782718', relayHost: 'remote.metalogix.solutions', relayPort: 7100 });
    expect(parsePairLink(buildPairLink({ code: ' ABCD-1234 ' }))).toEqual({ code: 'ABCD-1234' });
    expect(parsePairLink(buildPairLink({ code: 'ABCD-1234', relayUrl: '10.0.0.5', relayPort: 0 }))).toEqual({ code: 'ABCD-1234', relayHost: '10.0.0.5' });
  });
  it('accepts a bare code and rejects everything else', () => {
    expect(parsePairLink(' 921782718\n')).toEqual({ code: '921782718' });
    expect(parsePairLink('METAIDE://pair/?code=abcd-1')).toEqual({ code: 'abcd-1' });
    for (const bad of ['', 'https://example.com/?code=921782718', 'metaide://pair', 'metaide://pair?code=', 'metaide://pair?code=a%20b', 'metaide://other?code=921782718', 'hello world']) {
      expect(parsePairLink(bad)).toBeNull();
    }
  });
  it('drops a relay host or port that is not one, keeping the code', () => {
    expect(parsePairLink('metaide://pair?code=921782718&relay=evil.example%2Fpath&port=99999')).toEqual({ code: '921782718' });
    expect(parsePairLink('metaide://pair?code=921782718&relay=a.b&port=7100x')).toEqual({ code: '921782718', relayHost: 'a.b' });
    expect(parsePairLink('metaide://pair?code=921782718&code=other&relay=%E0%A4%A')).toEqual({ code: '921782718' });
  });
});

describe('Fleet', () => {
  /** In-memory storage and platform, so a second Fleet over the same map behaves like a relaunch. */
  const appLayer = (host: Host, data: Map<string, string>) => Layer.mergeAll(
    host.layer,
    Layer.succeed(Storage, Storage.of({
      get: (k) => Effect.sync(() => data.get(k) ?? null),
      set: (k, v) => Effect.sync(() => { data.set(k, v); }),
      getSecret: (k) => Effect.sync(() => data.get(`secret:${k}`) ?? null),
      setSecret: (k, v) => Effect.sync(() => { data.set(`secret:${k}`, v); }),
    })),
    Layer.succeed(Platform, Platform.of({ randomBytes: (n) => new Uint8Array(randomBytes(n)), defaultName: 'Phone' })),
  );
  const newFleet = (host: Host, data = new Map<string, string>()) => new Fleet(appLayer(host, data));
  const machine = (s: FleetState) => s.machines[0]!;

  it('pairs, comes online, lists active projects, and drives a shell', async () => {
    const host = makeHost();
    const storage = new Map<string, string>();
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
      shells: [{ projectId: 2, shellIndex: 0, agentState: 'idle', name: 'Claude' }, { projectId: 2, shellIndex: 1, agentState: 'blocked', name: 'Opencode' }],
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

    // A shell that is not there: the reason says the attach failed and why.
    let failed = '';
    fleet.openShell(device.id, 9, 0, { onData: () => {}, onExit: () => {}, onClose: (r) => { failed = r; } });
    await until(() => failed !== '');
    expect(failed).toBe('attach_failed: unknown_shell');

    // Closing a session locally reports nothing, and tells the host to stop streaming.
    let reported = false;
    const quiet = fleet.openShell(device.id, 2, 1, { onData: () => {}, onExit: () => {}, onClose: () => { reported = true; } });
    await wait(10);
    quiet.close();
    await wait(60);
    expect(reported).toBe(false);

    // A second launch restores the device from storage and reconnects with the stored key.
    const again = newFleet(host, storage);
    await again.init();
    await until(() => again.getSnapshot().machines[0]?.status === 'online');
    expect(again.deviceId).toBe(fleet.deviceId);
  });

  it('names tabs as the desktop does', () => {
    const sh = (shellIndex: number, launchArgv?: string[], agent?: string | null) => ({ projectId: 1, shellIndex, launchArgv, agent });
    expect(shellName(sh(0, ['/usr/local/bin/claude']))).toBe('Claude');
    expect(shellName(sh(1, ['$SHELL']))).toBe('Terminal');
    expect(shellName(sh(1, ['/bin/zsh', '-l']))).toBe('Terminal');
    expect(shellName(sh(2, ['$SHELL'], 'opencode'))).toBe('opencode'); // started by hand in a terminal
    expect(shellName(sh(2, ['opencode'], 'opencode'))).toBe('Opencode'); // launched as such: the launch name stands
    expect(shellName(sh(3))).toBe('Shell 3'); // an older host that sends no command
    const named = [0, 1, 2].map((i) => ({ projectId: 1, shellIndex: i, agentState: null, name: i === 1 ? 'Terminal' : 'Claude' }));
    expect(tabLabels(named)).toEqual(['Claude 1', 'Terminal', 'Claude 2']);
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

    // Removed on the desktop: the host completes the handshake, hangs up and says why. The phone must
    // never show that machine as online again, and must stop retrying instead of flapping.
    host.trusted.clear();
    host.dropLinks();
    await until(() => machine(fleet.getSnapshot()).status === 'offline');
    const seen: string[] = [];
    const off = fleet.subscribe(() => seen.push(machine(fleet.getSnapshot()).status));
    fleet.reconnect(device.id);
    await until(() => machine(fleet.getSnapshot()).status === 'revoked');
    expect(machine(fleet.getSnapshot()).error).toBe('untrusted_device');
    expect(seen).not.toContain('online');
    await wait(150);
    expect(machine(fleet.getSnapshot()).status).toBe('revoked'); // no retry
    off();

    await fleet.remove(device.id);
    expect(fleet.getSnapshot().machines).toEqual([]);
  });
});
