import { expect, it, vi } from 'vitest';
import { authenticateWeb, type WebReply } from '@main/metaproject/web-session';
import { parseMetaprojectOrigin } from '@shared/metaproject-contract';

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
