/** Hosts one top-level sandboxed Electron guest; navigation policy is bound separately. */
import { WebContentsView, type BrowserWindow, type Session, type WebContents } from 'electron';
import type { MetaprojectFailure, MetaprojectOrigin, MetaprojectResult } from '@shared/metaproject-contract';
import { clampBoardBounds, type Bounds } from './board-controller';
import { bindGuestNavigation, type GuestNavigation } from './board-navigation';
import { failure, ok } from './session-service';

export interface GuestEvents {
  expire(): void;
  logout(): void;
  fail(reason: MetaprojectFailure): void;
  candidate(raw: string): void;
  returnFocus(): void;
}

export interface BoardGuest {
  load(canonical: string): Promise<MetaprojectResult<undefined>>;
  layout(bounds: Bounds | null, beforeAttach?: () => boolean): boolean;
  focus(): boolean;
  close(): void;
}

/** Set up native hosting before constructing or exposing any guest content. */
export function createBoardGuest(owner: BrowserWindow, jar: Session, origin: MetaprojectOrigin, events: GuestEvents): BoardGuest {
  const view = new WebContentsView({ webPreferences: {
    session: jar, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false,
    navigateOnDragDrop: false, devTools: false, spellcheck: false,
  } });
  const contents = view.webContents;
  const state: GuestNavigation = { closed: false, initial: true, outcome: null };
  const detachPolicy = bindGuestNavigation(jar, contents, origin, state, events);
  const host = nativeHost(owner, view, state);
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return;
    event.preventDefault();
    if (!owner.isDestroyed()) owner.webContents.focus();
    events.returnFocus();
  });
  return {
    load: canonical => loadBoard(contents, canonical, origin, state),
    ...host,
    close() {
      if (state.closed) return;
      host.layout(null);
      state.closed = true;
      detachPolicy();
      if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    },
  };
}

function nativeHost(owner: BrowserWindow, view: WebContentsView, state: GuestNavigation): Pick<BoardGuest, 'layout' | 'focus'> {
  let attached = false;

  function detach(): void {
    if (attached) owner.contentView.removeChildView(view);
    attached = false;
  }

  return {
    layout(bounds, beforeAttach) {
      if (state.closed || owner.isDestroyed()) return false;
      const clipped = bounds ? clampBoardBounds(bounds, owner.getContentBounds()) : null;
      if (!clipped) {
        detach();
        return false;
      }
      if (!attached && beforeAttach && !beforeAttach()) return false;
      view.setBounds(clipped);
      if (!attached) owner.contentView.addChildView(view);
      attached = true;
      return true;
    },
    focus() {
      if (!attached || state.closed || view.webContents.isDestroyed()) return false;
      view.webContents.focus();
      return true;
    },
  };
}

function canonicalProject(canonical: string, origin: MetaprojectOrigin): URL | null {
  const url = URL.parse(canonical);
  if (!url || url.origin !== origin || !/^\/projects\/[1-9]\d*$/.test(url.pathname)) return null;
  return url.username || url.password || url.search || url.hash ? null : url;
}

function acceptedBoard(final: URL | null, target: URL): boolean {
  return final?.origin === target.origin && ['/kanban', '/sprints', '/dcad/workspace'].some(suffix => final.pathname === target.pathname + suffix);
}

async function loadBoard(contents: WebContents, canonical: string, origin: MetaprojectOrigin, state: GuestNavigation): Promise<MetaprojectResult<undefined>> {
  const target = canonicalProject(canonical, origin);
  if (!target) return failure('invalid-input');
  const timer = setTimeout(() => { state.outcome = 'network'; if (!state.closed && !contents.isDestroyed()) contents.stop(); }, 12_000);
  try {
    await contents.loadURL(target.href);
    if (state.closed) return failure('stale');
    if (state.outcome) return failure(state.outcome);
    if (!acceptedBoard(URL.parse(contents.getURL()), target)) return failure('not-found');
    state.initial = false;
    return ok(undefined);
  } catch { return failure(state.outcome ?? (state.closed ? 'stale' : 'network')); }
  finally { clearTimeout(timer); }
}
