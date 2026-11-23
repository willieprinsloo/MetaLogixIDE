/** Exact-origin guest request, response, navigation and interaction policy. */
import type { OnBeforeRequestListenerDetails, OnHeadersReceivedListenerDetails, Session, WebContents } from 'electron';
import type { MetaprojectFailure, MetaprojectOrigin } from '@shared/metaproject-contract';
import type { GuestEvents } from './board-view';
import { bindPartitionGuard, isLoginLocation } from './web-session';

export interface GuestNavigation {
  initial: boolean;
  closed: boolean;
  outcome: MetaprojectFailure | null;
}

type Reply = Pick<OnHeadersReceivedListenerDetails, 'url' | 'resourceType' | 'statusCode' | 'responseHeaders'>;

function isAuthPath(path: string): boolean { return /^\/auth(?:\/|$)/.test(path); }

function isProtected(path: string, topLevel: boolean): boolean {
  if (/^\/api\/(?:projects|stories|chat|users|user\/preferences)(?:\/|$)/.test(path)) return true;
  return topLevel && (path === '/digest' || /^\/(?:projects|dashboard|old-dashboard|help|settings|uploads)(?:\/|$)/.test(path));
}

function isExpiry(reply: Reply, origin: MetaprojectOrigin): boolean {
  if (reply.statusCode === 401) return true;
  if (reply.statusCode < 300 || reply.statusCode >= 400) return false;
  const location = Object.entries(reply.responseHeaders ?? {}).find(([key]) => key.toLowerCase() === 'location')?.[1][0];
  return !!location && isLoginLocation(location, origin);
}

/** Report only authoritative rejection of an explicitly protected route on the guest's origin. */
export function guestReplyDecision(reply: Reply, origin: MetaprojectOrigin): MetaprojectFailure | null {
  const url = URL.parse(reply.url);
  if (url?.origin !== origin) return 'protocol';
  const topLevel = reply.resourceType === 'mainFrame';
  if (isProtected(url.pathname, topLevel) && isExpiry(reply, origin)) return 'expired';
  if (!topLevel) return null;
  return mainFrameFailure(reply.statusCode);
}

function mainFrameFailure(status: number): MetaprojectFailure | null {
  if (status === 403) return 'denied';
  if (status === 404) return 'not-found';
  return status >= 500 ? 'network' : null;
}

/** Bind policy before load and return the teardown that restores the partition's default guard. */
export function bindGuestNavigation(jar: Session, contents: WebContents, origin: MetaprojectOrigin, state: GuestNavigation, events: GuestEvents): () => void {
  let navigable: string | null = null;
  function fail(reason: MetaprojectFailure): void {
    state.outcome = reason;
    if (!state.initial && !state.closed) events.fail(reason);
  }
  function onRequest(request: OnBeforeRequestListenerDetails, url: URL): boolean {
    if (request.webContentsId !== contents.id) return false;
    const mainGet = request.resourceType === 'mainFrame' && request.method === 'GET';
    if (url.origin !== origin) {
      if (mainGet && !state.initial && navigable === url.href) events.candidate(url.href);
      return request.resourceType !== 'webSocket';
    }
    if (mainGet && url.pathname === '/auth/logout' && !url.search && !url.hash) queueMicrotask(() => { if (!state.closed) events.logout(); });
    return isAuthPath(url.pathname);
  }
  bindPartitionGuard(jar, origin, onRequest);
  jar.webRequest.onHeadersReceived((reply, callback) => {
    const reason = reply.webContentsId === contents.id ? guestReplyDecision(reply, origin) : null;
    if (reason === 'expired') state.outcome = reason;
    callback({ cancel: !!reason });
    if (reason === 'expired') {
      queueMicrotask(() => { if (!state.closed) events.expire(); });
    } else if (reason) fail(reason);
  });
  contents.on('will-frame-navigate', event => {
    const url = URL.parse(event.url);
    if (!event.isMainFrame || !url || !safeWebUrl(url)) { event.preventDefault(); return; }
    navigable = !state.initial && event.initiator === contents.mainFrame && url.origin !== origin ? url.href : null;
  });
  contents.on('will-redirect', event => {
    navigable = null;
    const url = URL.parse(event.url);
    if (url?.origin === origin && safeWebUrl(url) && !isAuthPath(url.pathname)) return;
    event.preventDefault();
    if (event.isMainFrame && !state.outcome) fail('protocol');
  });
  bindGuestInteraction({ contents, origin, state, events, fail, isExternal: () => navigable !== null });
  return () => { bindPartitionGuard(jar, origin); jar.webRequest.onHeadersReceived(null); };
}

function safeWebUrl(url: URL): boolean {
  return !url.username && !url.password && ['http:', 'https:'].includes(url.protocol);
}

type GuestInteraction = {
  readonly contents: WebContents;
  readonly origin: MetaprojectOrigin;
  readonly state: GuestNavigation;
  readonly events: GuestEvents;
  readonly fail: (reason: MetaprojectFailure) => void;
  readonly isExternal: () => boolean;
};

function bindGuestInteraction({ contents, origin, state, events, fail, isExternal }: GuestInteraction): void {
  contents.setWindowOpenHandler(({ url, postBody, disposition }) => {
    if (!state.initial && !postBody && disposition !== 'default' && URL.parse(url)?.origin !== origin) events.candidate(url);
    return { action: 'deny' };
  });
  contents.on('context-menu', (_event, info) => {
    if (!state.initial && info.linkURL && URL.parse(info.linkURL)?.origin !== origin) events.candidate(info.linkURL);
  });
  contents.on('login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback(); });
  contents.on('render-process-gone', () => fail('network'));
  contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (!state.initial && !state.closed && isMainFrame && code !== -3 && !isExternal()) fail('network');
  });
}
