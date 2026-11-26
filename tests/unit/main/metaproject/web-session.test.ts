import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Session } from 'electron';
import { authenticateWeb, chromiumRequest, createPartition, requireWebBody, type WebReply } from '@main/metaproject/web-session';
import { parseMetaprojectOrigin } from '@shared/metaproject-contract';

const chromium = vi.hoisted(() => ({ request: vi.fn(), partition: vi.fn() }));
vi.mock('electron', () => ({ net: { request: chromium.request }, session: { fromPartition: chromium.partition } }));
vi.mock('node:crypto', async importOriginal => ({ ...await importOriginal<typeof import('node:crypto')>(), randomUUID: () => '7cbb3e78-037f-4156-947c-cdbeb8f09727' }));

it('rejects a nominal login when the same jar cannot read the protected project list', async () => {
  const origin = parseMetaprojectOrigin('https://example.test', false);
  if (!origin) throw new Error('invalid fixture origin');
  const request = vi.fn<(...args: Parameters<Parameters<typeof authenticateWeb>[1]>) => Promise<WebReply>>();
  request.mockResolvedValueOnce({ status: 200, body: Buffer.from('<meta name="csrf-token" content="token">'), contentType: 'text/html' });
  request.mockResolvedValueOnce({ status: 200, body: Buffer.from('{"success":true,"user":{"id":7,"username":"demo"}}'), contentType: 'application/json' });
  request.mockResolvedValueOnce({ location: '/auth/login?next=/api/projects', status: 302 });
  const result = await authenticateWeb(origin, request, { username: 'demo', password: 'demo' }, new AbortController().signal);
  expect(result).toEqual({ ok: false, reason: 'rejected' });
  expect(request.mock.calls.map(([input]) => input.path)).toEqual(['/auth/login', '/auth/login', '/api/projects']);
  expect(request.mock.calls[1]?.[0].json).toEqual({ username: 'demo', password: 'demo', remember: false });
});

