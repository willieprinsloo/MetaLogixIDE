import { app } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { RpcMethods, type Params, type Result, type RpcMethodName } from '../../shared/p2p-contract';
import type { Services } from '../services';
import { emitAliveShellsChanged, emitProjectsChanged, handlers } from '../ipc/register';
import { RpcError, type HandlerContext, type RpcPeer } from './rpc';
import { safeFileName } from '../drops/file-name';
import { createUploadQuota, createUploadService, type UploadOutcome, type UploadQuota } from './uploads';
import { registerWorkspace } from './workspace';
import { nodeWorkspaceRootFs, type WorkspaceRootPolicy } from './workspace-root-policy';

/*
 * Server-side RPC hub: one per peer/session. Methods call the same implementations the renderer
 * IPC uses (`handlers` in ipc/register.ts) directly, so the remote and local UI cannot drift.
 */

export interface HubOptions {
  /** Paired device on the other end; recorded in every audit entry. */
  remoteDeviceId: string;
  /** Host-authenticated desktop peer. Omission never grants workspace access. */
  desktopWorkspaceAllowed?: boolean | (() => boolean);
  /** Runtime identity storage, which can live under a different home than the services. */
  workspaceIdentityPaths?: readonly string[];
  /** Defaults to the instance given to `setHubServices`. */
  services?: Services;
  /** Test knobs. Defaults: ~/.metaide/logs/p2p-audit.log, 10 MiB. */
  auditLogPath?: string;
  auditMaxBytes?: number;
  /** Local-UI refresh hooks; default to the register.ts broadcasters. Injectable for tests. */
  events?: { aliveShellsChanged(): void; projectsChanged(): void };
  /** Test knob; defaults to the one host-wide quota every link shares (AC-U8). */
  uploadQuota?: UploadQuota;
}

/** The host's single upload quota: caps count across all links, not per link. */
const hostUploadQuota = createUploadQuota();

