import { app } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { RpcMethods, type Params, type Result, type RpcMethodName } from '../../shared/p2p-contract';
import type { Services } from '../services';
import { emitAliveShellsChanged, emitProjectsChanged, handlers } from '../ipc/register';
import { RpcError, type RpcPeer } from './rpc';

/*
 * Server-side RPC hub: one per peer/session. Methods call the same implementations the renderer
 * IPC uses (`handlers` in ipc/register.ts) directly, so the remote and local UI cannot drift.
 */

export interface HubOptions {
  /** Paired device on the other end; recorded in every audit entry. */
  remoteDeviceId: string;
  /** Defaults to the instance given to `setHubServices`. */
  services?: Services;
  /** Test knobs. Defaults: ~/.metaide/logs/p2p-audit.log, 10 MiB. */
  auditLogPath?: string;
  auditMaxBytes?: number;
  /** Local-UI refresh hooks; default to the register.ts broadcasters. Injectable for tests. */
  events?: { aliveShellsChanged(): void; projectsChanged(): void };
}

let defaultServices: Services | null = null;
/** Called once at startup so each per-peer hub can find the main-process services. */
export function setHubServices(s: Services): void {
  defaultServices = s;
}

const AUDIT_MAX_BYTES = 10 * 1024 * 1024;
const AUDIT_BACKUPS = 2;
const FS_READ_MAX_BYTES = 512 * 1024; // keeps the JSON result under the 1 MiB RPC frame cap
/** Replay/live output is chunked so no single `evt` can approach the 1 MiB frame cap (JSON escaping can expand 6x). */
const OUT_CHUNK_CHARS = 64 * 1024;
const SECRET_KEY = /token|secret|password/i;

// ---- audit log ----

export function defaultAuditLogPath(): string {
  return join(homedir(), '.metaide', 'logs', 'p2p-audit.log');
}

/** Redacts secret-looking keys at any depth. */
function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, SECRET_KEY.test(k) ? '<redacted>' : redact(val)]),
    );
  }
  return v;
}

/**
 * Audit-safe params: unknown fields are dropped by the method's schema (`.strip()`) and any
 * token/secret/password key is replaced. `keepUnknown` skips the strip (redaction only) and
 * exists for tests of the redactor itself.
 */
export function scrubParams(method: string, params: unknown, opts: { keepUnknown?: boolean } = {}): unknown {
  const spec = (RpcMethods as Record<string, (typeof RpcMethods)[RpcMethodName]>)[method];
  let p = params;
  if (spec && !opts.keepUnknown) {
    const parsed = (spec.params as unknown as { strip(): { safeParse(v: unknown): { success: boolean; data?: unknown } } })
      .strip()
      .safeParse(params);
    p = parsed.success ? parsed.data : undefined;
  }
  return redact(p);
}

class AuditLog {
  constructor(private readonly path: string, private readonly maxBytes: number) {}

  write(entry: Record<string, unknown>): void {
    try {
      const line = JSON.stringify(entry) + '\n';
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      this.rotateIfNeeded(Buffer.byteLength(line));
      appendFileSync(this.path, line, { mode: 0o600 });
    } catch {
      // Auditing must never take the session down.
    }
  }

  private rotateIfNeeded(incoming: number): void {
    let size = 0;
    try { size = statSync(this.path).size; } catch { return; }
    if (size === 0 || size + incoming <= this.maxBytes) return;
    rmSync(`${this.path}.${AUDIT_BACKUPS}`, { force: true });
    for (let i = AUDIT_BACKUPS - 1; i >= 1; i--) {
      if (existsSync(`${this.path}.${i}`)) renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
    }
    renameSync(this.path, `${this.path}.1`);
  }
}

// ---- path safety ----

function inside(root: string, p: string): boolean {
  return p === root || p.startsWith(root + sep);
}

/** Resolves `requested` under `projectRoot`, or throws path_outside_project. Symlinks are followed before the check. */
function resolveInProject(projectRoot: string, requested: string): string {
  const bad = () => new RpcError('path_outside_project', 'path is outside the project');
  if (requested.includes('\0')) throw bad();
  const root = resolve(projectRoot);
  const abs = resolve(root, requested);
  if (!inside(root, abs)) throw bad();
  try {
    if (!inside(realpathSync(root), realpathSync(abs))) throw bad();
  } catch (err) {
    if (err instanceof RpcError) throw err;
    // Nonexistent target: lexical check above is all there is; the fs call will report ENOENT.
  }
  return abs;
}

// ---- shell attach stream ----

function chunks(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += OUT_CHUNK_CHARS) out.push(s.slice(i, i + OUT_CHUNK_CHARS));
  return out;
}

/**
 * Replays the terminal snapshot, then live output, then `exit`. Hand-rolled iterator (not a
 * generator) so `return()` unsubscribes immediately even while a `next()` is parked: the RPC pump
 * cannot await a generator's `finally` behind a pending `next()`.
 */
