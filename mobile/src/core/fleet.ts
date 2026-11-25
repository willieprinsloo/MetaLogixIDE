/**
 * App state: paired desktops, one live link each, and their active projects.
 *
 * The work is Effect: one supervisor fiber per machine connects, polls and reconnects inside a Scope, so
 * interrupting the fiber is all it takes to drop a link cleanly. The edge React sees is deliberately
 * plain (subscribe/getSnapshot plus a few methods), so components bind with useSyncExternalStore.
 */
import { Effect, Fiber, type Layer, ManagedRuntime, Queue, Schema, type Scope, Stream } from 'effect';
import { base64Encode, fromHex, toHex, utf8Encode } from './bytes';
import { RpcError } from './errors';
import { connect, pairWith, type Connection } from './link';
import { canonicalPubHex, deviceKeyFromSeed, type DeviceKey } from './noise';
import { ConnectCode, Device, StoredSettings, type AgentState, type Project, type ShellInfo } from './schemas';
import { Platform, Storage, type Peers, type Relay } from './services';

export type { Device };
export type MachineStatus = 'connecting' | 'online' | 'offline' | 'revoked';
export type Machine = {
  device: Device;
  status: MachineStatus;
  /** Short reason code for the last failure, null while healthy. */
  error: string | null;
  projects: Project[];
  shells: Shell[];
  /** True once projects/shells have been fetched at least once. */
  loaded: boolean;
};
export type Settings = { relayHost: string; relayPort: number; deviceName: string };
export type FleetState = { ready: boolean; machines: Machine[]; settings: Settings };

/** A live shell (a tab on the desktop) with the label the desktop shows for it. */
export type Shell = { projectId: number; shellIndex: number; agentState: AgentState | null; name: string };
export type ActiveProject = { project: Project; shells: Shell[]; agentState: AgentState | null };

const AGENT_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'opencode' };
const baseName = (bin: string): string => bin.split(/[\\/]/).pop() ?? '';

/**
 * Tab label, as src/shared/shell-launch-name.ts derives it on the desktop: the agent detected in the shell
 * when it differs from the launch command, else "Terminal" for a login shell, else the capitalised binary.
 */
export function shellName(s: ShellInfo): string {
  const base = baseName(s.launchArgv?.[0] ?? '');
  const launched = base.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  if (s.agent && AGENT_LABEL[s.agent] && s.agent !== launched) return AGENT_LABEL[s.agent]!;
  if (base === '$SHELL' || /^(zsh|bash|sh|fish)$/.test(base)) return 'Terminal';
  return base ? base[0]!.toUpperCase() + base.slice(1) : `Shell ${s.shellIndex}`;
}

/** Appends " N" to labels that repeat within one project ("Claude 1", "Claude 2"). */
export function tabLabels(shells: readonly Shell[]): string[] {
  return shells.map((s) => {
    const same = shells.filter((o) => o.name === s.name);
    return same.length > 1 ? `${s.name} ${same.indexOf(s) + 1}` : s.name;
  });
}

