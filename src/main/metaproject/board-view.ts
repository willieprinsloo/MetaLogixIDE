/** Owns a top-level, origin-confined Electron guest with no privileged bridge. */
import { WebContentsView, type BrowserWindow, type OnBeforeRequestListenerDetails, type OnHeadersReceivedListenerDetails, type Session } from 'electron';
import type { MetaprojectFailure, MetaprojectOrigin, MetaprojectResult } from '@shared/metaproject-contract';
import { clampBoardBounds, type Bounds } from './board-controller';
import { failure, ok } from './session-service';
import { bindPartitionGuard, isLoginLocation } from './web-session';

export interface GuestEvents {
  expire(): void;
  logout(): void;
  fail(reason: MetaprojectFailure): void;
  candidate(raw: string): void;
  returnFocus(): void;
}

export interface BoardGuest {
  load(canonical: string): Promise<MetaprojectResult<undefined>>;
  layout(bounds: Bounds | null): void;
  focus(): boolean;
  close(): void;
}

function isAuthPath(path: string): boolean { return /^\/auth(?:\/|$)/.test(path); }
function protectedResource(path: string): boolean { return /^\/(?:api\/(?:projects|stories|chat|users)(?:\/|$)|projects(?:\/|$))/.test(path); }

/** Set up navigation policies before the first request and keep the authenticated jar exact. */
export function createBoardGuest(owner: BrowserWindow, jar: Session, origin: MetaprojectOrigin, events: GuestEvents): BoardGuest {
  const view = new WebContentsView({ webPreferences: {
    session: jar, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false,
    navigateOnDragDrop: false, devTools: false, spellcheck: false,
  } });
  const contents = view.webContents;
  let closed = false;
  let attached = false;
  let initial = true;
  let navigable: string | null = null;
  let outcome: MetaprojectFailure | null = null;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  function fail(reason: MetaprojectFailure): void {
    outcome = reason;
    if (!initial && !closed) events.fail(reason);
  }

  function onGuestRequest(request: OnBeforeRequestListenerDetails, url: URL): boolean {
    if (request.webContentsId !== contents.id) return false;
    if (url.origin !== origin) {
      if (request.resourceType === 'mainFrame' && request.method === 'GET' && !initial && navigable === url.href) events.candidate(url.href);
      return request.resourceType !== 'webSocket';
    }
    if (!isAuthPath(url.pathname)) return false;
    if (request.resourceType === 'mainFrame' && request.method === 'GET' && url.pathname === '/auth/logout' && !url.search && !url.hash) {
      queueMicrotask(() => { if (!closed) events.logout(); });
    }
    return true;
  }

  function inspectReply(reply: OnHeadersReceivedListenerDetails): boolean {
    if (reply.webContentsId !== contents.id) return false;
    const url = URL.parse(reply.url);
    if (!url || url.origin !== origin) return true;
    const redirect = reply.statusCode >= 300 && reply.statusCode < 400;
    const location = Object.entries(reply.responseHeaders ?? {}).find(([key]) => key.toLowerCase() === 'location')?.[1][0];
    if (protectedResource(url.pathname) && (reply.statusCode === 401 || (redirect && location && isLoginLocation(location, origin)))) {
      outcome = 'expired';
      queueMicrotask(() => { if (!closed) events.expire(); });
      return true;
    }
    if (reply.resourceType !== 'mainFrame') return false;
    if (reply.statusCode === 403) { fail('denied'); return true; }
    if (reply.statusCode === 404) { fail('not-found'); return true; }
    if (reply.statusCode >= 500) { fail('network'); return true; }
    return false;
  }

  bindPartitionGuard(jar, origin, onGuestRequest);
  jar.webRequest.onHeadersReceived((reply, callback) => callback({ cancel: inspectReply(reply) }));
  contents.on('will-frame-navigate', event => {
    const url = URL.parse(event.url);
    if (!url || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) { event.preventDefault(); return; }
    if (!event.isMainFrame) { event.preventDefault(); return; }
    navigable = !initial && event.initiator === contents.mainFrame && url.origin !== origin ? url.href : null;
  });
  contents.on('will-redirect', event => {
    navigable = null;
    const url = URL.parse(event.url);
    if (url?.origin === origin && !url.username && !url.password && !isAuthPath(url.pathname)) return;
    event.preventDefault();
    if (event.isMainFrame && !outcome) fail('protocol');
  });
  contents.setWindowOpenHandler(({ url, postBody, disposition }) => {
    const next = URL.parse(url);
    if (!initial && !postBody && disposition !== 'default' && next?.origin !== origin) events.candidate(url);
    return { action: 'deny' };
  });
  contents.on('context-menu', (_event, info) => {
    if (!initial && info.linkURL && URL.parse(info.linkURL)?.origin !== origin) events.candidate(info.linkURL);
  });
  contents.on('login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback(); });
  contents.on('render-process-gone', () => fail('network'));
  contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (!initial && !closed && isMainFrame && code !== -3 && !navigable) fail('network');
  });
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return;
    event.preventDefault();
    if (!owner.isDestroyed()) owner.webContents.focus();
    events.returnFocus();
  });

  function layout(bounds: Bounds | null): void {
    if (closed || owner.isDestroyed()) return;
    const clipped = bounds ? clampBoardBounds(bounds, owner.getContentBounds()) : null;
    if (!clipped) {
      if (attached) owner.contentView.removeChildView(view);
      attached = false;
      return;
    }
    view.setBounds(clipped);
    if (!attached) owner.contentView.addChildView(view);
    attached = true;
  }

  async function load(canonical: string): Promise<MetaprojectResult<undefined>> {
    const target = URL.parse(canonical);
    if (!target || target.origin !== origin || !/^\/projects\/[1-9]\d*$/.test(target.pathname) || target.username || target.password || target.search || target.hash) return failure('invalid-input');
    try {
      deadline = setTimeout(() => { outcome = 'network'; if (!closed) contents.stop(); }, 12_000);
      await contents.loadURL(target.href);
      if (closed) return failure('stale');
      if (outcome) return failure(outcome);
      const final = URL.parse(contents.getURL());
      const accepted = ['/kanban', '/sprints', '/dcad/workspace'].some(suffix => final?.origin === origin && final.pathname === target.pathname + suffix);
      if (!accepted) return failure('not-found');
      initial = false;
      return ok(undefined);
    } catch { return failure(outcome ?? (closed ? 'stale' : 'network')); }
    finally { clearTimeout(deadline); }
  }

  return {
    load,
    layout,
    focus() { if (!attached || closed || contents.isDestroyed()) return false; contents.focus(); return true; },
    close() {
      if (closed) return;
      layout(null);
      closed = true;
      clearTimeout(deadline);
      bindPartitionGuard(jar, origin);
      jar.webRequest.onHeadersReceived(null);
      if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    },
  };
}
