/** Bounded loopback receiver authenticating OMP reports to one live PTY spawn. */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import type { ShellKey } from '@main/claude-hooks/session-registry';
import { OMP_REPORT_VERSION, type OmpReport, type OmpReportEvent } from '@shared/omp-report';
import { OmpSession } from './omp-session';

const EVENTS: ReadonlySet<string> = new Set([
  'session_start',
  'session_switch',
  'agent_start',
  'agent_end',
  'approval_requested',
  'approval_resolved',
  'ask_start',
  'ask_end',
  'heartbeat',
]);
const MAX_BYTES = 1024;
const key = (shell: ShellKey): string => `${shell.projectId}:${shell.shellIndex}`;
const keys = (value: object, expected: readonly string[]): boolean =>
  Object.keys(value).every((field) => expected.includes(field));

/** Parses one strict versioned envelope without trusting caller-supplied shell identifiers. */
export function parseOmpEnvelope(
  text: string,
): { spawn: string; token: string; report: OmpReport } | null {
  if (Buffer.byteLength(text) > MAX_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !keys(value, ['spawn', 'token', 'report'])
  )
    return null;
  if (
    !('spawn' in value) ||
    typeof value.spawn !== 'string' ||
    value.spawn.length > 80 ||
    value.spawn.length === 0
  )
    return null;
  if (!('token' in value) || typeof value.token !== 'string' || value.token.length > 128)
    return null;
  if (
    !('report' in value) ||
    !value.report ||
    typeof value.report !== 'object' ||
    Array.isArray(value.report)
  )
    return null;
  const report = value.report;
  if (
    !keys(report, [
      'version',
      'session',
      'seq',
      'event',
      'active',
      'willContinue',
      'approvals',
      'questions',
    ])
  )
    return null;
  if (!('version' in report) || report.version !== OMP_REPORT_VERSION) return null;
  if (
    !('session' in report) ||
    typeof report.session !== 'string' ||
    report.session.length < 1 ||
    report.session.length > 128
  )
    return null;
  if (
    !('seq' in report) ||
    typeof report.seq !== 'number' ||
    !Number.isSafeInteger(report.seq) ||
    report.seq < 1
  )
    return null;
  if (!('event' in report) || typeof report.event !== 'string' || !EVENTS.has(report.event))
    return null;
  if ('active' in report && typeof report.active !== 'boolean') return null;
  if ('willContinue' in report && typeof report.willContinue !== 'boolean') return null;
  for (const field of ['approvals', 'questions'] as const) {
    if (!(field in report)) continue;
    const count = (report as Record<string, unknown>)[field];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 100)
      return null;
  }
  if (
    report.event === 'heartbeat' &&
    (!('active' in report) || !('approvals' in report) || !('questions' in report))
  )
    return null;
  const parsed: OmpReport = {
    version: OMP_REPORT_VERSION,
    session: report.session,
    seq: report.seq,
    event: report.event as OmpReportEvent,
    ...('active' in report && typeof report.active === 'boolean' ? { active: report.active } : {}),
    ...('willContinue' in report && typeof report.willContinue === 'boolean'
      ? { willContinue: report.willContinue }
      : {}),
    ...('approvals' in report && typeof report.approvals === 'number'
      ? { approvals: report.approvals }
      : {}),
    ...('questions' in report && typeof report.questions === 'number'
      ? { questions: report.questions }
      : {}),
  };
  return { spawn: value.spawn, token: value.token, report: parsed };
}

interface Registration {
  readonly shell: ShellKey;
  readonly token: Buffer;
  readonly session: OmpSession;
  generation: string | null;
  count: number;
  windowAt: number;
}

/** Authenticates and scopes reports to an issued live shell generation. */
export class OmpReceiver {
  private readonly entries = new Map<string, Registration>();
  private readonly byShell = new Map<string, string>();
  private server: Server | null = null;
  private port: number | null = null;