it.each([['2', 2000], ['9000', 120_000], ['0', 750], ['garbled', undefined]] as const)('bounds HTTP Retry-After (%s)', async (retryAfter, retryAfterMs) => {
  const origin = parseMetaprojectOrigin('https://example.test', false);
  if (!origin) throw new Error('invalid fixture origin');
  const request = vi.fn(async () => ({ status: 429, body: Buffer.from('ignored'), contentType: 'text/plain', retryAfter }));
  await expect(authenticateWeb(origin, request, { username: 'demo', password: 'test' }, new AbortController().signal))
    .resolves.toEqual({ ok: false, reason: 'throttled', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
  expect(request).toHaveBeenCalledOnce();
});

function fakeChromium() {
  const origin = parseMetaprojectOrigin('https://example.test', false);
  if (!origin) throw new Error('invalid fixture origin');
  chromium.partition.mockClear();
  chromium.request.mockClear();
  const inbound = new EventEmitter();
  const before = vi.fn<Session['webRequest']['onBeforeRequest']>();
  const port = {
    webRequest: { onBeforeRequest: before }, on: inbound.on.bind(inbound),
    setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(), setDisplayMediaRequestHandler: vi.fn(),
  };
  chromium.partition.mockReturnValue(port);
  const jar = createPartition(origin);
  const requestBus = new EventEmitter();
  const requestPort = { on: requestBus.on.bind(requestBus), abort: vi.fn(), setHeader: vi.fn(), end: vi.fn() };
  chromium.request.mockReturnValue(requestPort);
  const signal = new AbortController();
  const request = chromiumRequest(jar, origin);
  return { origin, port, jar, inbound, before, requestBus, requestPort, signal, request };
}

it('creates a nonpersistent, origin-isolated Chromium jar that refuses guest permissions and downloads', () => {
  const { jar, port, before, inbound } = fakeChromium();
  expect(jar).toBe(port);
  expect(chromium.partition).toHaveBeenCalledWith('metaproject-7cbb3e78-037f-4156-947c-cdbeb8f09727', { cache: false });
  const check = port.setPermissionCheckHandler.mock.lastCall?.[0];
  const permission = port.setPermissionRequestHandler.mock.lastCall?.[0];
  const device = port.setDevicePermissionHandler.mock.lastCall?.[0];
  const display = port.setDisplayMediaRequestHandler.mock.lastCall?.[0];
  if (!check || !permission || !device || !display) throw new Error('permission policy was not installed');
  expect(check()).toBe(false);
  expect(device()).toBe(false);
  const callback = vi.fn();
  permission({}, 'media', callback);
  display({}, callback);
  expect(callback.mock.calls).toEqual([[false], [{}]]);
  const preventDefault = vi.fn();
  inbound.emit('will-download', { preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  const guard = before.mock.lastCall?.[0];
  if (!guard) throw new Error('origin policy was not installed');
  for (const [url, cancel] of [
    ['https://example.test/api/projects', false], ['wss://example.test/socket.io/', false],
    ['http://example.test/', true], ['https://example.test:444/', true], ['https://outside.test/', true],
    ['https://name@example.test/', true], ['not a URL', true],
  ] as const) {
    const reply = vi.fn();
    guard({ id: 1, url, method: 'GET', resourceType: 'xhr', referrer: '', timestamp: 0, uploadData: [] }, reply);
    expect(reply).toHaveBeenCalledWith({ cancel });
  }
});

it('uses the isolated jar and exact same-origin credentials, headers, JSON body and bounded buffered response', async () => {
  const { origin, jar, request, requestBus, requestPort, signal } = fakeChromium();
  const path = '/api/projects/4/chat/channels/6/messages/12/';
  const pending = request({ path, method: 'PATCH', json: { message: 'edited' }, csrf: 'opaque.test', signal: signal.signal, limit: 8 });
  expect(chromium.request).toHaveBeenCalledWith({ url: `${origin}${path}`, method: 'PATCH', session: jar, credentials: 'include', redirect: 'manual' });
  expect(requestPort.setHeader.mock.calls).toEqual([
    ['Accept', 'application/json'], ['Content-Type', 'application/json'], ['X-CSRFToken', 'opaque.test'], ['Referer', `${origin}${path}`], ['Origin', origin],
  ]);
  expect(requestPort.end.mock.calls).toEqual([['{"message":"edited"}']]);
  const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-type': ['application/json; charset=utf-8'], 'retry-after': '2' } });
  requestBus.emit('response', response);
  response.emit('data', Buffer.alloc(0));
  response.emit('data', Buffer.from('{"a":'));
  response.emit('data', Buffer.from('1}'));
  response.emit('end');
  await expect(pending).resolves.toEqual({ status: 200, contentType: 'application/json; charset=utf-8', retryAfter: '2', body: Buffer.from('{"a":1}') });
  signal.abort();
  expect(requestPort.abort).not.toHaveBeenCalled();
});

it('rejects invalid or retired invocations before allocating a network request', async () => {
  const { request, signal } = fakeChromium();
  for (const path of ['//other.test/api/projects', 'https://name@example.test/api/projects', 'https://example.test:444/api/projects']) {
    await expect(request({ path, signal: signal.signal })).rejects.toMatchObject({ reason: 'invalid-origin' });
  }
  signal.abort();
  await expect(request({ path: '/api/projects', signal: signal.signal })).rejects.toMatchObject({ reason: 'stale' });
  expect(chromium.request).not.toHaveBeenCalled();
});

it('never follows a redirect and releases the old request before classifying it', async () => {
  const { origin, request, requestBus, requestPort, signal, jar } = fakeChromium();
  const pending = request({ path: '/api/projects', signal: signal.signal });
  expect(chromium.request).toHaveBeenCalledWith({ url: `${origin}/api/projects`, method: 'GET', session: jar, credentials: 'include', redirect: 'manual' });
  expect(requestPort.setHeader.mock.calls).toEqual([['Accept', '*/*']]);
  expect(requestPort.end.mock.calls).toEqual([[undefined]]);
  requestBus.emit('redirect', 302, 'GET', '/auth/login?next=/api/projects');
  const reply = await pending;
  expect(reply).toEqual({ status: 302, location: '/auth/login?next=/api/projects' });
  expect(() => requireWebBody(reply, origin, true)).toThrowError(expect.objectContaining({ reason: 'expired' }));
  signal.abort();
  expect(requestPort.abort).toHaveBeenCalledOnce();
  expect(chromium.request).toHaveBeenCalledOnce();
});

it.each([
  ['abort', 'stale'], ['timeout', 'network'], ['request-error', 'network'], ['challenge', 'network'],
  ['response-error', 'network'], ['aborted-response', 'network'], ['too-large', 'protocol'],
] as const)('terminates %s without returning partial bytes', async (event, reason) => {
  vi.useFakeTimers();
  const { request, requestBus, requestPort, signal } = fakeChromium();
  try {
    const pending = request({ path: '/api/projects', signal: signal.signal, limit: 3 });
    const failure = expect(pending).rejects.toMatchObject({ reason });
    const rejectChallenge = vi.fn();
    const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
    if (event === 'abort') signal.abort();
    if (event === 'timeout') await vi.advanceTimersByTimeAsync(10_000);
    if (event === 'request-error') requestBus.emit('error', new Error('request unavailable'));
    if (event === 'challenge') { requestBus.emit('login', {}, rejectChallenge); expect(rejectChallenge.mock.calls).toEqual([[]]); }
    if (event === 'response-error' || event === 'aborted-response' || event === 'too-large') {
      requestBus.emit('response', response);
      response.emit('data', Buffer.from('ab'));
      if (event === 'response-error') response.emit('error', new Error('response unavailable'));
      if (event === 'aborted-response') response.emit('aborted');
      if (event === 'too-large') response.emit('data', Buffer.from('cd'));
    }
    await failure;
    expect(requestPort.abort).toHaveBeenCalledOnce();
    expect(chromium.request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it.each([
  [401, true, 'expired'], [401, false, 'rejected'], [403, true, 'denied'],
  [403, false, 'rejected'], [404, true, 'not-found'], [503, true, 'network'], [418, true, 'protocol'],
] as const)('classifies HTTP %s (protected=%s) as %s', (status, protectedRoute, reason) => {
  const origin = parseMetaprojectOrigin('https://example.test', false);
  if (!origin) throw new Error('invalid fixture origin');
  const reply = { status, contentType: 'text/plain', body: Buffer.from('ignored') };
  expect(() => requireWebBody(reply, origin, protectedRoute)).toThrowError(expect.objectContaining({ reason }));
});
