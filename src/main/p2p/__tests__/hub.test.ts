import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
import { NoticeRouter } from '../../notifications/notice-router';
import { Notice, ShellInfo } from '../../../shared/p2p-contract';
import { createDropStaging } from '../../drops/staging';
import { createUploadQuota } from '../uploads';
import { RpcError } from '../rpc';
import { UPLOAD_CHUNK_MAX_B64_CHARS } from '../../../shared/remote-upload-contract';

const MOCK = resolve(__dirname, '../../../../scripts/mock-claude.mjs');
const migrationsDir = resolve(__dirname, '../../../../migrations');

let dir: string;
let projectRoot: string;
let auditPath: string;
let projects: ProjectsRepo;
let pty: PtyManager;
let projectId: number;
let dropDir: string;

function setup(extra: { agentStatus?: { list(): unknown[] } | null; noticeRouter?: NoticeRouter; auditMaxBytes?: number; events?: { aliveShellsChanged(): void; projectsChanged(): void } } = {}) {
  const [ta, tb] = pairedTransports();
  const client = new RpcPeer(ta.asTransport());
  const server = new RpcPeer(tb.asTransport());
  client.on('error', () => {});
  server.on('error', () => {});
  const hub = wireHub(server, {
    remoteDeviceId: 'dev-xyz',
    services: { projects, ptyManager: pty, dropStaging: staging(), ...('agentStatus' in extra ? { agentStatus: extra.agentStatus } : {}), ...(extra.noticeRouter ? { noticeRouter: extra.noticeRouter } : {}) } as never,
    auditLogPath: auditPath,
    auditMaxBytes: extra.auditMaxBytes,
    events: extra.events,
    uploadQuota: createUploadQuota(),
  });
  return { client, server, hub };
}

