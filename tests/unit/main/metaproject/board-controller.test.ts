import { expect, it, vi } from 'vitest';
import { BoardController, clampBoardBounds, safeExternalCandidate } from '@main/metaproject/board-controller';
import { MetaprojectClient } from '@main/metaproject/client';
import { metaprojectRequests, parseMetaprojectOrigin, remoteProjectId } from '@shared/metaproject-contract';
import type { BoardGuest, GuestEvents } from '@main/metaproject/board-view';
import { guestReplyDecision } from '@main/metaproject/board-navigation';
import type { SessionTransport } from '@main/metaproject/session-service';

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
