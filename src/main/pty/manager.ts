import { randomUUID } from 'node:crypto';
import { isClaudeArgv } from '@main/domain/claude-permission-mode';
import { isOmpArgv, OMP_SPAWN_ENV } from '@main/agent-status/omp-launch';
import type { AgentKind } from '@shared/agent-state';
import { EventEmitter } from 'node:events';
import type { IPty } from 'node-pty';
import { spawn as ptySpawn } from 'node-pty';
import type { ResolvedLaunch } from '@main/domain/launch';
import { toSpawnableArgv } from '@main/domain/shell';
import { ScreenMirror } from './screen-mirror';

interface Entry {
  projectId: number; shellIndex: number;
  pty: IPty; pid: number;
  generation: string; agent: AgentKind | null;
  cols: number; rows: number;
  startedAt: number;
  earlyBuffer: string;   // captured output within the first 3s
  bufferOpen: boolean;
  /** Rolling raw output (most recent ≤256 KiB), used by scrollback search. Viewports replay `getSnapshot` instead. */
  scrollback: RollingScrollback;
  /** Headless terminal fed every output byte; the source of `getSnapshot`. */
  screen: ScreenMirror;
  /**
   * ms epoch when the user last submitted a line (input containing \r). We
   * fire the "command completed" notification only for commands that have
   * been running for more than DONE_MIN_MS — no ping for `ls`.
   */
  cmdStartedAt: number | null;
  /** ms epoch of the last pty:data event. Used to detect idle after work. */
  lastDataAt: number;
  /** Guard so the same command fires exactly one notification. */
  cmdNotified: boolean;
  /** Ports the shell announced via "listening on 3000" / "Local: http://…" etc. */
  ports: Set<number>;
  /** Output received but not yet emitted; flushed as one `data` event per OUTPUT_FLUSH_MS. */
  pending: string[];
  flushTimer: ReturnType<typeof setTimeout> | null;
}

const key = (p: number, s: number) => `${p}:${s}`;
const EARLY_BUFFER_MS = 3000;
const EARLY_BUFFER_CAP = 32 * 1024;
const SCROLLBACK_CAP = 256 * 1024;   // 256 KiB rolling
const DONE_MIN_MS  = 8_000;   // ignore commands shorter than 8s
const DONE_IDLE_MS = 1_200;   // no data for 1.2s ⇒ "command is done"
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
/** Coalescing window for PTY output: under one 60 Hz frame, and the same 5 ms VS Code's terminal data bufferer uses. */
const OUTPUT_FLUSH_MS = 5;

/** Regex bank for port-detection. Each match's group 1 is the port number. */
const PORT_PATTERNS: RegExp[] = [
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)[:](\d{2,5})\b/gi,
  /\blistening on (?:port )?(?:.*?)?(\d{2,5})\b/gi,
  /\b(?:port|Port)[:\s=]+(\d{2,5})\b/g,
  /\bserver (?:started|running|listen(?:ing)?)[^0-9]{0,32}(\d{2,5})\b/gi,
];
/** Very few processes bind < 1024 without root; ignore those to cut noise. */
const MIN_PORT = 1024;
const MAX_PORT = 65535;

/** Rewrites spawn argv/env for optional agent integrations without changing the persisted launch. */
export type SpawnDecorator = (projectId: number, shellIndex: number, launch: ResolvedLaunch) => ResolvedLaunch;

/** Optional collaborators; without a decorator every launch spawns as given. */
export interface PtyManagerOptions {
  spawnDecorator?: SpawnDecorator;
}

/** Owns live PTYs and generation-bound launch identities independent of process labels. */
export class PtyManager extends EventEmitter {
  /** Returns current spawn identity, never the outer Windows cmd.exe process label. */
  liveShell(projectId: number, shellIndex: number): { pid: number; generation: string; agent: AgentKind | null } | null {
    const entry = this.entries.get(key(projectId, shellIndex));
    return entry ? { pid: entry.pid, generation: entry.generation, agent: entry.agent } : null;
  }

  /** Samples a live viewport and terminal title after the parser drains. */
  liveStatus(projectId: number, shellIndex: number): Promise<{ rows: string[]; title: string }> {
    return this.entries.get(key(projectId, shellIndex))?.screen.liveStatus() ?? Promise.resolve({ rows: [], title: '' });
  }

  private entries = new Map<string, Entry>();
  /** Last size the viewport asked for, per shell — outlives the PTY so a spawn can honour it. */
  private requestedSizes = new Map<string, { cols: number; rows: number }>();
  private readonly spawnDecorator: SpawnDecorator | undefined;

  constructor(opts: PtyManagerOptions = {}) {
    super();
    this.spawnDecorator = opts.spawnDecorator;
  }