function staging() {
  return createDropStaging({ dir: dropDir, now: () => new Date(), uid: process.platform === 'win32' ? null : process.getuid!() });
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
  dropDir = join(dir, 'drops');
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

  test('fs.list reports a symlink entry with its own size, not the external target size', async () => {
    const big = join(dir, 'external-big.bin');
    writeFileSync(big, Buffer.alloc(50_000, 1));
    symlinkSync(big, join(projectRoot, 'biglink'));
    const { client } = setup();
    const entries = await client.call('fs.list', { projectId, path: '' });
    const e = entries.find((d) => d.name === 'biglink');
    expect(e).toBeDefined();
    expect(e!.size).toBeLessThan(1000);
    expect(e!.size).not.toBe(50_000);
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
      const got1: Array<{ bytes?: string }> = [];
      const s1 = client.openStream('shells.attach', { projectId, shellIndex: 0 }, (e) => got1.push(e as { bytes?: string }));
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

      const got2: Array<{ bytes?: string }> = [];
      client.openStream('shells.attach', { projectId, shellIndex: 0 }, (e) => got2.push(e as { bytes?: string }));
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

describe('shells.input / shells.resize', () => {
  const b64 = (t: string) => Buffer.from(t, 'utf8').toString('base64');

  test('write and resize act on the attached shell; stream ends -> unknown_stream', async () => {
    await pty.spawn(projectId, 0, { argv: ['node', MOCK], env: {}, cwd: projectRoot, variant: 'first' });
    try {
      const baseData = pty.listenerCount('data');
      const write = vi.spyOn(pty, 'write');
      const resize = vi.spyOn(pty, 'resize');
      const { client } = setup();
      const got: Array<{ bytes?: string }> = [];
      const h = client.openStream('shells.attach', { projectId, shellIndex: 0 }, (e) => got.push(e as { bytes?: string }));
      await waitFor(() => h.stream !== undefined && got.length > 0, 4000);
      const stream = h.stream!;
      expect(await client.call('shells.input', { stream, bytes: b64('ls é\r') })).toEqual({ ok: true });
      expect(write).toHaveBeenCalledWith(projectId, 0, 'ls é\r');
      expect(await client.call('shells.resize', { stream, cols: 100, rows: 30 })).toEqual({ ok: true });
      expect(resize).toHaveBeenCalledWith(projectId, 0, 100, 30);
      h.close();
      await waitFor(() => pty.listenerCount('data') === baseData, 2000);
      await expect(client.call('shells.input', { stream, bytes: b64('x') })).rejects.toMatchObject({ code: 'unknown_stream' });
    } finally {
      await pty.kill(projectId, 0);
    }
  });

  test('both reject unknown_stream when nothing is attached', async () => {
    const write = vi.spyOn(pty, 'write');
    const { client } = setup();
    await expect(client.call('shells.input', { stream: 99, bytes: b64('x') })).rejects.toMatchObject({ code: 'unknown_stream' });
    await expect(client.call('shells.resize', { stream: 99, cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'unknown_stream' });
    expect(write).not.toHaveBeenCalled();
  });

  test('audit log never records keystrokes', async () => {
    const { client } = setup();
    await client.call('shells.input', { stream: 99, bytes: b64('hunter2') }).catch(() => {});
    expect(readFileSync(auditPath, 'utf8')).not.toContain(b64('hunter2'));
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

describe('agent notices for the active IDE instance', () => {
  const NOTICE = { kind: 'needs-input', projectId: 1, shellIndex: 0, projectName: 'p', body: 'Allow Bash?' } as const;
  const until = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); expect(cond()).toBe(true); };

  test('a peer that subscribed and reported recent use receives the notice; closing the stream stops it', async () => {
    const router = new NoticeRouter({ localIdleMs: () => null, now: () => Date.now() });
    const { client } = setup({ noticeRouter: router });
    const got: unknown[] = [];
    const stream = client.openStream('notices.subscribe', {}, (d) => got.push(d));
    await until(() => stream.stream !== undefined);
    expect(router.route(NOTICE)).toBe(false); // subscribed, but has not said it is in use
    await expect(client.call('presence.set', { idleMs: 0 })).resolves.toEqual({ ok: true });
    expect(router.route(NOTICE)).toBe(true);
    await until(() => got.length === 1);
    expect(got[0]).toEqual(NOTICE);
    expect(Notice.safeParse(got[0]).success).toBe(true);

    stream.close();
    await until(() => !router.route(NOTICE));
  });

  test('disposing the link ends its notice stream', async () => {
    const router = new NoticeRouter({ localIdleMs: () => null, now: () => Date.now() });
    const { client, hub } = setup({ noticeRouter: router });
    let closed = false;
    const stream = client.openStream('notices.subscribe', {}, () => {}, () => { closed = true; });
    await until(() => stream.stream !== undefined);
    await client.call('presence.set', { idleMs: 0 });
    await hub.dispose();
    expect(router.route(NOTICE)).toBe(false);
    await until(() => closed);
  });

  test('presence.set rejects a negative or non-numeric age', async () => {
    const { client } = setup({ noticeRouter: new NoticeRouter({ localIdleMs: () => null, now: () => Date.now() }) });
    await expect(client.call('presence.set', { idleMs: -1 })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(client.call('presence.set', { idleMs: 'now' } as never)).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(client.call('presence.set', { idleMs: null })).resolves.toEqual({ ok: true });
  });

  test('without a router, presence is accepted and the stream is refused', async () => {
    const { client } = setup({});
    await expect(client.call('presence.set', { idleMs: 0 })).resolves.toEqual({ ok: true });
    const errors: Error[] = [];
    client.on('error', (e: Error) => errors.push(e));
    client.openStream('notices.subscribe', {}, () => {});
    await until(() => errors.length === 1);
    expect(errors[0]).toMatchObject({ code: 'unsupported' });
  });
});

describe('shells.alive agent state', () => {
  const aliveRows = [
    { projectId: 1, shellIndex: 0, projectName: 'p', projectPath: '/p' },
    { projectId: 1, shellIndex: 1, projectName: 'p', projectPath: '/p' },
    { projectId: 2, shellIndex: 0, projectName: 'q', projectPath: '/q' },
  ];
  const entry = (projectId: number, shellIndex: number, state: string) => ({ projectId, shellIndex, agent: 'claude', state });
  const alive = (extra: Parameters<typeof setup>[0]) => {
    vi.spyOn(handlers, 'shells:alive-list').mockResolvedValue({ shells: aliveRows.map((r) => ({ ...r })) } as never);
    return setup(extra).client.call('shells.alive', {}) as Promise<Array<Record<string, unknown>>>;
  };

  test.each(['idle', 'busy', 'blocked'] as const)('carries %s for a tracked shell and null for an untracked one', async (state) => {
    const rows = await alive({ agentStatus: { list: () => [entry(1, 0, state)] } });
    expect(rows.find((r) => r.projectId === 1 && r.shellIndex === 0)?.agentState).toBe(state);
    expect(rows.find((r) => r.projectId === 1 && r.shellIndex === 1)?.agentState).toBeNull();
    expect(rows.find((r) => r.projectId === 2)?.agentState).toBeNull();
  });

  test('keys state by project and shell, not by shell index alone', async () => {
    const rows = await alive({ agentStatus: { list: () => [entry(2, 0, 'blocked'), entry(1, 1, 'busy')] } });
    expect(rows.map((r) => r.agentState)).toEqual([null, 'busy', 'blocked']);
  });

  test('carries the detected agent with the state, and null for a shell with none', async () => {
    const rows = await alive({ agentStatus: { list: () => [{ projectId: 1, shellIndex: 1, agent: 'opencode', state: 'busy' }] } });
    expect(rows.map((r) => r.agent)).toEqual([null, 'opencode', null]);
  });

  test('leaves the field off when no tracker is installed', async () => {
    const rows = await alive({ agentStatus: null });
    expect(rows).toHaveLength(3);
    for (const r of rows) { expect(r).not.toHaveProperty('agentState'); expect(r).not.toHaveProperty('agent'); }
  });

  test('leaves the field off when the services carry no tracker at all', async () => {
    const rows = await alive({});
    for (const r of rows) expect(r).not.toHaveProperty('agentState');
  });

  test('keeps projectId, shellIndex and the other columns unchanged', async () => {
    const rows = await alive({ agentStatus: { list: () => [entry(1, 0, 'busy')] } });
    expect(rows.map((r) => [r.projectId, r.shellIndex, r.projectName, r.projectPath])).toEqual(
      aliveRows.map((r) => [r.projectId, r.shellIndex, r.projectName, r.projectPath]),
    );
  });

  test('every row parses with the ShellInfo schema, with and without a tracker', async () => {
    for (const agentStatus of [{ list: () => [entry(1, 0, 'busy')] }, null]) {
      const rows = await alive({ agentStatus });
      for (const r of rows) expect(ShellInfo.safeParse(r).success).toBe(true);
    }
  });

  test('does not change the local shells:alive-list result', async () => {
    const spy = vi.spyOn(handlers, 'shells:alive-list').mockResolvedValue({ shells: aliveRows.map((r) => ({ ...r })) } as never);
    await setup({ agentStatus: { list: () => [entry(1, 0, 'busy')] } }).client.call('shells.alive', {});
    const local = await spy.mock.results[0]!.value;
    for (const r of local.shells as object[]) expect(r).not.toHaveProperty('agentState');
  });
});

describe('ShellInfo contract', () => {
  test('accepts the old shape, null and each literal; rejects other values', () => {
    expect(ShellInfo.safeParse({ projectId: 1, shellIndex: 0 }).success).toBe(true);
    expect(ShellInfo.safeParse({ projectId: 1, shellIndex: 0, agentState: null }).success).toBe(true);
    for (const v of ['idle', 'busy', 'blocked']) expect(ShellInfo.safeParse({ projectId: 1, shellIndex: 0, agentState: v }).success).toBe(true);
    expect(ShellInfo.safeParse({ projectId: 1, shellIndex: 0, agentState: 'weird' }).success).toBe(false);
  });
});

describe('drops.upload* (AC-U1, AC-U10, B-S1, B-S6)', () => {
  const b64 = (text: string) => Buffer.from(text).toString('base64');
  const codeOf = async (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e instanceof RpcError ? e.code : String(e)));

  test('begin, chunk and commit stage the bytes in the host drop folder and report the host platform', async () => {
    const { client } = setup();
    const { uploadId, chunkBytes } = await client.call('drops.uploadBegin', { name: 'notes.txt', mime: 'text/plain', size: 11, kind: 'file' });
    expect(chunkBytes).toBeGreaterThan(0);
    await expect(client.call('drops.uploadChunk', { uploadId, offset: 0, data: b64('hello ') })).resolves.toEqual({ received: 6 });
    await client.call('drops.uploadChunk', { uploadId, offset: 6, data: b64('world') });
    const { path, platform } = await client.call('drops.uploadCommit', { uploadId });
    expect(platform).toBe(process.platform);
    expect(path).toBe(join(staging().dir, 'notes.txt'));
    expect(readFileSync(path, 'utf8')).toBe('hello world');
  });

  test('abort discards the partial file', async () => {
    const { client } = setup();
    const { uploadId } = await client.call('drops.uploadBegin', { name: 'a.bin', mime: '', size: 6, kind: 'file' });
    await client.call('drops.uploadChunk', { uploadId, offset: 0, data: b64('abc') });
    await expect(client.call('drops.uploadAbort', { uploadId })).resolves.toEqual({ ok: true });
    expect(readdirSync(dropDir)).toEqual([]);
  });

  test.each([
    ['an oversized chunk', 'drops.uploadChunk', { uploadId: 'x', offset: 0, data: 'A'.repeat(UPLOAD_CHUNK_MAX_B64_CHARS + 4) }],
    ['an oversized name', 'drops.uploadBegin', { name: 'n'.repeat(1025), mime: '', size: 1, kind: 'file' }],
    ['an oversized mime', 'drops.uploadBegin', { name: 'n', mime: 'm'.repeat(256), size: 1, kind: 'file' }],
    ['a negative size', 'drops.uploadBegin', { name: 'n', mime: '', size: -1, kind: 'file' }],
    ['a fractional size', 'drops.uploadBegin', { name: 'n', mime: '', size: 1.5, kind: 'file' }],
    ['a size over 50 MB', 'drops.uploadBegin', { name: 'n', mime: '', size: 50 * 1024 * 1024 + 1, kind: 'file' }],
    ['an unknown kind', 'drops.uploadBegin', { name: 'n', mime: '', size: 1, kind: 'dir' }],
    ['a negative offset', 'drops.uploadChunk', { uploadId: 'x', offset: -1, data: '' }],
    ['an oversized upload id', 'drops.uploadCommit', { uploadId: 'u'.repeat(65) }],
  ])('rejects %s with invalid_params before any sink opens', async (_label, method, params) => {
    const { client } = setup();
    expect(await codeOf(client.call(method as never, params as never))).toBe('invalid_params');
    expect(existsSync(dropDir)).toBe(false);
  });

  test('unknown begin fields are stripped, not stored or logged', async () => {
    const { client } = setup();
    await client.call('drops.uploadBegin', { name: 'a.txt', mime: 'text/plain', size: 0, kind: 'file', path: '/etc/evil' } as never);
    expect(readFileSync(auditPath, 'utf8')).not.toContain('/etc/evil');
  });

  test('audit lines carry no base64 payload, a sanitised name, and one summary per upload', async () => {
    const { client } = setup();
    const payload = b64('top secret file body');
    const { uploadId } = await client.call('drops.uploadBegin', { name: '../../etc/pass wd', mime: 'text/plain', size: 20, kind: 'file' });
    await client.call('drops.uploadChunk', { uploadId, offset: 0, data: payload });
    await client.call('drops.uploadCommit', { uploadId });
    const raw = readFileSync(auditPath, 'utf8');
    expect(raw).not.toContain(payload);
    expect(raw).not.toContain('../');
    const lines = auditLines();
    const beginLine = lines.find((l) => l.method === 'drops.uploadBegin');
    expect(beginLine.params).toMatchObject({ name: 'pass wd', size: 20, kind: 'file' });
    const chunkLine = lines.find((l) => l.method === 'drops.uploadChunk');
    expect(chunkLine.params).toEqual({ uploadId, offset: 0, data: `<${payload.length} b64 chars>` });
    const summaries = lines.filter((l) => l.method === 'drops.upload');
    expect(summaries).toEqual([
      { ts: expect.any(Number), remoteDeviceId: 'dev-xyz', method: 'drops.upload', name: 'pass wd', size: 20, outcome: 'staged' },
    ]);
  });

  test('an aborted upload is summarised with its reason', async () => {
    const { client } = setup();
    const { uploadId } = await client.call('drops.uploadBegin', { name: 'a.txt', mime: '', size: 2, kind: 'file' });
    await client.call('drops.uploadChunk', { uploadId, offset: 0, data: b64('abc') }).catch(() => {});
    expect(auditLines().filter((l) => l.method === 'drops.upload')).toMatchObject([{ name: 'a.txt', size: 2, outcome: 'aborted:overrun' }]);
  });

  test('scrubParams sanitises a begin name and hides chunk data even for odd shapes', () => {
    expect(scrubParams('drops.uploadBegin', { name: 'x/../.hidden', mime: 'text/plain', size: 1, kind: 'file' })).toMatchObject({ name: 'hidden' });
    expect(scrubParams('drops.uploadChunk', { uploadId: 'u', offset: 0, data: 'QUJD' })).toEqual({ uploadId: 'u', offset: 0, data: '<4 b64 chars>' });
    expect(scrubParams('drops.uploadChunk', { uploadId: 'u', offset: 0, data: 7 })).toBeUndefined();
  });

  test('dispose aborts uploads in progress and leaves the drop folder empty (AC-U6)', async () => {
    const { client, hub } = setup();
    const { uploadId } = await client.call('drops.uploadBegin', { name: 'a.txt', mime: '', size: 6, kind: 'file' });
    await client.call('drops.uploadChunk', { uploadId, offset: 0, data: b64('abc') });
    await hub.dispose();
    expect(readdirSync(dropDir)).toEqual([]);
    expect(auditLines().filter((l) => l.method === 'drops.upload')).toMatchObject([{ outcome: 'aborted:link-closed' }]);
  });

  test('an upload id from another link is unknown here (B-S2)', async () => {
    const a = setup();
    const b = setup();
    const { uploadId } = await a.client.call('drops.uploadBegin', { name: 'a.txt', mime: '', size: 3, kind: 'file' });
    expect(await codeOf(b.client.call('drops.uploadChunk', { uploadId, offset: 0, data: b64('abc') }))).toBe('upload_unknown');
    await expect(a.client.call('drops.uploadChunk', { uploadId, offset: 0, data: b64('abc') })).resolves.toEqual({ received: 3 });
  });
});

describe('upload caps are host-wide across links (AC-U8)', () => {
  test('two links from the same device share its four upload slots by default', async () => {
    const link = (remoteDeviceId = 'dev-xyz') => {
      const [ta, tb] = pairedTransports();
      const client = new RpcPeer(ta.asTransport());
      const server = new RpcPeer(tb.asTransport());
      client.on('error', () => {});
      server.on('error', () => {});
      const hub = wireHub(server, { remoteDeviceId, services: { dropStaging: staging() } as never, auditLogPath: auditPath });
      return { client, hub };
    };
    const a = link();
    const b = link();
    const begin = (c: RpcPeer) => c.call('drops.uploadBegin', { name: 'a.txt', mime: '', size: 1, kind: 'file' });
    await Promise.all([begin(a.client), begin(a.client), begin(b.client), begin(b.client)]);
    await expect(begin(b.client)).rejects.toMatchObject({ code: 'too_many_uploads' });
    await expect(begin(a.client)).rejects.toMatchObject({ code: 'too_many_uploads' });
    await a.hub.dispose();
    await expect(begin(b.client)).resolves.toBeDefined();
    const other = link('dev-other');
    await expect(Promise.all([1, 2, 3, 4].map(() => begin(other.client)))).resolves.toHaveLength(4);
    await Promise.all([b.hub.dispose(), other.hub.dispose()]);
  });
});
