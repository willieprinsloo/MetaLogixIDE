/**
 * Loopback HTTP receiver for Claude Code `http` hooks (IO layer). Accepts
 * only `POST /claude-hook` on 127.0.0.1 with an exact `Host`, a JSON body
 * of at most 1 MiB and a valid per-spawn id + bearer token, checked before
 * any of the body is read; answers 204 with no body before handing the
 * parsed event to its listener, so a hook reply can never block or steer
 * Claude (AC23, AC24). Never logs tokens or bodies.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseHookEvent, type HookEvent } from './hook-event';
import { HOOK_PATH, SHELL_HEADER } from './protocol';
import type { ShellKey } from './session-registry';

/** Resolves a presented session id + token to its shell, or null. */
export interface HookAuthenticator {
  verify(id: string, token: string): ShellKey | null;
}

/** An authenticated, parsed hook event. */
export interface ReceivedHook {
  sessionId: string;
  shell: ShellKey;
  event: HookEvent;
}

/** Receives authenticated events; its result or failure never affects the HTTP reply. */
export type HookListener = (hook: ReceivedHook) => void | Promise<void>;

/** Receiver tuning; `requestTimeoutMs` bounds how long one request may take to arrive (default 2000). */
export interface ReceiverOptions {
  requestTimeoutMs?: number;
}

interface Rejection {
  status: number;
  reason: string;
}

const LOOPBACK = '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 2000;
const CONNECTION_CHECK_INTERVAL_MS = 250;
const BEARER = /^Bearer (\S+)$/;
const JSON_CONTENT_TYPE = /^application\/json\s*(;|$)/i;

class BodyTooLarge extends Error {}

function checkRequestLine(req: IncomingMessage, port: number): Rejection | null {
  if (req.method !== 'POST') return { status: 405, reason: 'method' };
  if (req.url !== HOOK_PATH) return { status: 404, reason: 'path' };
  if (req.headers.host !== `${LOOPBACK}:${port}`) return { status: 403, reason: 'host' };
  if (!JSON_CONTENT_TYPE.test(req.headers['content-type'] ?? '')) return { status: 415, reason: 'content-type' };
  return null;
}

function authenticate(req: IncomingMessage, auth: HookAuthenticator): { sessionId: string; shell: ShellKey } | null {
  const sessionId = req.headers[SHELL_HEADER.toLowerCase()];
  const token = BEARER.exec(req.headers.authorization ?? '')?.[1];
  if (typeof sessionId !== 'string' || token === undefined) return null;
  const shell = auth.verify(sessionId, token);
  return shell ? { sessionId, shell } : null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) { rejectP(new BodyTooLarge()); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { rejectP(new BodyTooLarge()); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolveP(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectP);
  });
}

function parseBody(text: string): HookEvent | null {
  try {
    return parseHookEvent(JSON.parse(text));
  } catch {
    return null;
  }
}

function reject(res: ServerResponse, rejection: Rejection, close = false): void {
  console.warn('[claude-hooks] rejected hook request', rejection);
  res.writeHead(rejection.status, close ? { Connection: 'close' } : {});
  res.end();
}

/** Loopback receiver for Claude Code hook POSTs; see the module docblock for the accepted request shape. */
export class ClaudeHookReceiver {
  private server: Server | null = null;
  private port: number | null = null;
  private listener: HookListener = () => {};
  private readonly requestTimeoutMs: number;

  constructor(private readonly auth: HookAuthenticator, opts: ReceiverOptions = {}) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** Sets the single listener that receives authenticated events. */
  onHook(listener: HookListener): void {
    this.listener = listener;
  }

  /** Listens on an ephemeral 127.0.0.1 port and resolves with it; rejects when the socket cannot bind. */
  async start(): Promise<number> {
    const server = createServer({
      requestTimeout: this.requestTimeoutMs,
      headersTimeout: this.requestTimeoutMs,
      connectionsCheckingInterval: CONNECTION_CHECK_INTERVAL_MS,
    }, (req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolveP, rejectP) => {
      server.once('error', rejectP);
      server.listen(0, LOOPBACK, () => { server.off('error', rejectP); resolveP(); });
    });
    server.on('error', (err) => console.error('[claude-hooks] receiver error', { cause: err }));
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    console.info('[claude-hooks] receiver listening', { port: this.port });
    return this.port;
  }

  /** The IP address the socket is bound to, or null when not listening. */
  boundAddress(): string | null {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.address : null;
  }

  /** The hook URL to put in Claude's settings, or null when not listening. */
  url(): string | null {
    return this.port === null ? null : `http://${LOOPBACK}:${this.port}${HOOK_PATH}`;
  }

  /** Stops listening and drops open connections. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolveP) => server.close(() => resolveP()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const lineRejection = checkRequestLine(req, this.port ?? -1);
    if (lineRejection) { reject(res, lineRejection); return; }
    const identity = authenticate(req, this.auth);
    if (!identity) { reject(res, { status: 401, reason: 'auth' }); return; }
    let text: string;
    try {
      text = await readBody(req);
    } catch (err) {
      reject(res, err instanceof BodyTooLarge ? { status: 413, reason: 'size' } : { status: 400, reason: 'read' }, true);
      return;
    }
    const event = parseBody(text);
    if (!event) { reject(res, { status: 400, reason: 'body' }); return; }
    res.writeHead(204);
    res.end();
    setImmediate(() => this.dispatch({ ...identity, event }));
  }

  private dispatch(hook: ReceivedHook): void {
    try {
      Promise.resolve(this.listener(hook)).catch((err: unknown) => {
        console.error('[claude-hooks] hook listener failed', { event: hook.event.hookEventName, cause: err });
      });
    } catch (err) {
      console.error('[claude-hooks] hook listener failed', { event: hook.event.hookEventName, cause: err });
    }
  }
}
