import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { BrowserWindow, session, type Session, type WebContentsViewConstructorOptions } from 'electron';
import { BoardController, clampBoardBounds, safeExternalCandidate } from '@main/metaproject/board-controller';
import { MetaprojectClient } from '@main/metaproject/client';
import { metaprojectRequests, parseMetaprojectOrigin, remoteProjectId } from '@shared/metaproject-contract';
import { createBoardGuest, type BoardGuest, type GuestEvents } from '@main/metaproject/board-view';
import { guestReplyDecision } from '@main/metaproject/board-navigation';
import type { SessionTransport } from '@main/metaproject/session-service';

const native = vi.hoisted(() => ({ view: vi.fn(), window: vi.fn(), partition: vi.fn() }));
vi.mock('electron', () => {
  function WebContentsView(options: unknown): object { return native.view(options); }
  function BrowserWindow(): object { return native.window(); }
  return { WebContentsView, BrowserWindow, session: { fromPartition: native.partition } };
});

const selected = parseMetaprojectOrigin('https://example.test', false);
if (!selected) throw new Error('invalid fixture');
const origin = selected;
const context = metaprojectRequests['metaproject:board-open'].parse({ projectId: 1, revision: 'a'.repeat(64), epoch: 1, viewId: '274b7644-ec5c-40e0-bd95-7164b1502bfb' });
const bounds = { x: 0, y: 0, height: 200, width: 300 };

function setup() {
  let revision = context.revision;
  let events: GuestEvents | undefined;
  let attached = false;
  let finishLoad: () => void = () => { throw new Error('guest not loaded'); };
  const guest = {
    load: vi.fn<BoardGuest['load']>(() => new Promise(resolve => { finishLoad = () => resolve({ ok: true, value: undefined }); })),
    layout: vi.fn<BoardGuest['layout']>((rect, beforeAttach) => {
      if (!rect || rect.width <= 0) { attached = false; return false; }
      attached = attached || (beforeAttach?.() ?? true);
      return attached;
    }),
    focus: vi.fn(() => true), close: vi.fn(),
  } satisfies BoardGuest;
  const get = vi.fn(() => ({ ok: true, value: { kind: 'linked', localPath: '/example', localName: 'example', remoteId: remoteProjectId.parse(3), projectId: 1, revision, origin } } as const));
  const transport: SessionTransport = { authenticate: async () => ({ ok: false, reason: 'unavailable' }), client: () => client, retire: async () => undefined };
  const client = Object.create(MetaprojectClient.prototype) as MetaprojectClient;
  client.checkProject = vi.fn(async () => undefined);
  const live = { origin, client, controller: new AbortController(), epoch: 1, transport };
  const candidate = vi.fn<(event: { candidateId: string }) => void>();
  const board = new BoardController({ assignments: { get }, session: { snapshot: () => ({ phase: 'signed-out', configuredOrigin: origin, origin, epoch: 1 }), client: () => live, expire: vi.fn(), logout: vi.fn() },
    guest: (_owner, _live, subscribers) => { events = subscribers; return guest; }, openExternal: vi.fn(), state: vi.fn(), candidate, returnFocus: vi.fn(),
  });
  return { board, get, guest, candidate, events: () => events, finishLoad: () => finishLoad(), change: () => { revision = 'b'.repeat(64); } };
}

it('clips bounds to content DIPs', () => {
  expect(clampBoardBounds({ x: -10, y: 75, width: 55, height: 100 }, { width: 120, height: 130 })).toEqual({ x: 0, y: 75, width: 45, height: 55 });
});

it('keeps off-site launch candidates credential-free and drops URL parameters', () => {
  expect(safeExternalCandidate('https://other.test/guide?token=private#private')).toBe('https://other.test/guide');
  expect(safeExternalCandidate('https://a:b@other.test/')).toBeNull();
  expect(safeExternalCandidate('file:///private/file')).toBeNull();
});

it('does not present a guest if the assignment changed during initial load', async () => {
  const { board, guest, finishLoad, change } = setup();
  const pending = board.open(context, 1);
  board.layout(1, context.viewId, bounds);
  await Promise.resolve();
  expect(guest.load).toHaveBeenCalled();
  change();
  finishLoad();
  await expect(pending).resolves.toMatchObject({ ok: true, value: { phase: 'error', reason: 'conflict' } });
  expect(guest.layout).not.toHaveBeenCalledWith(bounds);
  expect(guest.close).toHaveBeenCalledOnce();
});

