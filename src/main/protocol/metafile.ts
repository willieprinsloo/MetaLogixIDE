/**
 * `metafile://<projectId>/<relPath>` — a privileged custom protocol that
 * serves files from inside a project root, so the renderer can show a
 * rendered (sandboxed iframe) HTML preview whose relative assets
 * (<link>, <img>, <script src>) resolve against the project root just like
 * they would on a real server. Never serves outside a project root.
 */
import { protocol } from 'electron';
import { readFileSync, statSync } from 'node:fs';
import { resolveInsideRoot } from '@main/domain/path-containment';
import { MIME_BY_EXT } from '@shared/mime';

export const METAFILE_SCHEME = 'metafile';
/** Constant host — project ids are numeric and Chromium mangles numeric hosts, so the id rides in the path. */
export const METAFILE_HOST = 'p';

/** Must run before app ready — grants the scheme standard/secure/fetch privileges so iframes and relative URLs work. */
export function registerMetafileScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: METAFILE_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  }]);
}

/**
 * Pure URL → absolute-path resolution for the protocol handler. URL shape
 * is `metafile://p/<projectId>/<relPath>` — the host is the constant `p`
 * because Chromium canonicalizes numeric hosts into IPv4 forms (host `7`
 * arrives as `0.0.0.1`), so a projectId can never be the host of a standard
 * scheme URL. Returns null for an unknown project, an empty path, or any
 * path that escapes the project root. Parses manually instead of via
 * `new URL` — URL parsing silently normalizes `../` segments, which would
 * turn a traversal attempt into an innocent-looking in-root path; dot
 * segments are rejected outright instead, encoded or not.
 */
export function resolveMetafileUrl(
  url: string,
  getProjectPath: (projectId: number) => string | null,
): { abs: string } | null {
  // Strip query/fragment before parsing — cache-busted relative assets
  // (`app.js?v=3`) are common in real HTML and must resolve to the file.
  const clean = url.replace(/[?#].*$/, '');
  const prefix = `${METAFILE_SCHEME}://${METAFILE_HOST}/`;
  if (!clean.startsWith(prefix)) return null;
  const rest = clean.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null; // no projectId, or no pathname after it
  const projectId = Number(rest.slice(0, slash));
  if (!Number.isInteger(projectId) || projectId <= 0) return null;
  const root = getProjectPath(projectId);
  if (!root) return null;
  const rawSegments = rest.slice(slash + 1).split('/').filter((s) => s.length > 0);
  if (rawSegments.length === 0) return null;
  const segments = rawSegments.map((s) => decodeURIComponent(s));
  if (segments.some((s) => s === '..' || s === '.')) return null;
  const relPath = segments.join('/');
  try {
    return { abs: resolveInsideRoot(root, relPath) };
  } catch {
    return null;
  }
}

/**
 * Install the request handler. Call once from startApp, after services
 * exist — `getProjectPath` bridges to the live projects repo so renamed /
 * removed projects stop serving immediately.
 */
export function handleMetafileProtocol(getProjectPath: (projectId: number) => string | null): void {
  protocol.handle(METAFILE_SCHEME, async (request) => {
    const hit = resolveMetafileUrl(request.url, getProjectPath);
    if (!hit) return new Response(`not found: ${request.url}`, { status: 404 });
    let isFile = false;
    try { isFile = statSync(hit.abs).isFile(); } catch { return new Response('not found', { status: 404 }); }
    if (!isFile) return new Response('not found', { status: 404 });
    const buf = readFileSync(hit.abs);
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const dot = hit.abs.lastIndexOf('.');
    const ext = dot === -1 ? '' : hit.abs.slice(dot + 1).toLowerCase();
    return new Response(bytes, { headers: { 'content-type': MIME_BY_EXT[ext] ?? 'application/octet-stream' } });
  });
}
