// Ollama chat engine against a fake Ollama server (POST /api/chat, NDJSON stream).
// Ported from BotOffice windows/test/engine-ollama.test.js.
import { describe, it, expect } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runOllama } from '@main/group-chat/engines/ollama';

type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeOllama(handler: Handler): Promise<{ base: string; seen: Array<{ url: string; body: any }>; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seen: Array<{ url: string; body: any }> = [];
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => { seen.push({ url: req.url ?? '', body: body ? JSON.parse(body) : null }); handler(req, res, seen.at(-1)!.body); });
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
      seen,
      close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
    }));
  });
}
const line = (o: unknown) => `${JSON.stringify(o)}\n`;

describe('runOllama', () => {
  it('streams the reply', async () => {
    const f = await fakeOllama((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(line({ message: { role: 'assistant', content: 'Hello' }, done: false }));
      setTimeout(() => res.end(line({ message: { role: 'assistant', content: ' there' }, done: false }) + line({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 5, eval_count: 3 })), 20);
    });
    const r = await runOllama({ model: 'llama3.2', text: 'hi', history: [] }, { base: f.base });
    await f.close();
    expect(r).toEqual({ ok: true, reply: 'Hello there' });
  });

  it('sends the earlier conversation first, then the new message', async () => {
    const f = await fakeOllama((_req, res) => { res.end(line({ message: { content: 'ok' }, done: true })); });
    const history = [{ role: 'user' as const, content: 'a' }, { role: 'assistant' as const, content: 'b' }];
    await runOllama({ model: 'qwen3:8b', text: 'c', history }, { base: f.base });
    await f.close();
    expect(f.seen[0]!.url).toBe('/api/chat');
    expect(f.seen[0]!.body.model).toBe('qwen3:8b');
    expect(f.seen[0]!.body.stream).toBe(true);
    expect(f.seen[0]!.body.messages).toEqual([...history, { role: 'user', content: 'c' }]);
  });

  it('not running gives a clear error', async () => {
    const f = await fakeOllama(() => {});
    const base = f.base;
    await f.close();
    const r = await runOllama({ model: 'llama3.2', text: 'hi', history: [] }, { base });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Ollama isn’t running/);
  });

  it('a missing model gives a clear error', async () => {
    const f = await fakeOllama((_req, res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'model "nope" not found, try pulling it first' })); });
    const r = await runOllama({ model: 'nope', text: 'hi', history: [] }, { base: f.base });
    await f.close();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ollama pull nope/);
  });

  it('an error line in the stream fails the turn with its text', async () => {
    const f = await fakeOllama((_req, res) => { res.end(line({ message: { content: 'par' }, done: false }) + line({ error: 'out of memory' })); });
    const r = await runOllama({ model: 'llama3.2', text: 'hi', history: [] }, { base: f.base });
    await f.close();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/out of memory/);
  });

  it('stop aborts the request quickly', async () => {
    const f = await fakeOllama((_req, res) => { res.writeHead(200); res.write(line({ message: { content: 'slow' }, done: false })); });
    const ctl = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ctl.abort(), 50);
    const r = await runOllama({ model: 'llama3.2', text: 'hi', history: [] }, { base: f.base, signal: ctl.signal });
    await f.close();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('stopped');
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('a reply cut off before Ollama says it is done is not a success', async () => {
    const f = await fakeOllama((_req, res) => { res.end(line({ message: { content: 'half a sen' }, done: false })); });
    const r = await runOllama({ model: 'llama3.2', text: 'hi', history: [] }, { base: f.base });
    await f.close();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/stopped mid-reply/);
    expect(r.reply).toBe('half a sen');
  });
});