  /**
   * Spawn the PTY for (projectId, shellIndex). Size precedence: explicit
   * `cols`/`rows`, then the last size passed to `resize` for this shell,
   * then 100x30. The `spawnDecorator`, when set, rewrites the launch just
   * before spawning; `launch` itself is never modified.
   */
  async spawn(projectId: number, shellIndex: number, launch: ResolvedLaunch, cols?: number, rows?: number): Promise<{ pid: number }> {
    const k = key(projectId, shellIndex);
    if (this.entries.has(k)) throw new Error(`already spawned: ${k}`);
    const requested = this.requestedSizes.get(k);
    cols ??= requested?.cols ?? DEFAULT_COLS;
    rows ??= requested?.rows ?? DEFAULT_ROWS;
    const effective = this.spawnDecorator ? this.spawnDecorator(projectId, shellIndex, launch) : launch;
    const [command, ...args] = toSpawnableArgv(effective.argv);
    if (!command) throw new Error('empty argv');
    const pty = ptySpawn(command, args, {
      name: 'xterm-256color',
      cols, rows,
      cwd: effective.cwd,
      env: { ...process.env, ...effective.env } as { [k: string]: string },
    });
    const entry: Entry = {
      projectId, shellIndex, pty, pid: pty.pid, cols, rows,
      generation: randomUUID(), agent: isClaudeArgv(launch.argv) ? 'claude' : isOmpArgv(launch.argv) ? 'omp' : null,
      startedAt: Date.now(), earlyBuffer: '', bufferOpen: true,
      scrollback: new RollingScrollback(), screen: new ScreenMirror(cols, rows),
      cmdStartedAt: null, lastDataAt: Date.now(), cmdNotified: false,
      ports: new Set<number>(),
      pending: [], flushTimer: null,
    };
    this.entries.set(k, entry);
    pty.onData((data: string) => this.receive(entry, data));
    setTimeout(() => { entry.bufferOpen = false; entry.earlyBuffer = ''; }, EARLY_BUFFER_MS);
    pty.onExit(({ exitCode }: { exitCode: number }) => {
      const captured = entry.earlyBuffer;
      const uptimeMs = Date.now() - entry.startedAt;
      this.flushOutput(entry);
      this.releaseEntry(k, entry);
      this.emit('exit', { projectId, shellIndex, code: exitCode, uptimeMs, earlyOutput: captured });
    });
    this.emit('spawn', { projectId, shellIndex, pid: pty.pid, generation: entry.generation, agent: entry.agent, ompSpawn: entry.agent === 'omp' ? effective.env[OMP_SPAWN_ENV] : undefined });
    return { pid: pty.pid };
  }

  getEarlyBuffer(projectId: number, shellIndex: number): string {
    return this.entries.get(key(projectId, shellIndex))?.earlyBuffer ?? '';
  }

  /** Rolling raw output (most recent ≤256 KiB) for text search. Empty if the shell isn't alive. Not a replay source: use `getSnapshot`. */
  getScrollback(projectId: number, shellIndex: number): string {
    return this.entries.get(key(projectId, shellIndex))?.scrollback.read() ?? '';
  }

  /**
   * Serialized terminal state (screen, scrollback, SGR, cursor) of the live
   * shell, for a remounting viewport to replay into a terminal of the same
   * size. Resolves '' if the shell is unknown or has exited.
   */
  async getSnapshot(projectId: number, shellIndex: number): Promise<string> {
    return this.entries.get(key(projectId, shellIndex))?.screen.snapshot() ?? '';
  }

  /**
   * Writes `data` to the live shell's PTY, then emits
   * `'input' { projectId, shellIndex, data }` — the single choke point every
   * input path (keystrokes, prompt paste, drag-drop) goes through. A shell
   * that is not alive gets neither the write nor the event.
   */
  write(projectId: number, shellIndex: number, data: string): void {
    const e = this.entries.get(key(projectId, shellIndex));
    if (!e) return;
    // `\r` (Enter) is our "new command" signal. Reset the notified flag so
    // the NEXT long-running command earns its own notification.
    if (data.includes('\r')) {
      e.cmdStartedAt = Date.now();
      e.cmdNotified = false;
    }
    e.pty.write(data);
    // A pending, not-yet-flushed chunk can be announcing a port right now; flush it
    // so the port is scanned and emitted before Ctrl-C clears it, or the next flush
    // re-adds a port the user just interrupted.
    if (data.includes('\x03')) {
      this.flushOutput(e);
      this.clearPorts(e);
    }
    this.emit('input', { projectId, shellIndex, data });
  }

