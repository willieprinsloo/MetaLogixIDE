/**
 * App state: paired desktops, one live link each, and their active projects. Framework-free
 * (subscribe/getSnapshot) so React binds to it with useSyncExternalStore.
 */
import { base64Encode, fromHex, toHex, utf8Encode } from './bytes';
import { connect, pairWith, REASON_GRACE_MS, type Connection, type Platform } from './link';
import { canonicalPubHex, deviceKeyFromSeed, type DeviceKey } from './noise';
import { RpcError, type AgentState, type Project, type ShellInfo } from './rpc';


export type Device = { id: string; name: string; code: string; addedAt: number };
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

export interface Storage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /** The device key seed (hex) lives in the platform keychain, apart from ordinary settings. */
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
}

export interface FleetDeps {
  platform: Platform;
  storage: Storage;
  randomBytes(n: number): Uint8Array;
  defaultDeviceName: string;
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
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 30_000;
const CONNECT_CODE_RE = /^[A-Za-z0-9-]{4,32}$/;

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

interface Runner {
  conn: Connection | null;
  dialing: boolean;
  retryDelay: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  polling: boolean;
}

export class Fleet {
  #state: FleetState;
  #key: DeviceKey | null = null;
  #listeners = new Set<() => void>();
  #runners = new Map<string, Runner>();
  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #active = true;
  #init: Promise<void> | null = null;