function attachStream(s: Services, projectId: number, shellIndex: number): AsyncIterable<unknown> {
  const pty = s.ptyManager;
  if (!pty.isAlive(projectId, shellIndex)) throw new RpcError('unknown_shell', 'no such shell');

  const queue: unknown[] = [];
  let ready = false;
  let waiter: ((r: IteratorResult<unknown>) => void) | null = null;
  let done = false;

  const push = (v: unknown, final = false) => {
    if (done) return;
    queue.push(v);
    if (final) finishAfterDrain = true;
    flush();
  };
  let finishAfterDrain = false;
  const flush = () => {
    if (!waiter || !ready) return;
    if (queue.length > 0) { const w = waiter; waiter = null; w({ value: queue.shift(), done: false }); }
    else if (finishAfterDrain) stop();
  };
  const onData = (ev: { projectId: number; shellIndex: number; data: string }) => {
    if (ev.projectId !== projectId || ev.shellIndex !== shellIndex) return;
    for (const bytes of chunks(ev.data)) push({ kind: 'out', bytes });
  };
  const onExit = (ev: { projectId: number; shellIndex: number; code: number | null }) => {
    if (ev.projectId !== projectId || ev.shellIndex !== shellIndex) return;
    push({ kind: 'exit', code: ev.code }, true);
  };
  // Subscribe and request the snapshot in the same tick: the mirror serializes everything written
  // before this call and nothing after, so live events queued meanwhile follow it with no gap or duplicate.
  pty.on('data', onData);
  pty.on('exit', onExit);
  // byte-based snapshot (RollingScrollback) is line-boundary-safe and strips dangling escape fragments —
  // the right primitive for TUI replay (Claude, OMP).
  void pty.getSnapshot(projectId, shellIndex).then(
    (snap) => { queue.unshift(...chunks(snap).map((bytes) => ({ kind: 'out', bytes }))); ready = true; flush(); },
    () => { ready = true; flush(); },
  );

  const stop = () => {
    done = true;
    pty.off('data', onData);
    pty.off('exit', onExit);
    if (waiter) { const w = waiter; waiter = null; w({ value: undefined, done: true }); }
  };

  const iterator: AsyncIterator<unknown> = {
    next() {
      if (!ready && !done) return new Promise((res) => { waiter = res; });
      if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
      if (done || finishAfterDrain) { stop(); return Promise.resolve({ value: undefined, done: true }); }
      return new Promise((res) => { waiter = res; });
    },
    return() {
      stop();
      return Promise.resolve({ value: undefined, done: true });
    },
  };
  return { [Symbol.asyncIterator]: () => iterator };
}

// ---- wiring ----

export function wireHub(peer: RpcPeer, opts: HubOptions): void {
  const s = opts.services ?? defaultServices;
  if (!s) throw new Error('wireHub: no services (pass opts.services or call setHubServices)');
  const audit = new AuditLog(opts.auditLogPath ?? defaultAuditLogPath(), opts.auditMaxBytes ?? AUDIT_MAX_BYTES);

  const record = (method: string, params: unknown, outcome: 'ok' | { error: string }) =>
    audit.write({ ts: Date.now(), remoteDeviceId: opts.remoteDeviceId, method, params: scrubParams(method, params), outcome });
  const events = opts.events ?? { aliveShellsChanged: emitAliveShellsChanged, projectsChanged: emitProjectsChanged };

  // Every inbound request (including invalid_params / unknown_method rejections that never reach a
  // handler) is audited through the peer's onCall hook; one entry per call, streams at open.
  peer.setOnCall(record);

  /** Registers `impl`; auditing happens in the peer's onCall hook. */
  function on<M extends RpcMethodName>(
    method: M,
    impl: (p: Params<M>) => Promise<Result<M>> | AsyncIterable<unknown>,
  ): void {
    peer.handle(method, impl);
  }

  const projectRoot = (projectId: number): string => {
    const p = s.projects.get(projectId);
    if (!p) throw new RpcError('unknown_project', `no project ${projectId}`);
    return p.path;
  };

  on('device.info', async () => ({
    name: hostname(),
    platform: process.platform,
    version: app.getVersion(),
    uptime: process.uptime(),
  }));

  on('projects.list', async () => (await handlers['projects:list'](s, undefined as never)).projects.map((p) => ({ ...p })));

  on('projects.get', async ({ id }) => {
    const p = s.projects.get(id);
    if (!p) throw new RpcError('unknown_project', `no project ${id}`);
    return { ...p };
  });

  on('shells.list', async ({ projectId }) => {
    const { shells } = await handlers['shells:alive-list'](s, undefined as never);
    return shells.filter((r) => r.projectId === projectId).map((r) => ({ ...r }));
  });

  // RpcError messages below are fixed strings, safe to send to the peer.
  on('shells.launch', async ({ projectId, forceFirst }) => {
    const r = await handlers['shells:launch'](s, { projectId, forceFirst });
    // The ipcMain wrapper normally broadcasts these; the hub bypasses it.
    events.aliveShellsChanged();
    events.projectsChanged();
    return r as { shellIndex: number };
  });

  on('shells.kill', async ({ projectId, shellIndex }) => {
    await handlers['shells:kill'](s, { projectId, shellIndex });
    events.aliveShellsChanged();
    return { ok: true } as const;
  });

  on('shells.attach', ({ projectId, shellIndex }) => attachStream(s, projectId, shellIndex));

  on('fs.list', async ({ projectId, path }) => {
    const abs = resolveInProject(projectRoot(projectId), path);
    return readdirSync(abs, { withFileTypes: true }).map((d) => {
      let size: number | undefined;
      if (!d.isDirectory()) { try { size = statSync(join(abs, d.name)).size; } catch { /* raced away */ } }
      return { name: d.name, isDir: d.isDirectory(), ...(size === undefined ? {} : { size }) };
    });
  });

  on('fs.read', async ({ projectId, path }) => {
    const abs = resolveInProject(projectRoot(projectId), path);
    const st = statSync(abs);
    if (st.isDirectory()) throw new RpcError('is_directory', 'path is a directory');
    if (st.size > FS_READ_MAX_BYTES) throw new RpcError('file_too_large', `file exceeds ${FS_READ_MAX_BYTES} bytes`);
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8192).includes(0)) throw new RpcError('binary_file', 'binary files are not supported');
    return { content: buf.toString('utf8'), encoding: 'utf8' as const };
  });
}
