import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

vi.mock('electron', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  app: { getVersion: () => '0.0.0-test' },
}));

import { RpcPeer } from '@main/p2p/rpc';
import { pairedTransports } from '@main/p2p/__tests__/_pairedTransports';
import { wireHub } from '@main/p2p/hub';
import { RpcMethods } from '@shared/p2p-contract';
import { PtyManager } from '@main/pty/manager';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { RootsRepo } from '@main/repos/roots-repo';
import { ProjectsRepo } from '@main/repos/projects-repo';
import { createChatService } from '@main/chat/service';
import { readRecentChat } from '@main/chat/log';

const migrationsDir = resolve(__dirname, '../../../../migrations');

let dir: string;
let projectRoot: string;
let projects: ProjectsRepo;
let projectId: number;
let pty: PtyManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chat-rpc-'));
  projectRoot = join(dir, 'proj');
  mkdirSync(projectRoot);
  const db = openDb(join(dir, 'db'));
  runMigrations(db, migrationsDir);
  const root = new RootsRepo(db).add(dir);
  projects = new ProjectsRepo(db);
  projectId = projects.upsert(root.id, projectRoot, 'proj').id;
  pty = new PtyManager();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const [ta, tb] = pairedTransports();
  const client = new RpcPeer(ta.asTransport());
  const server = new RpcPeer(tb.asTransport());
  client.on('error', () => {});
  server.on('error', () => {});
  const chat = createChatService({ projects, deviceId: 'host-dev', broadcast: () => {} });
  wireHub(server, {
    remoteDeviceId: 'remote-dev',
    services: { projects, ptyManager: pty, chat } as never,
    auditLogPath: join(dir, 'audit.log'),
  });
  return { client, server, chat };
}

describe('RPC catalogue', () => {
  test('chat.append is in the catalogue', () => {
    expect(RpcMethods['chat.append']).toBeDefined();
  });
  test('chat.sync_since is in the catalogue', () => {
    expect(RpcMethods['chat.sync_since']).toBeDefined();
  });
  test('chat.roster is in the catalogue', () => {
    expect(RpcMethods['chat.roster']).toBeDefined();
  });
});

describe('chat.append over RPC', () => {
  test('writes the entry into the local chat log', async () => {
    const { client } = setup();
    const entry = {
      id: 'remote-1',
      ts: new Date().toISOString(),
      from: { device: 'remote-dev', shell: 1, agent: 'claude' },
      to: [],
      body: 'hello from remote',
    };
    await client.call('chat.append', { projectId, entry });
    const got = readRecentChat(projectRoot, 10);
    expect(got.map((e) => e.body)).toEqual(['hello from remote']);
  });

  test('preserves the origin device, id, and ts on relayed entries', async () => {
    // Regression: the hub's chat.append handler used to feed s.chat.append
    // without the ingest flag, so every relayed entry got re-stamped with
    // the local device + a fresh id/ts — breaking roster addressing and
    // destroying dedup keys for a future auto-fanout.
    const { client } = setup();
    const entry = {
      id: 'remote-id-abc',
      ts: '2026-11-01T12:00:00.000Z',
      from: { device: 'mac-mini', shell: 2, agent: 'codex', label: 'Codex' },
      to: [],
      body: 'relayed msg',
    };
    await client.call('chat.append', { projectId, entry });
    const [got] = readRecentChat(projectRoot, 10);
    expect(got).toBeDefined();
    expect(got!.id).toBe('remote-id-abc');
    expect(got!.ts).toBe('2026-11-01T12:00:00.000Z');
    expect(got!.from.device).toBe('mac-mini');
    expect(got!.from.agent).toBe('codex');
  });
});

describe('chat.sync_since over RPC', () => {
  test('returns only entries with ts > since_ts', async () => {
    const { client, chat } = setup();
    const a = await chat.append({ projectId, from: { shell: 1, agent: 'claude' }, body: 'one' });
    // Walk the clock forward a hair so ts is strictly greater.
    await new Promise((r) => setTimeout(r, 2));
    const b = await chat.append({ projectId, from: { shell: 1, agent: 'claude' }, body: 'two' });
    const result = (await client.call('chat.sync_since', { projectId, since_ts: a.entry.ts })) as { entries: Array<{ body: string }> };
    expect(result.entries.map((e) => e.body)).toEqual([b.entry.body]);
  });
});