  /**
   * Called on a poll interval by the main-process caller. Returns the list of
   * shells whose command just finished (long enough to warrant a ping AND
   * idle for DONE_IDLE_MS since the last data). Marks them notified so we
   * only emit once per command. Bundled into a batch getter so the caller
   * fires a single `for` loop of OS notifications per tick.
   */
  pollDoneCommands(): Array<{ projectId: number; shellIndex: number; durationMs: number }> {
    const now = Date.now();
    const done: Array<{ projectId: number; shellIndex: number; durationMs: number }> = [];
    for (const e of this.entries.values()) {
      if (e.cmdNotified) continue;
      if (!e.cmdStartedAt) continue;
      const idle = now - e.lastDataAt;
      const duration = e.lastDataAt - e.cmdStartedAt;
      if (idle >= DONE_IDLE_MS && duration >= DONE_MIN_MS) {
        e.cmdNotified = true;
        done.push({ projectId: e.projectId, shellIndex: e.shellIndex, durationMs: duration });
      }
    }
    return done;
  }

  /**
   * Live liveness snapshot for the status-bar shells popover. Cheap: no
   * shelling out here — the caller does `ps` itself with the returned pid
   * so the sampler stays in one place.
   */
  liveShells(): Array<{ projectId: number; shellIndex: number; pid: number; startedAt: number; lastDataAt: number }> {
    return Array.from(this.entries.values()).map((e) => ({
      projectId: e.projectId,
      shellIndex: e.shellIndex,
      pid: e.pid,
      startedAt: e.startedAt,
      lastDataAt: e.lastDataAt,
    }));
  }

  /**
   * Grep every live shell's rolling scrollback for `query`. Returns matching
   * lines with a small context window. ANSI escape sequences are stripped
   * before matching so `\x1b[31m error \x1b[0m` still hits on `error`. Case
   * insensitive by default; `regex: true` runs the query as a pattern.
   */
  searchScrollback(query: string, opts: { caseSensitive?: boolean; regex?: boolean; contextLines?: number; maxPerShell?: number } = {}): Array<{
    projectId: number; shellIndex: number; pid: number;
    line: string; lineNumber: number; contextBefore: string[]; contextAfter: string[];
  }> {
    if (!query) return [];
    const flags = opts.caseSensitive ? 'g' : 'gi';
    let re: RegExp;
    try {
      re = opts.regex
        ? new RegExp(query, flags)
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    } catch { return []; }
    const contextLines = Math.max(0, Math.min(5, opts.contextLines ?? 1));
    const maxPerShell = Math.max(1, opts.maxPerShell ?? 40);
    const out: Array<{ projectId: number; shellIndex: number; pid: number; line: string; lineNumber: number; contextBefore: string[]; contextAfter: string[] }> = [];
    // Strip ANSI CSI/OSC sequences so styling doesn't hide the token.
    const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
    for (const e of this.entries.values()) {
      const lines = e.scrollback.read().replace(ANSI, '').split('\n');
      let hits = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        re.lastIndex = 0;
        if (!re.test(line)) continue;
        out.push({
          projectId: e.projectId,
          shellIndex: e.shellIndex,
          pid: e.pid,
          line,
          lineNumber: i + 1,
          contextBefore: lines.slice(Math.max(0, i - contextLines), i),
          contextAfter:  lines.slice(i + 1, Math.min(lines.length, i + 1 + contextLines)),
        });
        hits++;
        if (hits >= maxPerShell) break;
      }
    }
    return out;
  }

  /** Snapshot of every shell's currently-known ports (used on renderer mount). */
  allPorts(): Array<{ projectId: number; shellIndex: number; ports: number[] }> {
    const out: Array<{ projectId: number; shellIndex: number; ports: number[] }> = [];
    for (const e of this.entries.values()) {
      if (e.ports.size > 0) out.push({ projectId: e.projectId, shellIndex: e.shellIndex, ports: Array.from(e.ports) });
    }
    return out;
  }

  /**
   * Resize the live PTY, and remember the size either way so a PTY that
   * does not exist yet (or is respawned later) starts at it.
   */
  resize(projectId: number, shellIndex: number, cols: number, rows: number): void {
    this.requestedSizes.set(key(projectId, shellIndex), { cols, rows });
    const e = this.entries.get(key(projectId, shellIndex));
    if (!e) return;
    e.pty.resize(cols, rows);
    e.screen.resize(cols, rows);
    e.cols = cols; e.rows = rows;
  }

  async kill(projectId: number, shellIndex: number): Promise<void> {
    const e = this.entries.get(key(projectId, shellIndex));
    if (!e) return;
    this.flushOutput(e);
    e.pty.kill();
    this.releaseEntry(key(projectId, shellIndex), e);
  }

  /** Records one PTY chunk and schedules its flush; per-chunk work stays O(chunk). */
  private receive(entry: Entry, data: string): void {
    entry.lastDataAt = Date.now();
    if (entry.bufferOpen && entry.earlyBuffer.length < EARLY_BUFFER_CAP) {
      entry.earlyBuffer += data;
    }
    entry.pending.push(data);
    entry.flushTimer ??= setTimeout(() => this.flushOutput(entry), OUTPUT_FLUSH_MS);
  }

  /**
   * Emits the shell's pending output as one `'data'` event, after scanning it
   * for ports and appending it to the scrollback, then feeds the headless
   * terminal — so a snapshot never contains output a viewport has not been sent.
   */
  private flushOutput(entry: Entry): void {
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
    if (entry.pending.length === 0) return;
    const data = entry.pending.join('');
    entry.pending = [];
    this.scanPorts(entry, data);
    entry.scrollback.append(data);
    this.emit('data', { projectId: entry.projectId, shellIndex: entry.shellIndex, data });
    entry.screen.write(data);
  }

  /** Records freshly announced ports (dev servers, docker binds, …) and emits `'ports'` when the set grew. */
  private scanPorts(entry: Entry, data: string): void {
    let portDirty = false;
    for (const re of PORT_PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(data)) !== null) {
        const port = Number(m[1]);
        if (port >= MIN_PORT && port <= MAX_PORT && !entry.ports.has(port)) {
          entry.ports.add(port);
          portDirty = true;
        }
      }
    }
    if (portDirty) {
      this.emit('ports', { projectId: entry.projectId, shellIndex: entry.shellIndex, ports: Array.from(entry.ports) });
    }
  }

  /** Remove port announcements for a process that ended or was interrupted. */
  private clearPorts(entry: Entry): void {
    if (entry.ports.size === 0) return;
    entry.ports.clear();
    this.emit('ports', { projectId: entry.projectId, shellIndex: entry.shellIndex, ports: [] });
  }

  /** Drop the entry and its headless terminal, unless a respawn already replaced it. */
  private releaseEntry(k: string, entry: Entry): void {
    if (this.entries.get(k) !== entry) return;
    entry.screen.dispose();
    this.entries.delete(k);
    this.clearPorts(entry);
    this.emit('status-exit', { projectId: entry.projectId, shellIndex: entry.shellIndex, pid: entry.pid, generation: entry.generation, agent: entry.agent });
  }

  isAlive(projectId: number, shellIndex: number): boolean {
    return this.entries.has(key(projectId, shellIndex));
  }

  list(): Array<{ projectId: number; shellIndex: number; pid: number; cols: number; rows: number; startedAt: number }> {
    return [...this.entries.values()].map(e => ({
      projectId: e.projectId, shellIndex: e.shellIndex, pid: e.pid, cols: e.cols, rows: e.rows, startedAt: e.startedAt,
    }));
  }
}

