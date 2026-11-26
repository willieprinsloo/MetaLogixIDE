/** Exact-origin Chromium transport and Flask web authentication. */
import { net, session, type OnBeforeRequestListenerDetails, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { metaprojectActor, metaprojectRemoteProject, type MetaprojectActor, type MetaprojectFailure, type MetaprojectOrigin, type MetaprojectResult } from '@shared/metaproject-contract';

export interface Credentials { readonly username: string; readonly password: string }
export type WebMutation = { readonly method?: 'POST' | 'PATCH' | 'DELETE'; readonly json?: object };
interface WebInput {
  readonly path: string;
  readonly signal: AbortSignal;
  readonly json?: object;
  readonly csrf?: string;
  readonly limit?: number;
  readonly method?: WebMutation['method'];
}
export type WebReply = { status: number; contentType: string; body: Buffer; retryAfter?: string } | { status: number; location: string };
export type WebRequest = (input: WebInput) => Promise<WebReply>;
export const projectList = z.object({ success: z.literal(true), projects: z.array(metaprojectRemoteProject) });
const loginResponse = z.object({ success: z.literal(true), user: metaprojectActor });
const cap = 256 * 1024;
export const projectListCap = 4 * 1024 * 1024;

/** Safe internal failure without HTTP bodies or credential material. */
export class WebFailure extends Error {
  constructor(readonly reason: MetaprojectFailure, readonly retryAfterMs?: number) { super(reason); }
}

/** Create a new origin-confined, nonpersistent cookie jar. */
export function createPartition(origin: MetaprojectOrigin): Session {
  const jar = session.fromPartition(`metaproject-${randomUUID()}`, { cache: false });
  jar.setPermissionCheckHandler(() => false);
  jar.setPermissionRequestHandler((_page, _permission, callback) => callback(false));
  jar.setDevicePermissionHandler(() => false);
  jar.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  jar.on('will-download', event => event.preventDefault());
  bindPartitionGuard(jar, origin);
  return jar;
}

/** Combine the immutable origin allow-list with the current guest's stricter navigation rules. */
export function bindPartitionGuard(jar: Session, origin: MetaprojectOrigin, guest?: (request: OnBeforeRequestListenerDetails, url: URL) => boolean): void {
  const socketOrigin = origin.replace(/^http/, 'ws');
  jar.webRequest.onBeforeRequest((details, callback) => {
    const url = URL.parse(details.url);
    if (!url || url.username || url.password) { callback({ cancel: true }); return; }
    const guestBlocked = guest?.(details, url) ?? false;
    callback({ cancel: guestBlocked || (url.origin !== origin && url.origin !== socketOrigin) });
  });
}

/** Request via Chromium without handling Set-Cookie or following redirects. */
export function chromiumRequest(jar: Session, origin: MetaprojectOrigin): WebRequest {
  return async ({ path, method, json, csrf, signal, limit = cap }) => {
    const url = new URL(path, origin);
    if (url.origin !== origin || url.username || url.password) throw new WebFailure('invalid-origin');
    if (signal.aborted) throw new WebFailure('stale');
    return new Promise<WebReply>((resolve, reject) => {
      const req = net.request({ url: url.href, method: method ?? (json ? 'POST' : 'GET'), session: jar, credentials: 'include', redirect: 'manual' });
      const timer = setTimeout(() => fail('network'), 10_000);
      const abort = (): void => fail('stale');
      function clean(): void { clearTimeout(timer); signal.removeEventListener('abort', abort); }
      function fail(reason: MetaprojectFailure): void { clean(); reject(new WebFailure(reason)); req.abort(); }
      function finish(reply: WebReply): void { clean(); resolve(reply); }
      signal.addEventListener('abort', abort, { once: true });
      req.on('error', () => fail('network'));
      req.on('login', (_info, callback) => { callback(); fail('network'); });
      req.on('redirect', (status, _method, location) => { finish({ status, location }); req.abort(); });
      req.on('response', response => {
        const parts: Buffer[] = [];
        let bytes = 0;
        response.on('error', () => fail('network'));
        response.on('aborted', () => fail('network'));
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > limit) fail('protocol');
          else if (chunk.length > 0) parts.push(chunk);
        });
        response.on('end', () => {
          const header = response.headers['content-type'];
          const contentType = typeof header === 'string' ? header : header?.[0] ?? '';
          const retry = response.headers['retry-after'];
          const retryAfter = typeof retry === 'string' ? retry : retry?.[0];
          finish({ status: response.statusCode, contentType, body: Buffer.concat(parts), ...(retryAfter ? { retryAfter } : {}) });
        });
      });
      req.setHeader('Accept', method || json ? 'application/json' : '*/*');
      if (json) req.setHeader('Content-Type', 'application/json');
      if (csrf) {
        req.setHeader('X-CSRFToken', csrf);
        req.setHeader('Referer', url.href);
        req.setHeader('Origin', origin);
      }
      req.end(json ? JSON.stringify(json) : undefined);
    });
  };
}

