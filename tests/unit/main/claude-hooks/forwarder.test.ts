import { spawn } from 'node:child_process';
import { chmodSync, renameSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allocateHookEndpoint } from '@main/claude-hooks/runtime';
import { ClaudeHookReceiver } from '@main/claude-hooks/receiver';
import { SessionRegistry } from '@main/claude-hooks/session-registry';
import { buildHookSettings } from '@main/claude-hooks/settings-file';
import { randomUUID } from 'node:crypto';

const script = resolve('resources/claude-hooks/forward.cjs');
const body = JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false });

function run(command: string, endpoint: string, session: { id: string; token: string }, executable = process.execPath) {
  const windows = process.platform === 'win32';
  return new Promise<{ status: number | null; output: string }>((done, reject) => {
    const child = spawn(windows ? 'powershell.exe' : '/bin/sh',
      windows ? ['-NoProfile', '-Command', command] : ['-c', command], {
        env: {
          ...process.env,
          METAIDE_HOOK_EXE: executable,
          METAIDE_HOOK_FORWARDER: script,
          METAIDE_HOOK_ENDPOINT: endpoint,
          METAIDE_HOOK_SHELL: session.id,
          METAIDE_HOOK_TOKEN: session.token,
        },
        windowsHide: true,
      });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', reject);
    child.stdin.on('error', () => {}); // A missing executable may close stdin immediately.
    child.on('close', (status) => done({ status, output }));
    child.stdin.end(body);
  });
}

describe('generated Claude Stop hook command', () => {
  const command = buildHookSettings(process.platform).hooks.Stop[0]?.hooks[0]?.command ?? '';
  const quiet = { status: 0, output: '' };

  it('delivers an authenticated event, then stays quiet after the receiver is closed or replaced', async () => {
    expect(command).not.toBe('');
    const endpoint = allocateHookEndpoint(process.platform, randomUUID());
    const replacement = allocateHookEndpoint(process.platform, randomUUID());
    const registry = new SessionRegistry();
    const session = registry.issue({ projectId: 3, shellIndex: 2 });
    const receiver = new ClaudeHookReceiver(registry);
    const restarted = new ClaudeHookReceiver(new SessionRegistry());
    const events: unknown[] = [];
    receiver.onHook((event) => { events.push(event); });
    const replacementEvents: unknown[] = [];
    restarted.onHook((event) => { replacementEvents.push(event); });
    try {
      await receiver.start(endpoint.path);
      expect(await run(command, endpoint.path, session)).toEqual(quiet);
      await expect.poll(() => events).toEqual([expect.objectContaining({
        shell: { projectId: 3, shellIndex: 2 },
        event: expect.objectContaining({ hookEventName: 'Stop' }),
      })]);
      await receiver.stop();
      await restarted.start(replacement.path);
      expect(await run(command, endpoint.path, session)).toEqual(quiet);
      expect(replacementEvents).toEqual([]);
      expect(events).toHaveLength(1);
      expect(await run(command, endpoint.path, session, `${process.execPath}-missing`)).toEqual(quiet);
    } finally {
      await receiver.stop();
      await restarted.stop();
      endpoint.remove();
      replacement.remove();
    }
  });

  it('exits silently when the receiver holds a connection open', async () => {
    const endpoint = allocateHookEndpoint(process.platform, randomUUID());
    const server = createServer((socket) => { socket.resume(); });
    let connected = false;
    server.on('connection', () => { connected = true; });
    try {
      await new Promise<void>((done, reject) => server.once('error', reject).listen(endpoint.path, done));
      expect(await run(command, endpoint.path, { id: 'test', token: 'test' })).toEqual(quiet);
      expect(connected).toBe(true);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      endpoint.remove();
    }
  });

  it.skipIf(process.platform === 'win32')('silently handles refusal from a stale Unix socket', async () => {
    const endpoint = allocateHookEndpoint(process.platform, randomUUID());
    const server = createServer();
    try {
      await new Promise<void>((done, reject) => server.once('error', reject).listen(endpoint.path, done));
      // Keep the socket entry that a crashed process would leave behind.
      const stale = `${endpoint.path}.stale`;
      renameSync(endpoint.path, stale);
      await new Promise<void>((done) => server.close(() => done()));
      renameSync(stale, endpoint.path);
      const error = await new Promise<NodeJS.ErrnoException>((done) => {
        createConnection(endpoint.path).once('error', done);
      });
      expect(error.code).toBe('ECONNREFUSED');
      expect(await run(command, endpoint.path, { id: 'test', token: 'test' })).toEqual(quiet);
    } finally {
      if (server.listening) await new Promise<void>((done) => server.close(() => done()));
      endpoint.remove();
    }
  });

  it('never connects to a loopback listener even when its URL is inherited', async () => {
    let connected = false;
    const server = createServer((socket) => { connected = true; socket.destroy(); });
    try {
      await new Promise<void>((done, reject) => server.once('error', reject).listen(0, '127.0.0.1', done));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('expected a loopback port');
      expect(await run(command, `http://127.0.0.1:${address.port}/claude-hook`, { id: 'test', token: 'test' })).toEqual(quiet);
      expect(connected).toBe(false);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it.skipIf(process.platform === 'win32')('rejects a socket outside an owner-only directory before connecting', async () => {
    const endpoint = allocateHookEndpoint(process.platform, randomUUID());
    let connected = false;
    const server = createServer((socket) => { connected = true; socket.destroy(); });
    try {
      chmodSync(dirname(endpoint.path), 0o755);
      await new Promise<void>((done, reject) => server.once('error', reject).listen(endpoint.path, done));
      expect(await run(command, endpoint.path, { id: 'test', token: 'test' })).toEqual(quiet);
      expect(connected).toBe(false);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      endpoint.remove();
    }
  });
});