it('rechecks authority on reattachment, not every attached resize', async () => {
  const { board, guest, get, finishLoad, change } = setup();
  const pending = board.open(context, 1);
  board.layout(1, context.viewId, bounds);
  await Promise.resolve();
  finishLoad();
  await pending;
  expect(guest.layout).toHaveBeenCalledWith(bounds);
  get.mockClear();
  for (let i = 0; i < 30; i++) expect(board.layout(1, context.viewId, { ...bounds, x: i })).toEqual({ ok: true, value: undefined });
  expect(get).not.toHaveBeenCalled();
  board.layout(1, context.viewId, null);
  for (let i = 0; i < 30; i++) board.layout(1, context.viewId, { ...bounds, width: 0, x: i });
  expect(get).not.toHaveBeenCalled();
  change();
  expect(board.layout(1, context.viewId, bounds)).toEqual({ ok: false, reason: 'conflict' });
  expect(get).toHaveBeenCalledOnce();
  expect(guest.close).toHaveBeenCalledOnce();
});

it('retires an attached guest after a same-project rescan invalidates its assignment', async () => {
  const { board, guest, get, finishLoad, change } = setup();
  const pending = board.open(context, 1);
  board.layout(1, context.viewId, bounds);
  await Promise.resolve();
  finishLoad();
  await pending;
  get.mockClear();
  change();
  board.projectAuthorityChanged();
  expect(get).toHaveBeenCalledWith(context.projectId);
  expect(guest.close).toHaveBeenCalledOnce();
  expect(board.focus(1, context.viewId)).toEqual({ ok: false, reason: 'stale' });
});

it('dismisses only the matching external offer and allows the next one immediately', async () => {
  const { board, events, candidate, finishLoad } = setup();
  const pending = board.open(context, 1);
  await Promise.resolve();
  finishLoad();
  await pending;
  events()?.candidate('https://outside.test/one');
  const first = candidate.mock.calls[0]?.[0].candidateId;
  if (!first) throw new Error('offer not sent');
  expect(board.dismissExternal(2, context.viewId, first)).toEqual({ ok: false, reason: 'stale' });
  expect(board.dismissExternal(1, context.viewId, first)).toEqual({ ok: true, value: undefined });
  events()?.candidate('https://outside.test/two');
  expect(candidate).toHaveBeenCalledTimes(2);
  await expect(board.external(1, context.viewId, first)).resolves.toEqual({ ok: false, reason: 'stale' });
});

it.each([
  ['/dashboard', 'mainFrame', 302, '/auth/login?next=/dashboard', 'expired'],
  ['/digest', 'mainFrame', 302, '/auth/login?next=/digest', 'expired'],
  ['/digest', 'mainFrame', 401, undefined, 'expired'],
  ['/digest', 'xhr', 401, undefined, null],
  ['/digest/unknown', 'mainFrame', 302, '/auth/login?next=/digest/unknown', null],
  ['/digest', 'mainFrame', 503, undefined, 'network'],
  ['/old-dashboard', 'mainFrame', 401, undefined, 'expired'],
  ['/api/projects/1/stories', 'xhr', 401, undefined, 'expired'],
  ['/static/app.js', 'script', 401, undefined, null],
  ['/auth/login', 'mainFrame', 401, undefined, null],
  ['/dashboard', 'mainFrame', 403, undefined, 'denied'],
  ['/dashboard', 'mainFrame', 302, '/support', null],
  ['/dashboard', 'mainFrame', 302, 'https://other.test/auth/login', null],
] as const)('classifies guest response %s (%s %s) without inferring expiry from unrelated navigation', (path, resourceType, statusCode, location, expected) => {
  expect(guestReplyDecision({ url: `${origin}${path}`, resourceType, statusCode, responseHeaders: location ? { Location: [location] } : {} }, origin)).toBe(expected);
});