  constructor(private readonly deps: FleetDeps) {
    this.#state = {
      ready: false,
      machines: [],
      settings: { relayHost: DEFAULT_RELAY.host, relayPort: DEFAULT_RELAY.port, deviceName: deps.defaultDeviceName },
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
    return (this.#init ??= (async () => {
      const { storage } = this.deps;
      let seedHex = await storage.getSecret('device_key');
      if (!seedHex || !/^[0-9a-f]{64}$/.test(seedHex)) {
        seedHex = toHex(this.deps.randomBytes(32));
        await storage.setSecret('device_key', seedHex);
      }
      this.#key = deviceKeyFromSeed(fromHex(seedHex));
      let settings = this.#state.settings;
      let devices: Device[] = [];
      try { settings = { ...settings, ...(JSON.parse((await storage.get('settings')) ?? '{}') as Partial<Settings>) }; } catch { /* keep defaults */ }
      try {
        const raw = JSON.parse((await storage.get('devices')) ?? '[]') as Device[];
        if (Array.isArray(raw)) devices = raw.filter((d) => d && typeof d.id === 'string' && typeof d.code === 'string' && typeof d.name === 'string');
      } catch { /* start empty */ }
      this.#set({ ready: true, settings, machines: sortMachines(devices.map(newMachine)) });
      for (const d of devices) this.#dial(d.id);
      this.#pollTimer = setInterval(() => this.#pollAll(), POLL_MS);
    })());
  }

  // ---- pairing and settings ----

  /** Pairs with the desktop whose "Pair a new machine" window shows `code`. Rejects with a reason code. */
  async pair(code: string): Promise<Device> {
    await this.init();
    const trimmed = code.trim();
    if (!CONNECT_CODE_RE.test(trimmed)) throw new Error('invalid_code');
    const s = this.#state.settings;
    const r = await pairWith({
      platform: this.deps.platform,
      relay: { host: s.relayHost, port: s.relayPort },
      code: trimmed,
      deviceKey: this.#key!,
      deviceName: s.deviceName,
    });
    const device: Device = { id: r.deviceId, name: r.name, code: r.code, addedAt: Date.now() };
    this.#teardown(device.id);
    const machines = this.#state.machines.filter((m) => m.device.id !== device.id);
    machines.push(newMachine(device));
    this.#set({ machines: sortMachines(machines) });
    await this.#persistDevices();
    this.#dial(device.id);
    return device;
  }

  async remove(id: string): Promise<void> {
    this.#teardown(id);
    this.#set({ machines: this.#state.machines.filter((m) => m.device.id !== id) });
    await this.#persistDevices();
  }

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    const cur = this.#state.settings;
    const next: Settings = {
      relayHost: (patch.relayHost ?? cur.relayHost).trim() || DEFAULT_RELAY.host,
      relayPort: Number.isInteger(patch.relayPort) && patch.relayPort! > 0 && patch.relayPort! < 65536 ? patch.relayPort! : cur.relayPort,
      deviceName: (patch.deviceName ?? cur.deviceName).trim().slice(0, 80) || this.deps.defaultDeviceName,
    };
    this.#set({ settings: next });
    await this.deps.storage.set('settings', JSON.stringify(next));
    if (next.relayHost !== cur.relayHost || next.relayPort !== cur.relayPort) {
      for (const m of this.#state.machines) { this.#teardown(m.device.id); this.#dial(m.device.id); }
    }
  }

  // ---- lifecycle ----

  /** Foreground/background. Coming back, links the OS killed are found by a short probe and redialled at once. */
  setActive(active: boolean): void {
    if (this.#active === active) return;
    this.#active = active;
    if (!active) return;
    for (const m of this.#state.machines) {
      const r = this.#runner(m.device.id);
      if (r.conn) void this.#poll(m.device.id, 4000);
      else if (m.status !== 'revoked') this.reconnect(m.device.id);
    }
  }

  /** Drops any pending back-off and dials now. */
  reconnect(id: string): void {
    const r = this.#runner(id);
    if (r.retryTimer) { clearTimeout(r.retryTimer); r.retryTimer = null; }
    r.retryDelay = RETRY_MIN_MS;
    if (r.conn) void this.#poll(id, 4000);
    else this.#dial(id);
  }

  refresh(id: string): Promise<void> {
    const r = this.#runner(id);
    if (!r.conn) { this.reconnect(id); return Promise.resolve(); }
    return this.#poll(id, POLL_TIMEOUT_MS);
  }

  // ---- shells ----

  /** Attaches to a live shell: the host replays the screen, then streams output. */
  openShell(id: string, projectId: number, shellIndex: number, ev: ShellEvents): ShellSession {
    const conn = this.#runner(id).conn;
    if (!conn) {
      let cancelled = false;
      setTimeout(() => { if (!cancelled) ev.onClose('offline'); }, 0);
      return { send() {}, resize() {}, close() { cancelled = true; } };
    }
    let closedLocally = false;
    let ended = false;
    const handle = conn.rpc.attach(
      { projectId, shellIndex },
      (data) => {
        const d = data as { kind?: string; bytes?: unknown; code?: number | null } | null;
        if (!d) return;
        if (d.kind === 'out' && typeof d.bytes === 'string') ev.onData(d.bytes);
        else if (d.kind === 'exit') ev.onExit(d.code ?? null);
      },
      (reason) => { ended = true; if (!closedLocally) ev.onClose(reason); },
    );
    handle.ready.catch(() => { /* reported through onClose */ });

    // Keystrokes go out one request at a time, in order; anything typed meanwhile is coalesced.
    let buffer = '';
    let sending = false;
    const pump = () => {
      if (sending || !buffer || ended) return;
      sending = true;
      const text = buffer;
      buffer = '';
      handle.ready
        .then((stream) => conn.rpc.call('shells.input', { stream, bytes: base64Encode(utf8Encode(text)) }))
        .catch(() => { /* a dead link ends the stream, which the UI shows */ })
        .finally(() => { sending = false; pump(); });
    };
    let size: { cols: number; rows: number } | null = null;
    let resizing = false;
    const pumpResize = () => {
      if (resizing || !size || ended) return;
      resizing = true;
      const s = size;
      size = null;
      handle.ready
        .then((stream) => conn.rpc.call('shells.resize', { stream, cols: s.cols, rows: s.rows }))
        .catch(() => {})
        .finally(() => { resizing = false; pumpResize(); });
    };

    return {
      send: (text) => { if (!ended && text) { buffer += text; pump(); } },
      resize: (cols, rows) => {
        if (ended || !(cols > 0) || !(rows > 0)) return;
        size = { cols: Math.floor(cols), rows: Math.floor(rows) };
        pumpResize();
      },
      close: () => { closedLocally = true; handle.close(); },
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

  #runner(id: string): Runner {
    let r = this.#runners.get(id);
    if (!r) this.#runners.set(id, (r = { conn: null, dialing: false, retryDelay: RETRY_MIN_MS, retryTimer: null, polling: false }));
    return r;
  }

  #persistDevices(): Promise<void> {
    return this.deps.storage.set('devices', JSON.stringify(this.#state.machines.map((m) => m.device)));
  }

  #teardown(id: string): void {
    const r = this.#runners.get(id);
    if (!r) return;
    this.#runners.delete(id); // first, so the close callback below sees a stale runner and does nothing
    if (r.retryTimer) clearTimeout(r.retryTimer);
    r.conn?.close();
  }

  #dial(id: string): void {
    const m = this.#state.machines.find((x) => x.device.id === id);
    const r = this.#runner(id);
    if (!m || !this.#key || r.conn || r.dialing) return;
    r.dialing = true;
    if (m.status !== 'online') this.#patch(id, { status: 'connecting' });
    const s = this.#state.settings;
    connect({
      platform: this.deps.platform,
      relay: { host: s.relayHost, port: s.relayPort },
      code: m.device.code,
      deviceKey: this.#key,
      expectedDevice: id,
    }).then(
      (conn) => {
        r.dialing = false;
        if (this.#runners.get(id) !== r) { conn.close(); return; } // removed or re-paired meanwhile
        r.conn = conn;
        conn.rpc.onClosed(() => this.#onDrop(id, r, conn));
        if (conn.rpc.closed) { this.#onDrop(id, r, conn); return; }
        // Not online yet: a host that no longer trusts this phone completes the handshake and then hangs
        // up. The machine counts as online, and the retry back-off resets, once it has answered a request.
        void this.#poll(id, POLL_TIMEOUT_MS);
      },
      (e: unknown) => {
        r.dialing = false;
        if (this.#runners.get(id) !== r) return;
        this.#fail(id, r, e instanceof Error ? e.message : String(e));
      },
    );
  }

  #onDrop(id: string, r: Runner, conn: Connection): void {
    if (r.conn !== conn) return;
    r.conn = null;
    if (this.#runners.get(id) !== r) return;
    const settle = (): void => {
      if (this.#runners.get(id) === r) this.#fail(id, r, conn.remoteReason() ?? 'link_lost');
    };
    if (conn.remoteReason()) { settle(); return; }
    // The host's reason travels over the relay and tends to land just after the channel closes. Waiting for
    // it is what tells "removed on that machine" (stop, pair again) from a dropped link (retry).
    const started = Date.now();
    const wait = setInterval(() => {
      if (conn.remoteReason() || Date.now() - started >= REASON_GRACE_MS) { clearInterval(wait); settle(); }
    }, 50);
  }

  #fail(id: string, r: Runner, reason: string): void {
    // The desktop no longer trusts this phone (removed there): retrying cannot help, it needs a new pairing.
    if (reason === 'untrusted_device' || reason === 'revoked' || reason === 'trust_failed') {
      this.#patch(id, { status: 'revoked', error: reason, shells: [] });
      return;
    }
    this.#patch(id, { status: 'offline', error: reason, shells: [] });
    if (r.retryTimer) clearTimeout(r.retryTimer);
    const delay = r.retryDelay;
    r.retryDelay = Math.min(RETRY_MAX_MS, delay * 2);
    r.retryTimer = setTimeout(() => {
      r.retryTimer = null;
      if (this.#active && this.#runners.get(id) === r) this.#dial(id);
    }, delay);
  }

  #pollAll(): void {
    if (!this.#active) return;
    for (const m of this.#state.machines) if (this.#runners.get(m.device.id)?.conn) void this.#poll(m.device.id, POLL_TIMEOUT_MS);
  }

  async #poll(id: string, timeoutMs: number): Promise<void> {
    const r = this.#runner(id);
    const conn = r.conn;
    if (!conn || r.polling) return;
    r.polling = true;
    try {
      const [projects, shells] = await Promise.all([
        conn.rpc.call('projects.list', {}, timeoutMs),
        conn.rpc.call('shells.alive', {}, timeoutMs),
      ]);
      if (r.conn !== conn) return;
      const cur = this.#state.machines.find((m) => m.device.id === id);
      if (!cur) return;
      const next = { projects: projects.map(({ id: pid, name, path }) => ({ id: pid, name, path })), shells: shells.map((s) => ({ projectId: s.projectId, shellIndex: s.shellIndex, agentState: s.agentState ?? null, name: shellName(s) })) };
      // Skip the store update (and the re-render) when nothing changed.
      r.retryDelay = RETRY_MIN_MS; // the link works: the next drop is retried promptly
      if (cur.loaded && cur.status === 'online' && JSON.stringify({ projects: cur.projects, shells: cur.shells }) === JSON.stringify(next)) return;
      this.#patch(id, { ...next, loaded: true, status: 'online', error: null });
    } catch (e) {
      // A wedged data channel answers nothing: drop it so the retry builds a fresh session.
      if (e instanceof RpcError && e.code === 'request_timeout' && r.conn === conn) conn.close();
    } finally {
      r.polling = false;
    }
  }
}

function newMachine(device: Device): Machine {
  return { device, status: 'connecting', error: null, projects: [], shells: [], loaded: false };
}

function sortMachines(list: Machine[]): Machine[] {
  return [...list].sort((a, b) => a.device.name.localeCompare(b.device.name) || a.device.id.localeCompare(b.device.id));
}
