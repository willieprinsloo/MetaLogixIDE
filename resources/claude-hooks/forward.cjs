'use strict';

const { request } = require('node:http');
const { lstatSync } = require('node:fs');
const { basename, dirname, isAbsolute } = require('node:path');

const BODY_LIMIT = 1024 * 1024;
const DEADLINE_MS = 700;

function isPrivateEndpoint(endpoint) {
  if (process.platform === 'win32') {
    return /^\\\\\.\\pipe\\metaide-claude-hook-[a-f0-9-]{36}$/.test(endpoint);
  }
  if (!isAbsolute(endpoint) || basename(endpoint) !== 'hook.sock') return false;
  const directory = lstatSync(dirname(endpoint));
  if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0) return false;
  return lstatSync(endpoint).isSocket();
}

async function forward() {
  const endpoint = process.env.METAIDE_HOOK_ENDPOINT;
  const shell = process.env.METAIDE_HOOK_SHELL;
  const token = process.env.METAIDE_HOOK_TOKEN;
  if (!endpoint || !shell || !token || !isPrivateEndpoint(endpoint)) return;

  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > BODY_LIMIT) return;
    chunks.push(chunk);
  }

  await new Promise((resolve, reject) => {
    const outgoing = request({
      socketPath: endpoint,
      path: '/claude-hook',
      method: 'POST',
      headers: {
        host: 'localhost',
        'content-type': 'application/json',
        'content-length': size,
        'X-Metaide-Shell': shell,
        authorization: `Bearer ${token}`,
      },
    }, (response) => {
      response.on('end', resolve);
      response.on('error', reject);
      response.resume();
    });
    outgoing.on('error', reject);
    outgoing.end(Buffer.concat(chunks, size));
  });
}

// Never return a hook decision, print diagnostics, or let an unresponsive peer delay Claude.
const deadline = setTimeout(() => process.exit(0), DEADLINE_MS);
void forward().catch(() => {}).finally(() => clearTimeout(deadline));
