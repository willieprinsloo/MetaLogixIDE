#!/usr/bin/env node
// A deterministic OMP event host: loads the extension supplied by the app's
// actual -e argument and delivers the same lifecycle events a real OMP host
// delivers. It never fabricates a status report itself.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
// The surviving helper attempts a once-valid report only after the PTY dies.
if (process.argv[2] === '--late-report') {
  const marker = process.argv[3];
  const deadline = Date.now() + 10000;
  const timer = setInterval(() => {
    if (Date.now() > deadline) {
      clearInterval(timer);
      return;
    }
    if (!marker || !existsSync(marker)) return;
    clearInterval(timer);
    const socket = createConnection({
      port: Number(process.env.METAIDE_OMP_STATUS_PORT),
      host: '127.0.0.1',
    });
    const wire = {
      spawn: process.env.METAIDE_OMP_STATUS_SPAWN,
      token: process.env.METAIDE_OMP_STATUS_TOKEN,
      report: { version: 1, session: 'mock-session-1', seq: 999, event: 'agent_start' },
    };
    let response = '';
    socket.on('connect', () => socket.end(`${JSON.stringify(wire)}\n`));
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
    });
    socket.on('error', () => {});
    socket.on('close', () =>
      writeFileSync(`${marker}.done`, response.trim() || 'connection closed'),
    );
  }, 20);
} else {
  const extensionFlag = argv.findIndex((arg) => arg === '-e' || arg === '--extension');
  const extensionPath = extensionFlag < 0 ? null : argv[extensionFlag + 1];
  let extensionLoaded = false;
  const handlers = new Map();
  let session = 'mock-session-1';
  const pi = {
    on(name, callback) {
      const callbacks = handlers.get(name) ?? [];
      callbacks.push(callback);
      handlers.set(name, callbacks);
    },
  };
  const ctx = { hasUI: true, sessionManager: { getSessionId: () => session } };

  async function emit(name, event = {}) {
    for (const callback of handlers.get(name) ?? []) await callback(event, ctx);
  }

  if (extensionPath) {
    try {
      const module = await import(
        extensionPath.startsWith('file:')
          ? new URL(extensionPath).href
          : pathToFileURL(resolve(extensionPath)).href
      );
      if (typeof module.default !== 'function')
        throw new TypeError('OMP extension has no default factory');
      await module.default(pi);
      extensionLoaded = true;
    } catch {
      // A missing/unloadable integration never prevents OMP from running.
      process.stdout.write('mock-omp integration unavailable\n');
    }
  }

  await emit('session_start', { type: 'session_start' });
  process.stdout.write('mock-omp ready\n> ');
  process.stdin.setEncoding('utf8');
  let queue = Promise.resolve();
  process.stdin.on('data', (chunk) => {
    const line = String(chunk).trim();
    queue = queue
      .then(async () => {
        if (line === '/start') {
          await emit('agent_start', { type: 'agent_start' });
          process.stdout.write('mock-omp turn started\n');
        } else if (line === '/approval') {
          await emit('tool_approval_requested', {
            type: 'tool_approval_requested',
            toolName: 'bash',
            toolCallId: 'mock-approval',
          });
          process.stdout.write('mock-omp approval requested\n');
        } else if (line === '/resolve') {
          await emit('tool_approval_resolved', {
            type: 'tool_approval_resolved',
            toolName: 'bash',
            toolCallId: 'mock-approval',
            approved: true,
          });
          process.stdout.write('mock-omp approval resolved\n');
        } else if (line === '/ask') {
          await emit('tool_execution_start', {
            type: 'tool_execution_start',
            toolName: 'ask',
            toolCallId: 'mock-ask',
          });
          process.stdout.write('mock-omp question open\n');
        } else if (line === '/answer') {
          await emit('tool_execution_end', {
            type: 'tool_execution_end',
            toolName: 'ask',
            toolCallId: 'mock-ask',
            isError: false,
          });
          process.stdout.write('mock-omp question answered\n');
        } else if (line === '/end') {
          await emit('agent_end', { type: 'agent_end' });
          process.stdout.write('mock-omp turn settled\n> ');
        } else if (line === '/pause-reports') {
          // Suspend this live OMP process's event loop so its real extension
          // cannot send heartbeats. The Electron watchdog runs independently.
          process.stdout.write('mock-omp reports paused\n');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
          process.stdout.write('mock-omp reports resumed\n> ');
        } else if (line === '/switch') {
          session = 'mock-session-2';
          await emit('session_switch', { type: 'session_switch' });
          process.stdout.write('mock-omp session switched\n> ');
        } else if (line === '/env') {
          // Never echo secret env values; tests only need to know injection happened.
          process.stdout.write(`mock-omp integration=${extensionLoaded ? 'loaded' : 'absent'}\n> `);
        } else if (line.startsWith('/late-report ')) {
          const marker = line.slice('/late-report '.length).trim();
          const child = spawn(
            process.execPath,
            [fileURLToPath(import.meta.url), '--late-report', marker],
            {
              detached: true,
              stdio: 'ignore',
              env: process.env,
            },
          );
          child.unref();
          process.stdout.write('mock-omp late report armed\n> ');
        } else if (line === 'exit' || line === '/quit') {
          process.exit(0);
        } else {
          process.stdout.write(`mock-omp echo: ${line}\n> `);
        }
      })
      .catch((error) => {
        process.stderr.write(`mock-omp event failure: ${error.message}\n`);
      });
  });
}