function nativeGuest() {
  const eventBus = new EventEmitter();
  const id = 42;
  const before = vi.fn<Session['webRequest']['onBeforeRequest']>();
  const headers = vi.fn<Session['webRequest']['onHeadersReceived']>();
  native.partition.mockReturnValue({ webRequest: { onBeforeRequest: before, onHeadersReceived: headers } });
  const jar = session.fromPartition('inert-guest-jar');
  const finalUrl = vi.fn(() => `${origin}/projects/3/kanban`);
  const mainFrame = {};
  const contents = {
    id, mainFrame, on: eventBus.on.bind(eventBus), loadURL: vi.fn<(url: string) => Promise<void>>(async () => {}), getURL: finalUrl,
    setWindowOpenHandler: vi.fn(), isDestroyed: vi.fn(() => false), stop: vi.fn(), close: vi.fn(), focus: vi.fn(),
  };
  const view = { webContents: contents, setBounds: vi.fn() };
  const host = {
    isDestroyed: vi.fn(() => false),
    getContentBounds: () => ({ x: 7, y: 9, height: 130, width: 120 }),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }, webContents: { focus: vi.fn() },
  };
  native.view.mockReturnValue(view);
  native.window.mockReturnValue(host);
  const owner = new BrowserWindow();
  const events = { expire: vi.fn(), fail: vi.fn(), logout: vi.fn(), candidate: vi.fn(), returnFocus: vi.fn() } satisfies GuestEvents;
  const guest = createBoardGuest(owner, jar, origin, events);
  const createOptions: WebContentsViewConstructorOptions | undefined = native.view.mock.lastCall?.[0];
  const request = before.mock.lastCall?.[0];
  const receive = headers.mock.lastCall?.[0];
  function navigate(url: string, initiator: object | null = mainFrame, isMainFrame = true) {
    const event = { url, isMainFrame, initiator, preventDefault: vi.fn() };
    eventBus.emit('will-frame-navigate', event);
    return event.preventDefault;
  }
  function requestDecision(url: string, webContentsId = id, resourceType: 'mainFrame' | 'xhr' | 'webSocket' = 'mainFrame', method = 'GET') {
    if (!request) throw new Error('missing installed request policy');
    const callback = vi.fn();
    request({ id: 1, url, method, resourceType, timestamp: 0, webContentsId, referrer: '', uploadData: [] }, callback);
    return callback.mock.lastCall?.[0];
  }
  function responseDecision(url: string, statusCode: number, webContentsId = id, location?: string) {
    if (!receive) throw new Error('missing installed response policy');
    const callback = vi.fn();
    receive({ id: 1, url, method: 'GET', resourceType: 'mainFrame', timestamp: 0, webContentsId, statusCode, statusLine: '', referrer: '',
      responseHeaders: location ? { lOcAtIoN: [location] } : {} }, callback);
    return callback.mock.lastCall?.[0];
  }
  return { guest, host, view, contents, events, jar, eventBus, finalUrl, createOptions, headers, before, requestDecision, responseDecision, navigate };
}

it('hosts the sandboxed native guest, clips attachment and returns focus on Escape', async () => {
  const { guest, host, view, contents, events, eventBus, createOptions, jar, before, headers } = nativeGuest();
  expect(createOptions?.webPreferences).toMatchObject({ session: jar, sandbox: true, contextIsolation: true,
    nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
    webviewTag: false, webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false, devTools: false,
  });
  expect(createOptions?.webPreferences?.preload).toBeUndefined();
  await expect(guest.load(`${origin}/projects/3`)).resolves.toEqual({ ok: true, value: undefined });
  expect(contents.loadURL).toHaveBeenCalledWith(`${origin}/projects/3`);
  expect(guest.focus()).toBe(false);
  const rect = { x: -10, y: 75, width: 55, height: 100 };
  const authority = vi.fn(() => false);
  expect(guest.layout(rect, authority)).toBe(false);
  expect(host.contentView.addChildView).not.toHaveBeenCalled();
  authority.mockReturnValue(true);
  expect(guest.layout(rect, authority)).toBe(true);
  expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 75, width: 45, height: 55 });
  expect(host.contentView.addChildView).toHaveBeenCalledWith(view);
  expect(guest.layout(rect, authority)).toBe(true);
  expect(host.contentView.addChildView).toHaveBeenCalledOnce();
  expect(authority).toHaveBeenCalledTimes(2);
  expect(guest.focus()).toBe(true);
  expect(contents.focus).toHaveBeenCalledOnce();
  const escape = { preventDefault: vi.fn() };
  eventBus.emit('before-input-event', escape, { type: 'keyUp', key: 'Escape' });
  expect(escape.preventDefault).not.toHaveBeenCalled();
  eventBus.emit('before-input-event', escape, { type: 'keyDown', key: 'Escape' });
  expect(escape.preventDefault).toHaveBeenCalledOnce();
  expect(host.webContents.focus).toHaveBeenCalledOnce();
  expect(events.returnFocus).toHaveBeenCalledOnce();
  expect(guest.layout({ ...rect, width: 0 })).toBe(false);
  expect(host.contentView.removeChildView).toHaveBeenCalledWith(view);
  expect(guest.focus()).toBe(false);
  expect(guest.layout(rect)).toBe(true);
  guest.close();
  guest.close();
  expect(guest.layout(rect)).toBe(false);
  expect(guest.focus()).toBe(false);
  expect(host.contentView.removeChildView).toHaveBeenCalledTimes(2);
  expect(before).toHaveBeenCalledTimes(2);
  expect(headers).toHaveBeenLastCalledWith(null);
  expect(contents.close).toHaveBeenCalledOnce();
  expect(contents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
});

