import { describe, it, expect, afterEach, vi } from 'vitest';
import { request } from 'node:http';
import { inspect } from 'node:util';
import { execFile } from 'node:child_process';
import { ClaudeHookReceiver, type ReceivedHook } from '@main/claude-hooks/receiver';
import type { ShellKey } from '@main/claude-hooks/session-registry';

const ID = 'shell-id-1';
const TOKEN = 'secret-token-1';
const SHELL: ShellKey = { projectId: 7, shellIndex: 2 };

const auth = { verify: (id: string, token: string): ShellKey | null => (id === ID && token === TOKEN ? { ...SHELL } : null) };

interface Reply { status: number; body: string }

function send(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
  return new Promise((resolveP, rejectP) => {
    const req = request({ host: '127.0.0.1', port, method: opts.method ?? 'POST', path: opts.path ?? '/claude-hook', headers: opts.headers }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString(); });
      res.on('end', () => resolveP({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', rejectP);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function goodHeaders(port: number, extra: Record<string, string> = {}): Record<string, string> {
  return { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-Metaide-Shell': ID, Authorization: `Bearer ${TOKEN}`, ...extra };
}

const STOP_BODY = JSON.stringify({ session_id: 's', hook_event_name: 'Stop', last_assistant_message: 'x' });
const tick = () => new Promise((r) => setTimeout(r, 20));
const MIB = 1024 * 1024;

/** Sends headers plus the start of a body that never completes; resolves with the reply status, or 'closed'. */
function partialSend(port: number, headers: Record<string, string>, start: string): Promise<string> {
  return new Promise((resolveP) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/claude-hook', headers }, (res) => { res.resume(); resolveP(`status ${res.statusCode}`); req.destroy(); });
    req.on('error', () => resolveP('closed'));
    req.write(start);
  });
}

/** A valid Stop body padded to exactly `bytes` bytes. */
function paddedBody(bytes: number): string {
  const skeleton = JSON.stringify({ hook_event_name: 'Stop', pad: '' });
  return JSON.stringify({ hook_event_name: 'Stop', pad: 'x'.repeat(bytes - skeleton.length) });
}

let receiver: ClaudeHookReceiver | null = null;

async function started(listener: (h: ReceivedHook) => void | Promise<void> = () => {}, requestTimeoutMs?: number) {
  receiver = new ClaudeHookReceiver(auth, requestTimeoutMs === undefined ? {} : { requestTimeoutMs });
  receiver.onHook(listener);
  const port = await receiver.start();
  return { receiver, port };
}

afterEach(async () => {
  await receiver?.stop();
  receiver = null;
});

describe('ClaudeHookReceiver — binding', () => {
  it('binds 127.0.0.1 on an ephemeral port and exposes the hook URL', async () => {
    const { receiver: r, port } = await started();
    expect(port).toBeGreaterThan(0);
    expect(r.boundAddress()).toBe('127.0.0.1');
    expect(r.url()).toBe(`http://127.0.0.1:${port}/claude-hook`);
  });

  it('has no URL before start or after stop, and refuses connections after stop', async () => {
    const r = new ClaudeHookReceiver(auth);
    expect(r.url()).toBeNull();
    const port = await r.start();
    await r.stop();
    expect(r.url()).toBeNull();
    await expect(send(port, { headers: goodHeaders(port), body: STOP_BODY })).rejects.toThrow();
  });
});

describe('ClaudeHookReceiver — authorised events', () => {
  it('answers 204 with an empty body and hands the typed event to the listener', async () => {
    const listener = vi.fn();
    const { port } = await started(listener);
    const res = await send(port, { headers: goodHeaders(port), body: STOP_BODY });
    expect(res).toEqual({ status: 204, body: '' });
    await tick();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ sessionId: ID, shell: SHELL, event: { hookEventName: 'Stop', notificationType: null, message: null, backgroundTaskCount: 0 } });
  });

  it('accepts a JSON content type with parameters', async () => {
    const listener = vi.fn();
    const { port } = await started(listener);
    const res = await send(port, { headers: goodHeaders(port, { 'Content-Type': 'application/json; charset=utf-8' }), body: STOP_BODY });
    expect(res.status).toBe(204);
  });

  it('accepts a body of exactly 1 MiB and dispatches it (AC23)', async () => {
    const listener = vi.fn();
    const { port } = await started(listener);
    const body = paddedBody(MIB);
    expect(Buffer.byteLength(body)).toBe(MIB);
    expect((await send(port, { headers: goodHeaders(port), body })).status).toBe(204);
    await tick();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('accepts a PostToolUse body well over the old 64 KiB cap (AC23)', async () => {
    const { port } = await started();
    const body = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: { content: 'x'.repeat(200 * 1024) } });
    expect((await send(port, { headers: goodHeaders(port), body })).status).toBe(204);
  });

  it('answers PermissionRequest with 204 and an empty body, so no decision is ever returned (AC13)', async () => {
    const listener = vi.fn();
    const { port } = await started(listener);
    const body = JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
    const res = await send(port, { headers: goodHeaders(port), body });
    expect(res).toEqual({ status: 204, body: '' });
    await tick();
    expect(listener).toHaveBeenCalledWith({ sessionId: ID, shell: SHELL, event: { hookEventName: 'PermissionRequest', notificationType: null, message: null, backgroundTaskCount: 0 } });
  });

  it('still answers 204 when the listener throws (AC23)', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { port } = await started(() => { throw new Error('boom'); });
    const res = await send(port, { headers: goodHeaders(port), body: STOP_BODY });
    expect(res).toEqual({ status: 204, body: '' });
    await tick();
    warn.mockRestore();
  });

  it('sends the 204 before a slow synchronous listener runs (AC23)', async () => {
    const { port } = await started(() => { const end = Date.now() + 500; while (Date.now() < end) { /* busy */ } });
    const client = `
      const http = require('node:http');
      const t0 = Date.now();
      const req = http.request({ host: '127.0.0.1', port: ${port}, method: 'POST', path: '/claude-hook', headers: ${JSON.stringify(goodHeaders(port))} }, (res) => {
        process.stdout.write(JSON.stringify({ status: res.statusCode, ms: Date.now() - t0 }));
        res.resume();
        process.exit(0);
      });
      req.end(${JSON.stringify(STOP_BODY)});`;
    const out = await new Promise<string>((resolveP, rejectP) => {
      execFile(process.execPath, ['-e', client], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }, (err, stdout) => (err ? rejectP(err) : resolveP(stdout)));
    });
    const { status, ms } = JSON.parse(out) as { status: number; ms: number };
    expect(status).toBe(204);
    expect(ms).toBeLessThan(250);
  });

  it('answers 204 without waiting for a listener that never settles (AC23)', async () => {
    const { port } = await started(() => new Promise<void>(() => {}));
    const res = await send(port, { headers: goodHeaders(port), body: STOP_BODY });
    expect(res.status).toBe(204);
  });

  it('logs a rejected listener promise instead of leaking it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { port } = await started(async () => { throw new Error('async boom'); });
    expect((await send(port, { headers: goodHeaders(port), body: STOP_BODY })).status).toBe(204);
    await tick();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('ClaudeHookReceiver — rejections never reach the listener (AC24)', () => {
  const cases: Array<[string, number, (port: number) => { method?: string; path?: string; headers: Record<string, string>; body?: string }]> = [
    ['no Authorization header', 401, (p) => { const h = goodHeaders(p); delete h.Authorization; return { headers: h, body: STOP_BODY }; }],
    ['a wrong token', 401, (p) => ({ headers: goodHeaders(p, { Authorization: 'Bearer nope' }), body: STOP_BODY })],
    ['a non-Bearer scheme', 401, (p) => ({ headers: goodHeaders(p, { Authorization: `Basic ${TOKEN}` }), body: STOP_BODY })],
    ['an unknown shell id', 401, (p) => ({ headers: goodHeaders(p, { 'X-Metaide-Shell': 'other' }), body: STOP_BODY })],
    ['no shell id header', 401, (p) => { const h = goodHeaders(p); delete h['X-Metaide-Shell']; return { headers: h, body: STOP_BODY }; }],
    ['Host localhost (DNS-rebinding guard)', 403, (p) => ({ headers: goodHeaders(p, { Host: `localhost:${p}` }), body: STOP_BODY })],
    ['a foreign Host', 403, (p) => ({ headers: goodHeaders(p, { Host: 'evil.example:80' }), body: STOP_BODY })],
    ['Host with the wrong port', 403, (p) => ({ headers: goodHeaders(p, { Host: `127.0.0.1:${p + 1}` }), body: STOP_BODY })],
    ['GET', 405, (p) => ({ method: 'GET', headers: goodHeaders(p) })],
    ['another path', 404, (p) => ({ path: '/other', headers: goodHeaders(p), body: STOP_BODY })],
    ['text/plain', 415, (p) => ({ headers: goodHeaders(p, { 'Content-Type': 'text/plain' }), body: STOP_BODY })],
    ['a form content type', 415, (p) => ({ headers: goodHeaders(p, { 'Content-Type': 'application/x-www-form-urlencoded' }), body: STOP_BODY })],
    ['no content type', 415, (p) => { const h = goodHeaders(p); delete h['Content-Type']; return { headers: h, body: STOP_BODY }; }],
    ['invalid JSON', 400, (p) => ({ headers: goodHeaders(p), body: '{"hook_event_name":' })],
    ['JSON of the wrong shape', 400, (p) => ({ headers: goodHeaders(p), body: JSON.stringify({ message: 'no event name' }) })],
    ['a JSON array', 400, (p) => ({ headers: goodHeaders(p), body: '[]' })],
  ];

  it.each(cases)('%s → %i', async (_label, status, build) => {
    const listener = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { port } = await started(listener);
    const res = await send(port, build(port));
    expect(res.status).toBe(status);
    await tick();
    expect(listener).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a request without a bearer token never reaches the authenticator', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const verify = vi.fn(() => ({ ...SHELL }));
    receiver = new ClaudeHookReceiver({ verify });
    const listener = vi.fn();
    receiver.onHook(listener);
    const port = await receiver.start();
    const h = goodHeaders(port);
    delete h.Authorization;
    expect((await send(port, { headers: h, body: STOP_BODY })).status).toBe(401);
    await tick();
    expect(verify).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('answers 413 to a declared Content-Length of 1 MiB + 1 byte without waiting for the body (AC23)', async () => {
    const listener = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { port } = await started(listener, 1500);
    const headers = { ...goodHeaders(port), 'Content-Length': String(MIB + 1) };
    expect(await partialSend(port, headers, '{"hook_event_name":"Stop","pad":"')).toBe('status 413');
    await tick();
    expect(listener).not.toHaveBeenCalled();
    warn.mockRestore();
  }, 5000);

  it('stops a chunked body at 1 MiB + 1 byte and never dispatches it (AC23)', async () => {
    const listener = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { port } = await started(listener);
    const outcome = await new Promise<string>((resolveP) => {
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/claude-hook', headers: { ...goodHeaders(port), 'Transfer-Encoding': 'chunked' } }, (res) => { res.resume(); resolveP(`status ${res.statusCode}`); });
      req.on('error', () => resolveP('closed'));
      const body = paddedBody(MIB + 1);
      for (let i = 0; i < body.length; i += 64 * 1024) req.write(body.slice(i, i + 64 * 1024));
      req.end();
    });
    expect(['status 413', 'closed']).toContain(outcome);
    await tick();
    expect(listener).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('answers an unauthenticated 2 MiB request 401 without reading its body (AC23)', async () => {
    const listener = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { port } = await started(listener, 1500);
    const headers = { ...goodHeaders(port, { Authorization: 'Bearer nope' }), 'Content-Length': String(2 * MIB) };
    expect(await partialSend(port, headers, '{"hook_event_name":"Stop","pad":"')).toBe('status 401');
    await tick();
    expect(listener).not.toHaveBeenCalled();
    warn.mockRestore();
  }, 5000);

  it('hands the listener only a count of background tasks and logs none of their content (AC28)', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const listener = vi.fn(() => { throw new Error('boom'); });
    const { port } = await started(listener);
    const body = JSON.stringify({ hook_event_name: 'Stop', background_tasks: [{ id: 'TASK-ID', type: 'shell', command: 'TASK-CMD', description: 'TASK-DESC' }], session_crons: [{ id: 'CRON-ID' }] });
    expect((await send(port, { headers: goodHeaders(port), body })).status).toBe(204);
    await tick();
    const logged = spies.flatMap((sp) => sp.mock.calls.flatMap((c) => c.map((arg) => inspect(arg, { depth: 10 })))).join('\n');
    for (const sp of spies) sp.mockRestore();
    expect(listener).toHaveBeenCalledWith({ sessionId: ID, shell: SHELL, event: { hookEventName: 'Stop', notificationType: null, message: null, backgroundTaskCount: 1 } });
    expect(logged).not.toMatch(/TASK-|CRON-/);
  });

  it('never logs the token or the body', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const { port } = await started(() => { throw new Error('boom'); });
    await send(port, { headers: goodHeaders(port, { Authorization: 'Bearer wrong-token-zz' }), body: JSON.stringify({ hook_event_name: 'Stop', secret: 'BODY-SECRET' }) });
    await send(port, { headers: goodHeaders(port), body: JSON.stringify({ hook_event_name: 'Stop', secret: 'BODY-SECRET' }) });
    await send(port, { headers: goodHeaders(port), body: '{BODY-SECRET' });
    await tick();
    const logged = spies.flatMap((s) => s.mock.calls.flatMap((c) => c.map((arg) => inspect(arg, { depth: 10 })))).join('\n');
    for (const s of spies) s.mockRestore();
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('wrong-token-zz');
    expect(logged).not.toContain('BODY-SECRET');
  });

  it('times out a request whose body never completes', async () => {
    const listener = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { port } = await started(listener, 300);
    const outcome = await new Promise<string>((resolveP) => {
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/claude-hook', headers: { ...goodHeaders(port), 'Content-Length': '100' } }, (res) => resolveP(`status ${res.statusCode}`));
      req.on('error', () => resolveP('closed'));
      req.write('{"hook_event_name"');
    });
    expect(['status 408', 'closed']).toContain(outcome);
    expect(listener).not.toHaveBeenCalled();
    warn.mockRestore();
  }, 5000);
});