/** Recognize exact, same-origin Flask sign-in destination, including its return parameter. */
export function isLoginLocation(raw: string, origin: MetaprojectOrigin): boolean {
  const url = URL.parse(raw, origin);
  return !!url && url.origin === origin && !url.username && !url.password && url.pathname === '/auth/login';
}

/** Translate status or bounded body from a caller-selected service route. */
export function requireWebBody(reply: WebReply, origin: MetaprojectOrigin, protectedRoute: boolean): Buffer {
  if ('location' in reply) throw new WebFailure(protectedRoute && isLoginLocation(reply.location, origin) ? 'expired' : 'protocol');
  if (reply.status >= 200 && reply.status < 300) return reply.body;
  throw webStatusFailure(reply, protectedRoute);
}

function webStatusFailure(reply: Extract<WebReply, { body: Buffer }>, protectedRoute: boolean): WebFailure {
  if (reply.status === 401) return authStatusFailure(protectedRoute, 'expired');
  if (reply.status === 403) return authStatusFailure(protectedRoute, 'denied');
  if (reply.status === 404) return new WebFailure('not-found');
  if (reply.status === 429) return new WebFailure('throttled', retryDelay(reply.retryAfter));
  return new WebFailure(reply.status >= 500 ? 'network' : 'protocol');
}

function authStatusFailure(protectedRoute: boolean, reason: 'expired' | 'denied'): WebFailure {
  return new WebFailure(protectedRoute ? reason : 'rejected');
}

function retryDelay(value?: string): number | undefined {
  if (!value || value.length > 64) return undefined;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.min(120_000, Math.max(750, milliseconds)) : undefined;
}

/** Parse a successful allow-listed response envelope, never normalizing errors to empty. */
export function webJson<T>(reply: WebReply, origin: MetaprojectOrigin, schema: z.ZodType<T>, protectedRoute = true): T {
  const body = requireWebBody(reply, origin, protectedRoute);
  if (!('contentType' in reply) || !/^application\/(?:json|[\w.-]+\+json)(?:;|$)/i.test(reply.contentType)) throw new WebFailure('protocol');
  try { return schema.parse(JSON.parse(body.toString('utf8'))); }
  catch { throw new WebFailure('protocol'); }
}

export type AuthenticationResult = MetaprojectResult<MetaprojectActor> | { ok: false; reason: 'throttled'; retryAfterMs: number };

/** Verify the Flask principal response and prove the same jar can reach a protected route. */
export async function authenticateWeb(origin: MetaprojectOrigin, request: WebRequest, credentials: Credentials, signal: AbortSignal): Promise<AuthenticationResult> {
  const path = '/auth/login';
  try {
    const page = await request({ path, signal });
    const html = requireWebBody(page, origin, false).toString('utf8');
    if (page.status !== 200 || !('contentType' in page) || !/^text\/html(?:;|$)/i.test(page.contentType)) return { ok: false, reason: 'protocol' };
    const csrf = /<meta\s+name=["']csrf-token["']\s+content=["']([a-zA-Z0-9._-]+)["']/i.exec(html)?.[1]
      ?? /<input[^>]*name=["']csrf_token["'][^>]*value=["']([a-zA-Z0-9._-]+)["']/i.exec(html)?.[1];
    if (!csrf || csrf.length > 2048) return { ok: false, reason: 'protocol' };
    const login = await request({ path, json: { ...credentials, remember: false }, csrf, signal });
    const { user } = webJson(login, origin, loginResponse, false);
    if (login.status !== 200) return { ok: false, reason: 'protocol' };
    webJson(await request({ path: '/api/projects', signal, limit: projectListCap }), origin, projectList);
    return { ok: true, value: user };
  } catch (error) {
    return authenticationFailure(error);
  }
}

function authenticationFailure(error: unknown): AuthenticationResult {
  const reason = error instanceof WebFailure ? error.reason : 'network';
  if (reason === 'throttled' && error instanceof WebFailure && error.retryAfterMs !== undefined) return { ok: false, reason, retryAfterMs: error.retryAfterMs };
  return { ok: false, reason: reason === 'expired' ? 'rejected' : reason };
}