  constructor(
    private onReport: (
      shell: ShellKey,
      generation: string,
      state: 'idle' | 'busy' | 'blocked',
    ) => void = () => {},
  ) {}

  /** Attaches the status service after composition, before any child can report. */
  setListener(
    listener: (shell: ShellKey, generation: string, state: 'idle' | 'busy' | 'blocked') => void,
  ): void {
    this.onReport = listener;
  }

  /** Issues opaque credentials to a spawn; replacing old credentials revokes them. */
  issue(shell: ShellKey): { spawn: string; token: string } {
    this.release(shell);
    const spawn = randomUUID();
    const token = randomBytes(32).toString('base64url');
    this.entries.set(spawn, {
      shell: { ...shell },
      token: Buffer.from(token),
      session: new OmpSession(),
      generation: null,
      count: 0,
      windowAt: 0,
    });
    this.byShell.set(key(shell), spawn);
    return { spawn, token };
  }

  /** Binds pre-spawn credentials only after the live PTY publishes its generation. */
  bind(shell: ShellKey, spawn: string, generation: string): void {
    const entry = this.entries.get(spawn);
    if (entry && this.byShell.get(key(shell)) === spawn && entry.generation === null)
      entry.generation = generation;
  }

  /** Revokes a shell only when the exit belongs to its current generation. */
  release(shell: ShellKey, generation?: string): void {
    const id = this.byShell.get(key(shell));
    const entry = id ? this.entries.get(id) : undefined;
    if (!id || !entry || (generation && entry.generation !== generation)) return;
    this.entries.delete(id);
    this.byShell.delete(key(shell));
  }

  /** Returns whether the report was authenticated, current, ordered and applied. */
  accept(text: string): boolean {
    const envelope = parseOmpEnvelope(text);
    if (!envelope) return false;
    const entry = this.entries.get(envelope.spawn);
    if (!entry?.generation || this.byShell.get(key(entry.shell)) !== envelope.spawn) return false;
    const candidate = Buffer.from(envelope.token);
    if (candidate.length !== entry.token.length || !timingSafeEqual(candidate, entry.token))
      return false;
    const now = Date.now();
    if (now - entry.windowAt >= 1000) {
      entry.count = 0;
      entry.windowAt = now;
    }
    if (++entry.count > 100) return false;
    const state = entry.session.apply(envelope.report);
    if (state === null) return false;
    this.onReport(entry.shell, entry.generation, state);
    return true;
  }

  /** Opens a loopback listener before OMP spawns; never binds a public interface. */
  async start(): Promise<number> {
    if (this.server && this.port !== null) return this.port;
    const server = createServer((socket) => this.readConnection(socket));
    server.maxConnections = 32;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (cause) {
      if (server.listening) server.close();
      throw new Error('OMP status receiver unavailable', { cause });
    }
    this.server = server;
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('OMP receiver did not bind TCP loopback');
    this.port = address.port;
    return this.port;
  }

  /** Bound local port, or null when transport is unavailable. */
  boundPort(): number | null {
    return this.port;
  }

  /** Closes transport and invalidates every issued spawn credential. */
  stop(): void {
    this.server?.close();
    this.server = null;
    this.port = null;
    this.entries.clear();
    this.byShell.clear();
  }

  private readConnection(socket: Socket): void {
    socket.setTimeout(1000, () => socket.destroy());
    let body = '';
    socket.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (
        Buffer.byteLength(body) > MAX_BYTES ||
        (body.includes('\n') && !body.endsWith('\n')) ||
        body.indexOf('\n') !== body.lastIndexOf('\n')
      ) {
        socket.destroy();
        return;
      }
    });
    socket.on('end', () => {
      if (!body.endsWith('\n')) {
        socket.end('no\n');
        return;
      }
      socket.end(this.accept(body.slice(0, -1)) ? 'ok\n' : 'no\n');
    });
    socket.on('error', () => socket.destroy());
  }
}