it.each(['sprints', 'dcad/workspace'])('accepts the reference %s Board destination', async suffix => {
  const { guest, finalUrl } = nativeGuest();
  try {
    finalUrl.mockReturnValue(`${origin}/projects/3/${suffix}`);
    await expect(guest.load(`${origin}/projects/3`)).resolves.toEqual({ ok: true, value: undefined });
  } finally { guest.close(); }
});

it('rejects noncanonical input, login redirects and unknown Board destinations', async () => {
  const { guest, finalUrl, contents, responseDecision, events } = nativeGuest();
  try {
    await expect(guest.load(`${origin}/projects/3?extra=1`)).resolves.toEqual({ ok: false, reason: 'invalid-input' });
    await expect(guest.load('https://other.test/projects/3')).resolves.toEqual({ ok: false, reason: 'invalid-input' });
    expect(contents.loadURL).not.toHaveBeenCalled();
    finalUrl.mockReturnValue(`${origin}/projects/3/unknown`);
    await expect(guest.load(`${origin}/projects/3`)).resolves.toEqual({ ok: false, reason: 'not-found' });
    contents.loadURL.mockImplementationOnce(async () => {
      expect(responseDecision(`${origin}/projects/3`, 302, 42, '/auth/login?next=/projects/3')).toEqual({ cancel: true });
      throw new Error('navigation cancelled');
    });
    await expect(guest.load(`${origin}/projects/3`)).resolves.toEqual({ ok: false, reason: 'expired' });
    expect(events.expire).toHaveBeenCalledOnce();
  } finally { guest.close(); }
});

it('distinguishes bounded load timeout from close during load', async () => {
  vi.useFakeTimers();
  const first = nativeGuest();
  try {
    let interrupt: () => void = () => { throw new Error('load not started'); };
    first.contents.loadURL.mockImplementationOnce(() => new Promise((_resolve, reject) => { interrupt = () => reject(new Error('load stopped')); }));
    first.contents.stop.mockImplementation(() => interrupt());
    const timed = first.guest.load(`${origin}/projects/3`);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(first.contents.stop).toHaveBeenCalledOnce();
    await expect(timed).resolves.toEqual({ ok: false, reason: 'network' });
    const next = nativeGuest();
    let finish: () => void = () => { throw new Error('load not started'); };
    next.contents.loadURL.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = next.guest.load(`${origin}/projects/3`);
    next.guest.close();
    finish();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'stale' });
    expect(next.contents.stop).not.toHaveBeenCalled();
  } finally { first.guest.close(); vi.useRealTimers(); }
});