/**
 * Raw rolling PTY output, keeping the most recent ≤`cap` characters. Output
 * is held as a chunk list with a running length, so `append` costs O(chunk)
 * however full the buffer is; whole chunks drop off the front once the rest
 * still covers `cap`. `read` joins once and snaps the cut to a line boundary,
 * skipping a dangling escape fragment, because replaying a sequence cut
 * mid-way (e.g. inside `\x1b[38;5;208m`) renders garbage.
 */
export class RollingScrollback {
  private chunks: string[] = [];
  private head = 0;
  private length = 0;
  private dropped = false;

  constructor(private readonly cap: number = SCROLLBACK_CAP) {}

  /** Appends one piece of output. */
  append(data: string): void {
    const kept = data.length > this.cap ? data.slice(-this.cap) : data;
    this.dropped ||= kept !== data;
    this.chunks.push(kept);
    this.length += kept.length;
    while (this.length - this.chunks[this.head]!.length >= this.cap) {
      this.length -= this.chunks[this.head]!.length;
      this.chunks[this.head] = '';
      this.head++;
      this.dropped = true;
    }
    if (this.head > 1024 && this.head * 2 > this.chunks.length) {
      this.chunks.splice(0, this.head);
      this.head = 0;
    }
  }

  /** The retained output, trimmed to `cap`; compacts the buffer to that string. */
  read(): string {
    const joined = this.chunks.slice(this.head).join('');
    const excess = joined.length - this.cap;
    const text = excess > 0 || this.dropped ? joined.slice(snapCut(joined, Math.max(0, excess))) : joined;
    this.chunks = [text];
    this.head = 0;
    this.length = text.length;
    this.dropped = false;
    return text;
  }
}

/** Moves a scrollback cut forward to the next line start, past any dangling escape fragment. */
function snapCut(text: string, cut: number): number {
  const nextNl = text.indexOf('\n', cut);
  if (nextNl > -1 && nextNl - cut < 8192) cut = nextNl + 1;
  const window = text.slice(cut, cut + 32);
  if (window.includes('\x1b') && !/[A-Za-z]/.test(window)) {
    const skipTo = text.indexOf('\n', cut);
    if (skipTo > -1 && skipTo - cut < 16384) cut = skipTo + 1;
  }
  return cut;
}