export interface ShellSession {
  send(text: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}
export interface ShellEvents {
  onData(text: string): void;
  onExit(code: number | null): void;
  /** Fires once when the stream ends for any reason (not after a local close()). */
  onClose(reason: string): void;
}

export const DEFAULT_RELAY = { host: 'remote.metalogix.solutions', port: 7100 };
const POLL_MS = 5000;
const POLL_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 4000;
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 30_000;
/** How long after the channel closes the host's reason for closing it may still arrive over the relay. */
const REASON_GRACE = '2 seconds';
/** The desktop no longer trusts this phone (removed there): retrying cannot help, it needs a new pairing. */
const REVOKED = new Set(['untrusted_device', 'revoked', 'trust_failed']);

const RANK: Record<AgentState, number> = { idle: 0, busy: 1, blocked: 2 };

/** Projects with at least one live shell, busiest first then by name. */
export function activeProjects(m: Machine): ActiveProject[] {
  const byProject = new Map<number, Shell[]>();
  for (const s of m.shells) {
    const list = byProject.get(s.projectId);
    if (list) list.push(s);
    else byProject.set(s.projectId, [s]);
  }
  const out: ActiveProject[] = [];
  for (const p of m.projects) {
    const shells = byProject.get(p.id);
    if (!shells) continue;
    shells.sort((a, b) => a.shellIndex - b.shellIndex);
    let agentState: AgentState | null = null;
    for (const s of shells) if (s.agentState && (agentState === null || RANK[s.agentState] > RANK[agentState])) agentState = s.agentState;
    out.push({ project: p, shells, agentState });
  }
  return out.sort((a, b) => a.project.name.localeCompare(b.project.name));
}

type Env = Relay | Peers | Storage | Platform;

/** One machine's supervisor: its fiber, its live connection if any, and the two ways to nudge it. */
interface Supervisor {
  fiber: Fiber.Fiber<void>;
  conn: Connection | null;
  /** True once the current connection has answered a request. */
  answered: boolean;
  /** Skips the wait before the next dial. */
  wake: Queue.Queue<true>;
  /** Polls now, with the given timeout in milliseconds, instead of at the next tick. */
  pollNow: Queue.Queue<number>;
}

const decodeDevices = Schema.decodeUnknownOption(Schema.Array(Device));
const decodeSettings = Schema.decodeUnknownOption(StoredSettings);
const isConnectCode = Schema.is(ConnectCode);
const save = (key: string, value: string): Effect.Effect<void, never, Storage> =>
  Effect.gen(function*() {
    const storage = yield* Storage;
    yield* storage.set(key, value);
  });
const parseJson = (raw: string | null): unknown => { try { return raw === null ? null : JSON.parse(raw); } catch { return null; } };

export class Fleet {
  #state: FleetState;
  #key: DeviceKey | null = null;
  readonly #listeners = new Set<() => void>();
  readonly #supervisors = new Map<string, Supervisor>();
  readonly #runtime: ManagedRuntime.ManagedRuntime<Env, never>;
  #active = true;
  #init: Promise<void> | null = null;
  #defaultName = '';

  constructor(layer: Layer.Layer<Env>) {
    this.#runtime = ManagedRuntime.make(layer);
    this.#state = {
      ready: false,
      machines: [],
      settings: { relayHost: DEFAULT_RELAY.host, relayPort: DEFAULT_RELAY.port, deviceName: '' },
    };
  }

