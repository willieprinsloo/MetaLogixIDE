import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

vi.mock('electron', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  app: { getVersion: () => '0.0.0-test' },
}));

import { RpcPeer } from '../rpc';
import { pairedTransports } from './_pairedTransports';
import { wireHub, scrubParams } from '../hub';
import { handlers } from '../../ipc/register';
import { PtyManager } from '../../pty/manager';
import { openDb } from '../../db/connection';
import { runMigrations } from '../../db/migrator';
import { RootsRepo } from '../../repos/roots-repo';
import { ProjectsRepo } from '../../repos/projects-repo';
import { waitFor } from './_mockRelay';

const MOCK = resolve(__dirname, '../../../../scripts/mock-claude.mjs');
const migrationsDir = resolve(__dirname, '../../../../migrations');

let dir: string;
let projectRoot: string;
let auditPath: string;
let projects: ProjectsRepo;
let pty: PtyManager;
let projectId: number;

function setup(extra: { auditMaxBytes?: number; events?: { aliveShellsChanged(): void; projectsChanged(): void } } = {}) {
  const [ta, tb] = pairedTransports();
  const client = new RpcPeer(ta.asTransport());
  const server = new RpcPeer(tb.asTransport());
  client.on('error', () => {});
  server.on('error', () => {});
  wireHub(server, {
    remoteDeviceId: 'dev-xyz',
    services: { projects, ptyManager: pty } as never,
    auditLogPath: auditPath,
    ...extra,
  });
  return { client, server };
}

const auditLines = () =>
  existsSync(auditPath) ? readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-'));
  projectRoot = join(dir, 'proj');
  mkdirSync(projectRoot);
  writeFileSync(join(projectRoot, 'a.txt'), 'hello file');
  mkdirSync(join(projectRoot, 'sub'));
  auditPath = join(dir, 'logs', 'p2p-audit.log');
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

describe('hub dispatch', () => {
  test('shells.launch delegates to the local launcher', async () => {
    const spy = vi.spyOn(handlers, 'shells:launch').mockResolvedValue({ shellIndex: 1 });
    const { client } = setup();
    const result = await client.call('shells.launch', { projectId, forceFirst: true });
    expect(result).toEqual({ shellIndex: 1 });
    expect(spy).toHaveBeenCalledWith(expect.anything(), { projectId, forceFirst: true });
  });

  test('shells.launch and shells.kill refresh the local UI', async () => {
    vi.spyOn(handlers, 'shells:launch').mockResolvedValue({ shellIndex: 0 });
    vi.spyOn(handlers, 'shells:kill').mockResolvedValue({ ok: true });
    const events = { aliveShellsChanged: vi.fn(), projectsChanged: vi.fn() };
    const { client } = setup({ events });
    await client.call('shells.launch', { projectId });
    expect(events.aliveShellsChanged).toHaveBeenCalledTimes(1);
    expect(events.projectsChanged).toHaveBeenCalledTimes(1);
    await client.call('shells.kill', { projectId, shellIndex: 0 });
    expect(events.aliveShellsChanged).toHaveBeenCalledTimes(2);
  });

  test('projects.list returns the local project rows shape', async () => {
    const { client } = setup();
    const list = await client.call('projects.list', {});
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toEqual(expect.objectContaining({ id: projectId, name: 'proj', path: projectRoot }));
  });

  test('projects.get unknown id errors', async () => {
    const { client } = setup();
    await expect(client.call('projects.get', { id: 9999 })).rejects.toMatchObject({ code: 'unknown_project' });
  });

  test('device.info returns host info', async () => {
    const { client } = setup();
    const info = await client.call('device.info', {});
    expect(info.version).toBe('0.0.0-test');
  });
});

describe('fs path safety', () => {
  test('fs.read reads a file inside the project', async () => {
    const { client } = setup();
    await expect(client.call('fs.read', { projectId, path: 'a.txt' })).resolves.toEqual({ content: 'hello file', encoding: 'utf8' });
  });

  test('fs.read rejects path traversal', async () => {
    const { client } = setup();
    await expect(client.call('fs.read', { projectId, path: '../../etc/passwd' })).rejects.toMatchObject({ code: 'path_outside_project' });
  });

  test('fs.read rejects absolute paths outside the project root', async () => {
    const { client } = setup();
    await expect(client.call('fs.read', { projectId, path: '/etc/passwd' })).rejects.toMatchObject({ code: 'path_outside_project' });
  });

  test('fs.read rejects a sibling dir sharing the root prefix', async () => {
    mkdirSync(join(dir, 'proj-evil'));
    writeFileSync(join(dir, 'proj-evil', 'x'), 'x');
    const { client } = setup();
    await expect(client.call('fs.read', { projectId, path: '../proj-evil/x' })).rejects.toMatchObject({ code: 'path_outside_project' });
  });

  test('fs.read rejects a symlink escaping the root', async () => {
    writeFileSync(join(dir, 'secret.txt'), 's');
    symlinkSync(join(dir, 'secret.txt'), join(projectRoot, 'link.txt'));
    const { client } = setup();
    await expect(client.call('fs.read', { projectId, path: 'link.txt' })).rejects.toMatchObject({ code: 'path_outside_project' });
  });

  test('fs.list rejects a NUL byte', async () => {
    const { client } = setup();
    await expect(client.call('fs.list', { projectId, path: 'sub\0/..' })).rejects.toMatchObject({ code: 'path_outside_project' });
  });

  test('fs.list lists the project root and absolute in-root paths', async () => {
    const { client } = setup();
    const root = await client.call('fs.list', { projectId, path: '' });
    expect(root.map((d) => d.name).sort()).toEqual(['a.txt', 'sub']);
    expect(root.find((d) => d.name === 'sub')?.isDir).toBe(true);
    await expect(client.call('fs.list', { projectId, path: join(projectRoot, 'sub') })).resolves.toEqual([]);
  });
});