it('offers off-site navigation only from the active main frame and intercepts the exact logout intent', async () => {
  const { guest, events, requestDecision, responseDecision, navigate, eventBus, contents } = nativeGuest();
  try {
    await expect(guest.load(`${origin}/projects/3`)).resolves.toMatchObject({ ok: true });
    const external = 'https://other.test/guide';
    expect(navigate('file:///private/example')).toHaveBeenCalledOnce();
    expect(navigate(external, {}, false)).toHaveBeenCalledOnce();
    expect(navigate(external, null)).not.toHaveBeenCalled();
    expect(requestDecision(external)).toEqual({ cancel: true });
    expect(events.candidate).not.toHaveBeenCalled();
    expect(navigate(external)).not.toHaveBeenCalled();
    expect(requestDecision(external, 42, 'mainFrame', 'POST')).toEqual({ cancel: true });
    expect(events.candidate).not.toHaveBeenCalled();
    expect(requestDecision(external)).toEqual({ cancel: true });
    expect(events.candidate.mock.calls).toEqual([[external]]);
    const handler = contents.setWindowOpenHandler.mock.lastCall?.[0];
    if (!handler) throw new Error('popup policy not installed');
    expect(handler({ url: external, disposition: 'default' })).toEqual({ action: 'deny' });
    expect(handler({ url: external, disposition: 'foreground-tab' })).toEqual({ action: 'deny' });
    expect(handler({ url: external, disposition: 'foreground-tab', postBody: {} })).toEqual({ action: 'deny' });
    eventBus.emit('context-menu', {}, { linkURL: external });
    expect(events.candidate).toHaveBeenCalledTimes(3);
    expect(requestDecision(`${origin}/auth/logout?next=/`)).toEqual({ cancel: true });
    expect(requestDecision(`${origin}/auth/logout`, 90)).toEqual({ cancel: false });
    expect(requestDecision(`${origin}/auth/logout`, 42, 'xhr')).toEqual({ cancel: true });
    await Promise.resolve();
    expect(events.logout).not.toHaveBeenCalled();
    expect(requestDecision(`${origin}/auth/logout`)).toEqual({ cancel: true });
    await Promise.resolve();
    expect(events.logout).toHaveBeenCalledOnce();
    expect(responseDecision(`${origin}/digest`, 302, 90, '/auth/login')).toEqual({ cancel: false });
    expect(responseDecision(`${origin}/auth/login`, 401)).toEqual({ cancel: false });
    await Promise.resolve();
    expect(events.expire).not.toHaveBeenCalled();
    expect(responseDecision(`${origin}/digest`, 302, 42, '/auth/login')).toEqual({ cancel: true });
    await Promise.resolve();
    expect(events.expire).toHaveBeenCalledOnce();
  } finally { guest.close(); }
});

it('blocks navigation redirects and HTTP authentication, but ignores cancelled or subframe loads', async () => {
  const { guest, eventBus, events, navigate } = nativeGuest();
  try {
    await expect(guest.load(`${origin}/projects/3`)).resolves.toMatchObject({ ok: true });
    const sameOrigin = { url: `${origin}/projects/3/sprints`, isMainFrame: true, preventDefault: vi.fn() };
    eventBus.emit('will-redirect', sameOrigin);
    expect(sameOrigin.preventDefault).not.toHaveBeenCalled();
    const external = { url: 'https://other.test/go', isMainFrame: true, preventDefault: vi.fn() };
    eventBus.emit('will-redirect', external);
    expect(external.preventDefault).toHaveBeenCalledOnce();
    expect(events.fail).toHaveBeenLastCalledWith('protocol');
    const login = { preventDefault: vi.fn() };
    const replyAuth = vi.fn();
    eventBus.emit('login', login, {}, {}, replyAuth);
    expect(login.preventDefault).toHaveBeenCalledOnce();
    expect(replyAuth.mock.calls).toEqual([[]]);
    eventBus.emit('did-fail-load', {}, -3, '', sameOrigin.url, true);
    eventBus.emit('did-fail-load', {}, -2, '', sameOrigin.url, false);
    navigate(external.url);
    eventBus.emit('did-fail-load', {}, -2, '', external.url, true);
    expect(events.fail).toHaveBeenCalledTimes(1);
    navigate(sameOrigin.url);
    eventBus.emit('did-fail-load', {}, -2, '', sameOrigin.url, true);
    eventBus.emit('render-process-gone');
    expect(events.fail.mock.calls).toEqual([['protocol'], ['network'], ['network']]);
  } finally { guest.close(); }
});