  subscribe = (cb: () => void): (() => void) => {
    this.#listeners.add(cb);
    return () => { this.#listeners.delete(cb); };
  };
  getSnapshot = (): FleetState => this.#state;

  /** This phone's device id (canonical public key hex); empty before init. */
  get deviceId(): string { return this.#key ? canonicalPubHex(this.#key.pub) : ''; }

  init(): Promise<void> {
    return (this.#init ??= this.#runtime.runPromise(Effect.gen({ self: this }, function*() {
      const storage = yield* Storage;
      const platform = yield* Platform;
      this.#defaultName = platform.defaultName;
      let seedHex = yield* storage.getSecret('device_key');
      if (!seedHex || !/^[0-9a-f]{64}$/.test(seedHex)) {
        seedHex = toHex(platform.randomBytes(32));
        yield* storage.setSecret('device_key', seedHex);
      }
      this.#key = deviceKeyFromSeed(fromHex(seedHex));
      const stored = decodeSettings(parseJson(yield* storage.get('settings')));
      const s = stored._tag === 'Some' ? stored.value : {};
      const settings: Settings = {
        relayHost: s.relayHost || DEFAULT_RELAY.host,
        relayPort: s.relayPort ?? DEFAULT_RELAY.port,
        deviceName: s.deviceName || platform.defaultName,
      };
      const devices = decodeDevices(parseJson(yield* storage.get('devices')));
      const list = devices._tag === 'Some' ? [...devices.value] : [];
      this.#set({ ready: true, settings, machines: sortMachines(list.map(newMachine)) });
      for (const d of list) this.#start(d.id);
    })));
  }

  // ---- pairing and settings ----

  /** Pairs with the desktop whose "Pair a new machine" window shows `code`. Rejects with an Error whose message is a reason code. */
  async pair(code: string): Promise<Device> {
    await this.init();
    const trimmed = code.trim();
    if (!isConnectCode(trimmed)) throw new Error('invalid_code');
    const s = this.#state.settings;
    const r = await this.#runtime.runPromise(
      pairWith({ relay: { host: s.relayHost, port: s.relayPort }, code: trimmed, deviceKey: this.#key!, deviceName: s.deviceName }).pipe(
        Effect.map((result) => ({ ok: true as const, result })),
        Effect.catch((e) => Effect.succeed({ ok: false as const, reason: e.reason })),
      ),
    );
    if (!r.ok) throw new Error(r.reason);
    const device: Device = { id: r.result.deviceId, name: r.result.name, code: r.result.code, addedAt: Date.now() };
    this.#stop(device.id);
    const machines = this.#state.machines.filter((m) => m.device.id !== device.id);
    machines.push(newMachine(device));
    this.#set({ machines: sortMachines(machines) });
    await this.#persistDevices();
    this.#start(device.id);
    return device;
  }

  async remove(id: string): Promise<void> {
    this.#stop(id);
    this.#set({ machines: this.#state.machines.filter((m) => m.device.id !== id) });
    await this.#persistDevices();
  }

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    const cur = this.#state.settings;
    const next: Settings = {
      relayHost: (patch.relayHost ?? cur.relayHost).trim() || DEFAULT_RELAY.host,
      relayPort: Number.isInteger(patch.relayPort) && patch.relayPort! > 0 && patch.relayPort! < 65536 ? patch.relayPort! : cur.relayPort,
      deviceName: (patch.deviceName ?? cur.deviceName).trim().slice(0, 80) || this.#defaultName,
    };
    this.#set({ settings: next });
    await this.#runtime.runPromise(save('settings', JSON.stringify(next)));
    if (next.relayHost !== cur.relayHost || next.relayPort !== cur.relayPort) {
      for (const m of this.#state.machines) { this.#stop(m.device.id); this.#start(m.device.id); }
    }
  }

  // ---- lifecycle ----

  /** Foreground/background. Coming back, links the OS killed are found by a short probe and redialled at once. */
  setActive(active: boolean): void {
    if (this.#active === active) return;
    this.#active = active;
    if (!active) return;
    for (const m of this.#state.machines) if (m.status !== 'revoked') this.reconnect(m.device.id);
  }

  /** Probes a live link now, or drops any pending back-off and dials now. */
  reconnect(id: string): void {
    const sup = this.#supervisors.get(id);
    if (!sup) { this.#start(id); return; }
    if (sup.conn) Queue.offerUnsafe(sup.pollNow, PROBE_TIMEOUT_MS);
    else Queue.offerUnsafe(sup.wake, true);
  }

  refresh(id: string): Promise<void> {
    const sup = this.#supervisors.get(id);
    const conn = sup?.conn;
    if (!sup || !conn) { this.reconnect(id); return Promise.resolve(); }
    return this.#runtime.runPromise(this.#poll(id, sup, conn, POLL_TIMEOUT_MS).pipe(Effect.ignore));
  }

  // ---- shells ----

  /** Attaches to a live shell: the host replays the screen, then streams output. */
  openShell(id: string, projectId: number, shellIndex: number, ev: ShellEvents): ShellSession {
    const conn = this.#supervisors.get(id)?.conn;
    if (!conn) {
      let cancelled = false;
      setTimeout(() => { if (!cancelled) ev.onClose('offline'); }, 0);
      return { send() {}, resize() {}, close() { cancelled = true; } };
    }
    let closedLocally = false;
    const input = Effect.runSync(Queue.unbounded<string>());
    const sizes = Effect.runSync(Queue.sliding<{ cols: number; rows: number }>(1)); // only the latest size matters

    const session = Effect.gen({ self: this }, function*() {
      const shell = yield* conn.rpc.attach({ projectId, shellIndex }).pipe(
        Effect.mapError((e) => new RpcError({ code: `attach_failed: ${e.code}`, message: e.message })),
      );
      // Keystrokes go out one request at a time, in order; anything typed meanwhile is coalesced.
      yield* Effect.forkScoped(Effect.forever(
        Queue.takeAll(input).pipe(
          Effect.flatMap((chunks) => conn.rpc.call('shells.input', { stream: shell.stream, bytes: base64Encode(utf8Encode(chunks.join(''))) })),
          Effect.ignore, // a dead link ends the stream, which the UI shows
        ),
      ));
      yield* Effect.forkScoped(Effect.forever(
        Queue.take(sizes).pipe(
          Effect.flatMap((s) => conn.rpc.call('shells.resize', { stream: shell.stream, cols: s.cols, rows: s.rows })),
          Effect.ignore,
        ),
      ));
      yield* Stream.runForEach(shell.events, (e) => Effect.sync(() => {
        if (e.kind === 'out') ev.onData(e.bytes);
        else ev.onExit(e.code ?? null);
      }));
      return 'remote_ended';
    }).pipe(
      Effect.scoped,
      Effect.catch((e) => Effect.succeed(e.code)),
      Effect.flatMap((reason) => Effect.sync(() => { if (!closedLocally) ev.onClose(reason); })),
    );
    const fiber = this.#runtime.runFork(session);

    return {
      send: (text) => { if (text) Queue.offerUnsafe(input, text); },
      resize: (cols, rows) => { if (cols > 0 && rows > 0) Queue.offerUnsafe(sizes, { cols: Math.floor(cols), rows: Math.floor(rows) }); },
      close: () => {
        closedLocally = true;
        this.#runtime.runFork(Fiber.interrupt(fiber));
      },
    };
  }

  // ---- internals ----

  #set(patch: Partial<FleetState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const l of [...this.#listeners]) l();
  }

  #patch(id: string, patch: Partial<Machine>): void {
    if (!this.#state.machines.some((m) => m.device.id === id)) return;
    this.#set({ machines: this.#state.machines.map((m) => (m.device.id === id ? { ...m, ...patch } : m)) });
  }

  #persistDevices(): Promise<void> {
    const json = JSON.stringify(this.#state.machines.map((m) => m.device));
    return this.#runtime.runPromise(save('devices', json));
  }

  /** Starts (or restarts) the supervisor for a machine. */
  #start(id: string): void {
    this.#stop(id);
    if (!this.#key || !this.#state.machines.some((m) => m.device.id === id)) return;
    const sup: Supervisor = {
      fiber: undefined as never,
      conn: null,
      answered: false,
      wake: Effect.runSync(Queue.unbounded<true>()),
      pollNow: Effect.runSync(Queue.unbounded<number>()),
    };
    this.#supervisors.set(id, sup);
    sup.fiber = this.#runtime.runFork(this.#supervise(id, sup));
  }

  /** Interrupting the fiber closes its Scope, which closes the link. */
  #stop(id: string): void {
    const sup = this.#supervisors.get(id);
    if (!sup) return;
    this.#supervisors.delete(id);
    this.#runtime.runFork(Fiber.interrupt(sup.fiber));
  }

  /** Connect, serve until the link goes, say why, back off, repeat. Ends only when the desktop has revoked this phone. */
  #supervise(id: string, sup: Supervisor): Effect.Effect<void, never, Relay | Peers> {
    return Effect.gen({ self: this }, function*() {
      let delay = RETRY_MIN_MS;
      for (;;) {
        sup.answered = false;
        const reason = yield* this.#session(id, sup).pipe(Effect.scoped);
        if (REVOKED.has(reason)) {
          this.#patch(id, { status: 'revoked', error: reason, shells: [] });
          return;
        }
        this.#patch(id, { status: 'offline', error: reason, shells: [] });
        // A link that worked is retried promptly; one that never answered backs off.
        if (sup.answered) delay = RETRY_MIN_MS;
        const woken = yield* Effect.raceFirst(
          Effect.sleep(delay).pipe(Effect.as(false)),
          Queue.take(sup.wake).pipe(Effect.as(true)),
        );
        delay = woken ? RETRY_MIN_MS : Math.min(RETRY_MAX_MS, delay * 2);
        // In the background nothing dials; coming back to the foreground wakes every supervisor.
        while (!this.#active) yield* Queue.take(sup.wake);
        yield* Queue.clear(sup.wake);
      }
    });
  }

  /**
   * One connection, from dial to loss; the result is the reason the link ended. The machine counts as
   * online only once it has answered a request: a desktop that no longer trusts this phone completes the
   * handshake and then hangs up.
   */
  #session(id: string, sup: Supervisor): Effect.Effect<string, never, Relay | Peers | Scope.Scope> {
    return Effect.gen({ self: this }, function*() {
      const m = this.#state.machines.find((x) => x.device.id === id);
      if (!m || !this.#key) return yield* Effect.never;
      if (m.status !== 'online') this.#patch(id, { status: 'connecting' });
      const s = this.#state.settings;
      const conn = yield* connect({ relay: { host: s.relayHost, port: s.relayPort }, code: m.device.code, deviceKey: this.#key, expectedDevice: id });
      sup.conn = conn;
      yield* Effect.addFinalizer(() => Effect.sync(() => { if (sup.conn === conn) sup.conn = null; }));
      yield* Queue.clear(sup.pollNow);

      const polling = Effect.gen({ self: this }, function*() {
        let timeout = POLL_TIMEOUT_MS;
        for (;;) {
          yield* this.#poll(id, sup, conn, timeout);
          timeout = yield* Effect.raceFirst(
            Effect.sleep(POLL_MS).pipe(Effect.as(POLL_TIMEOUT_MS)),
            Queue.take(sup.pollNow),
          );
          while (!this.#active) timeout = yield* Queue.take(sup.pollNow);
        }
      });
      // A request that times out means a wedged channel: give it up so the next attempt builds a fresh session.
      const stalled = yield* Effect.raceFirst(
        polling.pipe(Effect.flip, Effect.map((e) => e.code === 'request_timeout')),
        conn.rpc.closed.pipe(Effect.as(false)),
      );
      sup.conn = null;
      if (stalled) return 'request_timeout';
      // The desktop says why it hung up over the relay, and that tends to land just after the channel closes.
      // Waiting for it is what tells "removed on that machine" (stop, pair again) from a dropped link (retry).
      return yield* conn.remoteReason.pipe(Effect.timeoutOrElse({ duration: REASON_GRACE, orElse: () => Effect.succeed('link_lost') }));
    }).pipe(Effect.catch((e) => Effect.succeed(e.reason)));
  }

  /** Fetches projects and live shells. Updates the store only when something changed. */
  #poll(id: string, sup: Supervisor, conn: Connection, timeoutMs: number): Effect.Effect<void, RpcError> {
    return Effect.gen({ self: this }, function*() {
      const [projects, shells] = yield* Effect.all(
        [conn.rpc.call('projects.list', {}, timeoutMs), conn.rpc.call('shells.alive', {}, timeoutMs)],
        { concurrency: 'unbounded' },
      );
      if (sup.conn !== conn) return;
      sup.answered = true;
      const cur = this.#state.machines.find((m) => m.device.id === id);
      if (!cur) return;
      const next = {
        projects: projects.map(({ id: pid, name, path }) => ({ id: pid, name, path })),
        shells: shells.map((sh) => ({ projectId: sh.projectId, shellIndex: sh.shellIndex, agentState: sh.agentState ?? null, name: shellName(sh) })),
      };
      if (cur.loaded && cur.status === 'online' && JSON.stringify({ projects: cur.projects, shells: cur.shells }) === JSON.stringify(next)) return;
      this.#patch(id, { ...next, loaded: true, status: 'online', error: null });
    });
  }
}

function newMachine(device: Device): Machine {
  return { device, status: 'connecting', error: null, projects: [], shells: [], loaded: false };
}

function sortMachines(list: Machine[]): Machine[] {
  return [...list].sort((a, b) => a.device.name.localeCompare(b.device.name) || a.device.id.localeCompare(b.device.id));
}