/** Returned by `wireHub`; the link owner calls `dispose` when the link closes. */
export interface HubHandle {
  /** Aborts this link's in-progress uploads so no partial file outlives it (AC-U6). */
  dispose(): Promise<void>;
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
const RegisteredRoots = z.array(z.object({ id: z.number(), path: z.string().min(1) }));
const DatabaseFiles = z.array(z.object({ file: z.string() }));

function hostWorkspacePolicy(s: Services, auditPath: string, identityPaths: readonly string[]): WorkspaceRootPolicy {
  return {
    fs: nodeWorkspaceRootFs,
    protectedPaths() {
      const settingsPath = s.hookRuntime.settingsPath();
      const databasePaths = DatabaseFiles.parse(s.db.pragma('database_list')).flatMap(({ file }) => file ? [file] : []);
      // Include both SQLite's actual filename and the supplied spelling (which may be an alias).
      if (!s.db.memory) databasePaths.push(s.db.name);
      return [
        ...identityPaths,
        join(s.homeDir, '.metaide'),
        app.getPath('userData'),
        s.dropStaging.dir,
        ...(settingsPath === null ? [] : [settingsPath]),
        ...databasePaths.flatMap((path) => [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]),
        auditPath,
        ...Array.from({ length: AUDIT_BACKUPS }, (_, i) => `${auditPath}.${i + 1}`),
      ];
    },
    registeredRoots() {
      // ProjectsRepo.list() is a UI list and excludes hidden projects.
      return RegisteredRoots.parse(s.db.prepare('SELECT id, path FROM projects').all());
    },
  };
}

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

type ParamScrubber = (p: Record<string, unknown>) => Record<string, unknown>;

/** Per-method rewrites of payloads that would put user content in the audit log. */
const PARAM_SCRUBBERS: ReadonlyMap<string, ParamScrubber> = new Map(Object.entries({
  // Keystrokes may include passwords: log only the size.
  'shells.input': ({ bytes, ...rest }) => ({ ...rest, bytes: typeof bytes === 'string' ? `<${bytes.length} b64 chars>` : undefined }),
  'drops.uploadChunk': ({ data, ...rest }) => ({ ...rest, data: `<${String(data).length} b64 chars>` }),
  'drops.uploadBegin': (p) => {
    const { name, mime } = p as { name: string; mime: string };
    return { ...p, name: safeFileName(name, mime, new Date()) };
  },
  'workspace.fileWrite': ({ projectId, relPath }) => ({ projectId, relPath }),
  'workspace.agentSettings': () => ({}),
  'workspace.setDefaultAgent': () => ({}),
} satisfies Record<string, ParamScrubber>));

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
  const scrub = PARAM_SCRUBBERS.get(method);
  if (scrub && p && typeof p === 'object') p = scrub(p as Record<string, unknown>);
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
function attachStream(
  s: Services, projectId: number, shellIndex: number,
  registry: Map<number, { projectId: number; shellIndex: number }>, streamId: number | undefined,
): AsyncIterable<unknown> {
  const pty = s.ptyManager;
  if (!pty.isAlive(projectId, shellIndex)) throw new RpcError('unknown_shell', 'no such shell');
  if (streamId !== undefined) registry.set(streamId, { projectId, shellIndex });

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
  // the right primitive for TUI replay (Claude).
  void pty.getSnapshot(projectId, shellIndex).then(
    (snap) => { queue.unshift(...chunks(snap).map((bytes) => ({ kind: 'out', bytes }))); ready = true; flush(); },
    () => { ready = true; flush(); },
  );

  const stop = () => {
    done = true;
    if (streamId !== undefined) registry.delete(streamId);
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

/**
 * Registers every RPC method on `peer` for one link and returns the handle whose
 * `dispose` must be called when that link closes.
 */
export function wireHub(peer: RpcPeer, opts: HubOptions): HubHandle {
  const s = opts.services ?? defaultServices;
  if (!s) throw new Error('wireHub: no services (pass opts.services or call setHubServices)');
  const auditPath = opts.auditLogPath ?? defaultAuditLogPath();
  const audit = new AuditLog(auditPath, opts.auditMaxBytes ?? AUDIT_MAX_BYTES);

  const record = (method: string, params: unknown, outcome: 'ok' | { error: string }) =>
    audit.write({ ts: Date.now(), remoteDeviceId: opts.remoteDeviceId, method, params: scrubParams(method, params), outcome });
  const events = opts.events ?? { aliveShellsChanged: emitAliveShellsChanged, projectsChanged: emitProjectsChanged };

  // Every inbound request (including invalid_params / unknown_method rejections that never reach a
  // handler) is audited through the peer's onCall hook; one entry per call, streams at open.
  peer.setOnCall(record);
  const workspaceAllowed = opts.desktopWorkspaceAllowed;
  registerWorkspace(
    peer, s, () => typeof workspaceAllowed === 'function' ? workspaceAllowed() : workspaceAllowed === true,
    events.projectsChanged, hostWorkspacePolicy(s, auditPath, opts.workspaceIdentityPaths ?? []),
  );

  /** Registers `impl`; auditing happens in the peer's onCall hook. */
  function on<M extends RpcMethodName>(
    method: M,
    impl: (p: Params<M>, ctx: HandlerContext) => Promise<Result<M>> | AsyncIterable<unknown>,
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

  on('roots.list', async () => (await handlers['roots:list'](s, undefined as never)).roots.map((r) => ({ ...r })));

  on('shells.list', async ({ projectId }) => {
    const { shells } = await handlers['shells:alive-list'](s, undefined as never);
    return shells.filter((r) => r.projectId === projectId).map((r) => ({ ...r }));
  });

  on('shells.alive', async () => {
    const { shells } = await handlers['shells:alive-list'](s, undefined as never);
    if (!s.agentStatus) return shells.map((r) => ({ ...r }));
    const states = new Map(s.agentStatus.list().map((e) => [`${e.projectId}:${e.shellIndex}`, e]));
    // `agent` lets the viewer label a tab by what runs in it now (a terminal where opencode was started).
    return shells.map((r) => {
      const e = states.get(`${r.projectId}:${r.shellIndex}`);
      return { ...r, agentState: e?.state ?? null, agent: e?.agent ?? null };
    });
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

  // Active shells.attach streams on this peer, by wire stream id. Input/resize only act on these.
  const attached = new Map<number, { projectId: number; shellIndex: number }>();
  on('shells.attach', ({ projectId, shellIndex }, ctx) => attachStream(s, projectId, shellIndex, attached, ctx.stream));

  on('shells.input', async ({ stream, bytes }) => {
    const a = attached.get(stream);
    if (!a) throw new RpcError('unknown_stream', 'stream not attached');
    s.ptyManager.write(a.projectId, a.shellIndex, Buffer.from(bytes, 'base64').toString('utf8'));
    return { ok: true } as const;
  });

  on('shells.resize', async ({ stream, cols, rows }) => {
    const a = attached.get(stream);
    if (!a) throw new RpcError('unknown_stream', 'stream not attached');
    s.ptyManager.resize(a.projectId, a.shellIndex, cols, rows);
    return { ok: true } as const;
  });

  on('fs.list', async ({ projectId, path }) => {
    const abs = resolveInProject(projectRoot(projectId), path);
    return readdirSync(abs, { withFileTypes: true }).map((d) => {
      let size: number | undefined;
      if (!d.isDirectory()) { try { size = (d.isSymbolicLink() ? lstatSync(join(abs, d.name)) : statSync(join(abs, d.name))).size; } catch { /* raced away */ } }
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

  // Agent notices for the IDE instance in use (src/main/notifications/notice-router.ts). The peer is
  // eligible only while it holds a notices.subscribe stream; its presence reports say how recently it was used.
  const noticePeer = s.noticeRouter?.register() ?? null;
  on('presence.set', async ({ idleMs }) => {
    noticePeer?.setIdle(idleMs);
    return { ok: true } as const;
  });
  on('notices.subscribe', () => {
    if (!noticePeer) throw new RpcError('unsupported', 'notices are not available');
    return noticePeer.stream();
  });

  // Upload sessions are scoped to this link (B-S2); the caps are host-wide via the shared quota.
  const uploads = createUploadService({
    staging: s.dropStaging,
    platform: process.platform,
    quota: opts.uploadQuota ?? hostUploadQuota,
    remoteDeviceId: opts.remoteDeviceId,
    onOutcome: (o: UploadOutcome) => audit.write({ ts: Date.now(), remoteDeviceId: opts.remoteDeviceId, method: 'drops.upload', ...o }),
  });
  on('drops.uploadBegin', (p) => uploads.begin(p));
  on('drops.uploadChunk', (p) => uploads.chunk(p));
  on('drops.uploadCommit', (p) => uploads.commit(p));
  on('drops.uploadAbort', (p) => uploads.abort(p));

  return { dispose: async () => { noticePeer?.dispose(); await uploads.disposeAll(); } };
}