describe('shells.attach scrollback', () => {
  test('replays buffered scrollback on re-attach after the stream drops (Review Focus #1)', async () => {
    await pty.spawn(projectId, 0, { argv: ['node', MOCK], env: {}, cwd: projectRoot, variant: 'first' });
    try {
      const baseData = pty.listenerCount('data');
      const baseExit = pty.listenerCount('exit');
      const { client } = setup();
      const got1: any[] = [];
      const s1 = client.openStream('shells.attach', { projectId, shellIndex: 0 }, (e) => got1.push(e));
      await waitFor(() => got1.map((e) => e.bytes).join('').includes('mock-claude ready'), 4000);
      expect(pty.listenerCount('data')).toBe(baseData + 1);
      s1.close();
      await waitFor(() => pty.listenerCount('data') === baseData && pty.listenerCount('exit') === baseExit, 2000);
      pty.write(projectId, 0, '/size\r');
      // Wait on observable state: the mirror's snapshot has captured the /size output.
      const deadline = Date.now() + 4000;
      while (!/\d+x\d+/.test(await pty.getSnapshot(projectId, 0))) {
        if (Date.now() > deadline) throw new Error('pty snapshot never captured output');
        await new Promise((r) => setTimeout(r, 20));
      }

      const got2: any[] = [];
      client.openStream('shells.attach', { projectId, shellIndex: 0 }, (e) => got2.push(e));
      await waitFor(() => got2.length > 0, 4000);
      expect(got2[0]).toMatchObject({ kind: 'out', bytes: expect.stringContaining('mock-claude ready') });
      expect(got2.map((e) => e.bytes).join('')).toMatch(/\d+x\d+/);
    } finally {
      await pty.kill(projectId, 0);
    }
  });

  test('attach for an unknown shell errors with unknown_shell', async () => {
    const { client } = setup();
    const err = await new Promise<Error>((res) => {
      client.on('error', res);
      client.openStream('shells.attach', { projectId, shellIndex: 42 }, () => {});
    });
    expect(err).toMatchObject({ code: 'unknown_shell' });
  });
});

describe('audit log', () => {
  test('appends one JSON line per RPC call', async () => {
    vi.spyOn(handlers, 'shells:launch').mockResolvedValue({ shellIndex: 0 });
    const { client } = setup();
    await client.call('shells.launch', { projectId });
    const lines = auditLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ remoteDeviceId: 'dev-xyz', method: 'shells.launch', params: { projectId }, outcome: 'ok' });
    expect(typeof lines[0].ts).toBe('number');
  });

  test('records the error code on failure', async () => {
    const { client } = setup();
    await client.call('fs.read', { projectId, path: '../x' }).catch(() => {});
    expect(auditLines()[0].outcome).toEqual({ error: 'path_outside_project' });
  });

  test('unknown wire fields (token) never reach the log', async () => {
    const { client } = setup();
    await client.call('projects.get', { id: projectId, token: 'tok-123' } as never);
    expect(readFileSync(auditPath, 'utf8')).not.toContain('tok-123');
  });

  test('scrubParams redacts token/secret/password, nested too, and strips unknown keys', () => {
    const out = scrubParams('fs.read', { projectId: 1, path: 'a', token: 'T', nested: { secret: 'S', password: 'P' } });
    expect(out).toEqual({ projectId: 1, path: 'a' });
    const loose = scrubParams('projects.get', { id: 1, token: 'T' }, { keepUnknown: true });
    expect(loose).toMatchObject({ id: 1, token: '<redacted>' });
    const nested = scrubParams('projects.get', { id: 1, a: { secret: 'S', ok: 1 } }, { keepUnknown: true });
    expect(nested).toMatchObject({ a: { secret: '<redacted>', ok: 1 } });
  });

  test('rotates at the size threshold, keeping two backups', async () => {
    const { client } = setup({ auditMaxBytes: 300 });
    for (let i = 0; i < 12; i++) await client.call('projects.get', { id: projectId });
    expect(existsSync(auditPath)).toBe(true);
    expect(existsSync(auditPath + '.1')).toBe(true);
    expect(existsSync(auditPath + '.2')).toBe(true);
    expect(existsSync(auditPath + '.3')).toBe(false);
    expect(readFileSync(auditPath, 'utf8').length).toBeLessThanOrEqual(300);
  });
});
