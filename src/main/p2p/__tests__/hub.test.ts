import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, existsSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

vi.mock('electron', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  app: { getVersion: () => '0.0.0-test', getPath: (name: string) => join(dir, `electron-${name}`) },
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
import { SettingsRepo } from '../../repos/settings-repo';
import { activityPath, appendActivity } from '../../activity/log';
import * as git from '../../git/run-git';
import { waitFor } from './_mockRelay';
import { NoticeRouter } from '../../notifications/notice-router';
import { Notice, ShellInfo } from '../../../shared/p2p-contract';
import { createDropStaging } from '../../drops/staging';
import { createUploadQuota } from '../uploads';
import { MAX_RPC_FRAME_BYTES, RpcError } from '../rpc';
import { UPLOAD_CHUNK_MAX_B64_CHARS } from '../../../shared/remote-upload-contract';

const MOCK = resolve(__dirname, '../../../../scripts/mock-claude.mjs');
const migrationsDir = resolve(__dirname, '../../../../migrations');

let dir: string;
let projectRoot: string;
let auditPath: string;
let db: ReturnType<typeof openDb>;
let projects: ProjectsRepo;
let settings: SettingsRepo;
let pty: PtyManager;
let projectId: number;
let rootId: number;
let dropDir: string;

function setup(extra: {
  agentStatus?: { list(): unknown[] } | null;
  noticeRouter?: NoticeRouter;
  auditMaxBytes?: number;
  events?: { aliveShellsChanged(): void; projectsChanged(): void };
  desktopWorkspaceAllowed?: boolean;
} = {}) {
  const [ta, tb] = pairedTransports();
  const client = new RpcPeer(ta.asTransport());
  const server = new RpcPeer(tb.asTransport());
  client.on('error', () => {});
  server.on('error', () => {});
  const hub = wireHub(server, {
    remoteDeviceId: 'dev-xyz',
    desktopWorkspaceAllowed: extra.desktopWorkspaceAllowed,
    services: {
      db, projects, settings, ptyManager: pty, dropStaging: staging(),
      homeDir: join(dir, 'service-home'), hookRuntime: { settingsPath: () => null },
      ...('agentStatus' in extra ? { agentStatus: extra.agentStatus } : {}),
      ...(extra.noticeRouter ? { noticeRouter: extra.noticeRouter } : {}),
    } as never,
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
  db = openDb(join(dir, 'database', 'not-the-default-name.sqlite'));
  runMigrations(db, migrationsDir);
  rootId = new RootsRepo(db).add(dir).id;
  projects = new ProjectsRepo(db);
  settings = new SettingsRepo(db);
  projectId = projects.upsert(rootId, projectRoot, 'proj').id;
  pty = new PtyManager();
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
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

describe('paired desktop workspace', () => {
  const allowed = { desktopWorkspaceAllowed: true };

  test('fails closed before project lookup for a viewer-only or unclassified peer; old fs remains available', async () => {
    const get = vi.spyOn(projects, 'get');
    for (const { client } of [setup(), setup({ desktopWorkspaceAllowed: false })]) {
      await expect(client.call('workspace.info', { projectId: 9999 })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(client.call('workspace.fileWrite', { projectId, relPath: 'a.txt', content: 'denied' }))
        .rejects.toMatchObject({ code: 'forbidden' });
      await expect(client.call('workspace.activity', { projectId })).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(get).not.toHaveBeenCalled();
    expect(readFileSync(join(projectRoot, 'a.txt'), 'utf8')).toBe('hello file');
    await expect(setup().client.call('fs.read', { projectId, path: 'a.txt' })).resolves.toMatchObject({ content: 'hello file' });
    await expect(setup(allowed).client.call('workspace.info', { projectId: 9999 }))
      .rejects.toMatchObject({ code: 'unknown_project' });
  });

  test('refuses a parent when a hidden child is registered on the same link but allows direct child access', async () => {
    const { client } = setup(allowed);
    await expect(client.call('workspace.info', { projectId })).resolves.toEqual({ activityEnabled: true });

    const childPath = join(projectRoot, 'sub');
    const childId = projects.upsert(rootId, childPath, 'Hidden child').id;
    projects.setHidden(childId, true);
    settings.set('activity_log_enabled', false);
    writeFileSync(join(childPath, 'ordinary.txt'), 'child fixture');
    const denied = { code: 'forbidden', message: 'this project is not available through remote workspace' };
    await expect(client.call('workspace.info', { projectId })).rejects.toMatchObject(denied);
    await expect(client.call('workspace.fileTree', { projectId })).rejects.toMatchObject(denied);
    await expect(client.call('workspace.diffStatus', { projectId })).rejects.toMatchObject(denied);
    await expect(client.call('workspace.agentSettings', { projectId })).rejects.toMatchObject(denied);
    await expect(client.call('workspace.activity', { projectId })).rejects.toMatchObject(denied);
    await expect(client.call('workspace.activity', { projectId: childId })).rejects.toMatchObject({ code: 'activity_disabled' });
    await expect(client.call('workspace.fileRead', { projectId: childId, relPath: 'ordinary.txt' }))
      .resolves.toMatchObject({ content: 'child fixture' });
    await expect(client.call('fs.read', { projectId, path: 'a.txt' })).resolves.toMatchObject({ content: 'hello file' });

    projects.remove(childId);
    await expect(client.call('workspace.info', { projectId })).resolves.toEqual({ activityEnabled: false });
  });

  test.each(['database', 'electron-userData', 'service-home', 'logs'])(
    'refuses roots overlapping configured host state (%s) without disabling independent roots',
    async (location) => {
      const candidate = join(dir, location);
      mkdirSync(candidate, { recursive: true });
      const candidateId = projects.upsert(rootId, candidate, 'Overlap').id;
      const { client } = setup(allowed);
      await expect(client.call('workspace.info', { projectId: candidateId }))
        .rejects.toMatchObject({ code: 'forbidden', message: 'this project is not available through remote workspace' });
      await expect(client.call('workspace.info', { projectId })).resolves.toEqual({ activityEnabled: true });
    },
  );

  test.skipIf(process.platform === 'win32')('checks configured audit backup aliases on each request', async () => {
    const { client } = setup(allowed);
    await expect(client.call('workspace.info', { projectId })).resolves.toEqual({ activityEnabled: true });
    const alias = `${auditPath}.2`;
    symlinkSync(join(projectRoot, 'uncreated-audit-fixture'), alias);
    await expect(client.call('workspace.info', { projectId }))
      .rejects.toMatchObject({ code: 'forbidden', message: 'this project is not available through remote workspace' });
    rmSync(alias);
    await expect(client.call('workspace.info', { projectId })).resolves.toEqual({ activityEnabled: true });
  });

  test.skipIf(process.platform === 'win32')('does not navigate outward links toward host storage in an otherwise safe project', async () => {
    const profile = join(dir, 'electron-userData');
    mkdirSync(profile);
    symlinkSync(profile, join(projectRoot, 'profile'));
    const { client } = setup(allowed);
    await expect(client.call('workspace.fileTree', { projectId })).resolves.toMatchObject({
      entries: [{ name: 'sub' }, { name: 'a.txt' }],
    });
    await expect(client.call('workspace.fileTree', { projectId, relPath: 'profile' }))
      .rejects.toMatchObject({ code: 'path_outside_project' });
  });

  test('scopes directory, text preview, and ordinary file mutations to the selected project', async () => {
    const otherPath = join(dir, 'other-project');
    mkdirSync(otherPath);
    writeFileSync(join(otherPath, 'a.txt'), 'other');
    const { client } = setup(allowed);
    await expect(client.call('workspace.fileTree', { projectId })).resolves.toEqual({ entries: [
      { name: 'sub', isDir: true, relPath: 'sub' }, { name: 'a.txt', isDir: false, relPath: 'a.txt' },
    ] });
    await expect(client.call('workspace.fileMkdir', { projectId, relPath: 'new/nested' })).resolves.toEqual({ ok: true });
    const content = 'save-AUDIT-CONTENT-é';
    await expect(client.call('workspace.fileWrite', { projectId, relPath: 'new/nested/save.txt', content }))
      .resolves.toEqual({ ok: true, sizeBytes: Buffer.byteLength(content) });
    await expect(client.call('workspace.fileRename', { projectId, from: 'new/nested/save.txt', to: 'a.txt' }))
      .rejects.toMatchObject({ code: 'already_exists' });
    await expect(client.call('workspace.fileRename', { projectId, from: 'new/nested/save.txt', to: 'sub/moved.txt' }))
      .resolves.toEqual({ ok: true });
    await expect(client.call('workspace.fileRead', { projectId, relPath: 'sub/moved.txt' }))
      .resolves.toEqual({ content, kind: 'text', sizeBytes: Buffer.byteLength(content) });
    await expect(client.call('workspace.fileDelete', { projectId, relPath: 'sub' })).resolves.toEqual({ ok: true });
    expect(existsSync(join(projectRoot, 'sub'))).toBe(false);
    expect(readFileSync(join(otherPath, 'a.txt'), 'utf8')).toBe('other');
    expect(readFileSync(auditPath, 'utf8')).not.toContain('AUDIT-CONTENT');
    expect(auditLines()).toContainEqual(expect.objectContaining({
      method: 'workspace.fileWrite', params: { projectId, relPath: 'new/nested/save.txt' }, outcome: 'ok',
    }));
  });

  test('publishes new files exclusively and leaves existing bytes and directories alone', async () => {
    const { client } = setup(allowed);
    const request = { projectId, createOnly: true, relPath: 'fresh.txt', content: '' };
    await expect(client.call('workspace.fileWrite', request)).resolves.toEqual({ ok: true, sizeBytes: 0 });
    await expect(client.call('workspace.fileRead', { projectId, relPath: 'fresh.txt' }))
      .resolves.toEqual({ content: '', kind: 'text', sizeBytes: 0 });
    await expect(client.call('workspace.fileWrite', { ...request, createOnly: false, content: 'now filled' }))
      .resolves.toEqual({ ok: true, sizeBytes: 10 });
    await expect(client.call('workspace.fileWrite', request)).rejects.toMatchObject({ code: 'already_exists' });
    await expect(client.call('workspace.fileWrite', { ...request, relPath: 'sub' }))
      .rejects.toMatchObject({ code: 'already_exists' });
    expect(readFileSync(join(projectRoot, 'fresh.txt'), 'utf8')).toBe('now filled');
    expect(readdirSync(projectRoot).sort()).toEqual(['a.txt', 'fresh.txt', 'sub']);
  });

  test.skipIf(process.platform === 'win32')('replaces regular text while preserving POSIX permissions', async () => {
    const file = join(projectRoot, 'a.txt');
    chmodSync(file, 0o751);
    const { client } = setup(allowed);
    await expect(client.call('workspace.fileWrite', { projectId, relPath: 'a.txt', content: 'preserved mode' }))
      .resolves.toEqual({ ok: true, sizeBytes: 14 });
    expect(readFileSync(file, 'utf8')).toBe('preserved mode');
    expect(statSync(file).mode & 0o7777).toBe(0o751);
  });

  test.skipIf(process.platform === 'win32')('allows an in-project alias preview but never replaces the leaf link on save or create', async () => {
    const link = join(projectRoot, 'alias.txt');
    symlinkSync('a.txt', link);
    const { client } = setup(allowed);
    const request = { projectId, relPath: 'alias.txt' };
    await expect(client.call('workspace.fileTree', { projectId })).resolves.toEqual({ entries: [
      { name: 'sub', isDir: true, relPath: 'sub' },
      { name: 'a.txt', isDir: false, relPath: 'a.txt' },
      { name: 'alias.txt', isDir: false, relPath: 'alias.txt' },
    ] });
    await expect(client.call('workspace.fileRead', request)).resolves.toMatchObject({ content: 'hello file' });
    await expect(client.call('workspace.fileWrite', { ...request, content: 'discarded' }))
      .rejects.toMatchObject({ code: 'symlink_not_writable' });
    await expect(client.call('workspace.fileWrite', { ...request, content: '', createOnly: true }))
      .rejects.toMatchObject({ code: 'already_exists' });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe('a.txt');
    expect(readFileSync(link, 'utf8')).toBe('hello file');
  });

  test('rejects directories where file bytes are required and keeps directory operations distinct', async () => {
    const { client } = setup(allowed);
    await expect(client.call('workspace.fileTree', { projectId, relPath: 'sub' })).resolves.toEqual({ entries: [] });
    await expect(client.call('workspace.fileRead', { projectId, relPath: 'sub' }))
      .rejects.toMatchObject({ code: 'is_directory' });
    await expect(client.call('workspace.fileWrite', { projectId, relPath: 'sub', content: 'no' }))
      .rejects.toMatchObject({ code: 'is_directory' });
    await expect(client.call('workspace.fileMkdir', { projectId, relPath: 'sub' }))
      .rejects.toMatchObject({ code: 'already_exists' });
    await expect(client.call('workspace.fileDelete', { projectId, relPath: 'missing.txt' })).resolves.toEqual({ ok: true });
    expect(readdirSync(join(projectRoot, 'sub'))).toEqual([]);
  });

  test.skipIf(process.platform === 'win32')('rejects external and dangling symlinks, including missing destination ancestors and a root alias', async () => {
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret'), 'outside');
    symlinkSync(outside, join(projectRoot, 'escape'));
    symlinkSync(join(outside, 'missing'), join(projectRoot, 'dangling'));
    symlinkSync(projectRoot, join(projectRoot, 'root-alias'));
    const { client } = setup(allowed);
    await expect(client.call('workspace.fileTree', { projectId })).resolves.toMatchObject({
      entries: [{ name: 'sub' }, { name: 'a.txt' }],
    });
    await expect(client.call('workspace.fileRead', { projectId, relPath: 'escape/secret' }))
      .rejects.toMatchObject({ code: 'path_outside_project' });
    await expect(client.call('workspace.fileWrite', { projectId, relPath: 'escape/new', content: 'denied' }))
      .rejects.toMatchObject({ code: 'path_outside_project' });
    await expect(client.call('workspace.fileMkdir', { projectId, relPath: 'escape/new/nested' }))
      .rejects.toMatchObject({ code: 'path_outside_project' });
    await expect(client.call('workspace.fileRename', { projectId, from: 'a.txt', to: 'escape/new' }))
      .rejects.toMatchObject({ code: 'path_outside_project' });
    await expect(client.call('workspace.fileWrite', { projectId, relPath: 'dangling', content: 'denied' }))
      .rejects.toMatchObject({ code: 'path_outside_project' });
    await expect(client.call('workspace.fileDelete', { projectId, relPath: 'escape/secret' }))
      .rejects.toMatchObject({ code: 'path_outside_project' });
    await expect(client.call('workspace.fileDelete', { projectId, relPath: 'root-alias' }))
      .rejects.toMatchObject({ code: 'project_root' });
    expect(readdirSync(outside)).toEqual(['secret']);
    expect(readFileSync(join(projectRoot, 'a.txt'), 'utf8')).toBe('hello file');
  });

  test('rejects root mutations, absolute paths and traversal', async () => {
    const { client } = setup(allowed);
    await expect(client.call('workspace.fileWrite', { projectId, relPath: '.', content: 'denied' }))
      .rejects.toMatchObject({ code: 'project_root' });
    await expect(client.call('workspace.fileMkdir', { projectId, relPath: 'sub/..' }))
      .rejects.toMatchObject({ code: 'project_root' });
    await expect(client.call('workspace.fileRename', { projectId, from: '.', to: 'gone' }))
      .rejects.toMatchObject({ code: 'project_root' });
    await expect(client.call('workspace.fileRename', { projectId, from: 'a.txt', to: '.' }))
      .rejects.toMatchObject({ code: 'project_root' });
    await expect(client.call('workspace.fileDelete', { projectId, relPath: '.' }))
      .rejects.toMatchObject({ code: 'project_root' });
    for (const relPath of ['../elsewhere', join(projectRoot, 'a.txt'), 'a.txt\0']) {
      await expect(client.call('workspace.fileRead', { projectId, relPath }))
        .rejects.toMatchObject({ code: 'path_outside_project' });
    }
    expect(readFileSync(join(projectRoot, 'a.txt'), 'utf8')).toBe('hello file');
  });

  test('denies direct and differently cased Git metadata writes and protects a linked gitdir', async () => {
    mkdirSync(join(projectRoot, 'git-data'));
    writeFileSync(join(projectRoot, '.git'), 'gitdir: git-data\n');
    writeFileSync(join(projectRoot, 'git-data', 'config'), '[core]\n');
    const { client } = setup(allowed);
    await expect(client.call('workspace.fileWrite', { projectId, relPath: '.GIT', content: 'no' }))
      .rejects.toMatchObject({ code: 'protected_path' });
    await expect(client.call('workspace.fileMkdir', { projectId, relPath: 'sub/.GiT/objects' }))
      .rejects.toMatchObject({ code: 'protected_path' });
    await expect(client.call('workspace.fileWrite', { projectId, relPath: 'git-data/config', content: 'no' }))
      .rejects.toMatchObject({ code: 'protected_path' });
    await expect(client.call('workspace.fileDelete', { projectId, relPath: 'git-data' }))
      .rejects.toMatchObject({ code: 'protected_path' });
    mkdirSync(join(projectRoot, 'sub', '.git'));
    await expect(client.call('workspace.fileDelete', { projectId, relPath: 'sub' }))
      .rejects.toMatchObject({ code: 'protected_path' });
    await expect(client.call('workspace.fileRename', { projectId, from: 'sub', to: 'elsewhere' }))
      .rejects.toMatchObject({ code: 'protected_path' });
    expect(readFileSync(join(projectRoot, '.git'), 'utf8')).toBe('gitdir: git-data\n');
    expect(readFileSync(join(projectRoot, 'git-data', 'config'), 'utf8')).toBe('[core]\n');
  });

  test.skipIf(process.platform === 'win32')('denies in-project aliases to Git metadata and the Activity log', async () => {
    mkdirSync(join(projectRoot, '.git'));
    mkdirSync(join(projectRoot, '.metaide'));
    writeFileSync(join(projectRoot, '.metaide', 'activity.jsonl'), 'private-timeline');
    symlinkSync(join(projectRoot, '.git'), join(projectRoot, 'git-alias'));
    symlinkSync(join(projectRoot, '.metaide', 'activity.jsonl'), join(projectRoot, 'timeline-alias'));
    const { client } = setup(allowed);
    await expect(client.call('workspace.fileWrite', { projectId, relPath: 'git-alias/config', content: 'no' }))
      .rejects.toMatchObject({ code: 'protected_path' });
    await expect(client.call('workspace.fileRename', { projectId, from: 'sub', to: 'git-alias/sub' }))
      .rejects.toMatchObject({ code: 'protected_path' });
    await expect(client.call('workspace.fileRead', { projectId, relPath: 'timeline-alias' }))
      .rejects.toMatchObject({ code: 'protected_path' });
    await expect(client.call('workspace.fileDelete', { projectId, relPath: 'timeline-alias' }))
      .rejects.toMatchObject({ code: 'protected_path' });
    expect(existsSync(join(projectRoot, '.git', 'config'))).toBe(false);
    expect(readFileSync(join(projectRoot, '.metaide', 'activity.jsonl'), 'utf8')).toBe('private-timeline');
  });

  test('bounds file bytes and encoded response size; binary preview can opt into text', async () => {
    const { client } = setup(allowed);
    const relPath = 'a.txt';
    writeFileSync(join(projectRoot, relPath), Buffer.from([65, 0, 66]));
    await expect(client.call('workspace.fileRead', { projectId, relPath }))
      .resolves.toEqual({ content: '', kind: 'binary', sizeBytes: 3 });
    await expect(client.call('workspace.fileRead', { projectId, relPath, forceText: true }))
      .resolves.toEqual({ content: 'A\0B', kind: 'text', sizeBytes: 3 });
    await expect(client.call('workspace.fileWrite', { projectId, relPath, content: 'é'.repeat(256 * 1024 + 1) }))
      .rejects.toMatchObject({ code: 'file_too_large' });
    expect(readFileSync(join(projectRoot, relPath))).toEqual(Buffer.from([65, 0, 66]));
    writeFileSync(join(projectRoot, relPath), 'a'.repeat(512 * 1024 + 1));
    await expect(client.call('workspace.fileRead', { projectId, relPath })).rejects.toMatchObject({ code: 'file_too_large' });
    writeFileSync(join(projectRoot, relPath), '\u0001'.repeat(200_000));
    await expect(client.call('workspace.fileRead', { projectId, relPath })).rejects.toMatchObject({ code: 'result_too_large' });
    await expect(client.call('workspace.info', { projectId })).resolves.toMatchObject({ activityEnabled: true });
  });

  test('projects host agent names only, rejects nonexistent choices, and redacts setting parameters', async () => {
    const name = 'private-agent-name';
    settings.set('default_cli_profiles', [{ name, argv: ['private-argv'], env: { CLI_TOKEN: 'private-env' } }]);
    projects.updateConfig(projectId, { env: { PROJECT_TOKEN: 'private-project-env' } });
    const events = { aliveShellsChanged: vi.fn(), projectsChanged: vi.fn() };
    const { client } = setup({ ...allowed, events });
    await expect(client.call('workspace.agentSettings', { projectId })).resolves.toEqual({
      defaultAgent: null, choices: ['Terminal', name], hasCustomCommand: false,
    });
    await expect(client.call('workspace.setDefaultAgent', { projectId, defaultAgent: 'missing-profile' }))
      .rejects.toMatchObject({ code: 'unknown_agent' });
    expect(projects.get(projectId)?.config.defaultCliName).toBeUndefined();
    const request = { projectId, defaultAgent: name, env: { PROJECT_TOKEN: 'malicious-extra' } };
    await expect(client.call('workspace.setDefaultAgent', request))
      .resolves.toEqual({ defaultAgent: name, choices: ['Terminal', name], hasCustomCommand: false });
    expect(projects.get(projectId)?.config).toMatchObject({ defaultCliName: name, env: { PROJECT_TOKEN: 'private-project-env' } });
    await expect(client.call('workspace.setDefaultAgent', { projectId, defaultAgent: null })).resolves.toMatchObject({ defaultAgent: null });
    expect(events.projectsChanged).toHaveBeenCalledTimes(2);
    expect(readFileSync(auditPath, 'utf8')).not.toMatch(/private-agent-name|missing-profile|private-argv|private-env|private-project-env|malicious-extra/);
    expect(auditLines()).toContainEqual(expect.objectContaining({ method: 'workspace.setDefaultAgent', params: {}, outcome: 'ok' }));
  });

  test('keeps workspace launch definitions host-owned while Settings selects an installed profile by name', async () => {
    settings.set('default_cli_profiles', []);
    const meta = join(projectRoot, '.metaide');
    const catalog = JSON.stringify([{ name: 'Repo agent', argv: ['host-only-command'], env: { TOKEN: 'host-only-token' } }]);
    mkdirSync(meta);
    writeFileSync(join(meta, 'cli-profiles.json'), catalog);
    writeFileSync(join(meta, 'env'), 'TITLE=host-env');
    const { client } = setup(allowed);
    for (const relPath of ['.metaide/cli-profiles.json', '.metaide/env', '.METAIDE/CLI-PROFILES.JSON']) {
      await expect(client.call('workspace.fileWrite', { projectId, relPath, content: 'denied' }))
        .rejects.toMatchObject({ code: 'protected_path' });
      await expect(client.call('workspace.fileDelete', { projectId, relPath }))
        .rejects.toMatchObject({ code: 'protected_path' });
    }
    await expect(client.call('workspace.fileMkdir', { projectId, relPath: '.metaide/cli-profiles.json' }))
      .rejects.toMatchObject({ code: 'protected_path' });
    await expect(client.call('workspace.fileRename', { projectId, from: 'sub', to: '.metaide' }))
      .rejects.toMatchObject({ code: 'protected_path' });
    await expect(client.call('workspace.fileWrite', { projectId, relPath: '.metaide/notes', content: 'ordinary text' }))
      .resolves.toMatchObject({ ok: true });
    await expect(client.call('workspace.setDefaultAgent', { projectId, defaultAgent: 'Repo agent' })).resolves.toEqual({
      defaultAgent: 'Repo agent', choices: ['Terminal', 'Repo agent'], hasCustomCommand: false,
    });
    await expect(client.call('workspace.agentSettings', { projectId })).resolves.toEqual({
      defaultAgent: 'Repo agent', choices: ['Terminal', 'Repo agent'], hasCustomCommand: false,
    });
    expect(readFileSync(join(meta, 'cli-profiles.json'), 'utf8')).toBe(catalog);
    expect(readFileSync(join(meta, 'env'), 'utf8')).toBe('TITLE=host-env');
    expect(readFileSync(join(meta, 'notes'), 'utf8')).toBe('ordinary text');
    expect(readFileSync(auditPath, 'utf8')).not.toMatch(/Repo agent|host-only-command|host-only-token|host-env/);
  });

  test.skipIf(process.platform === 'win32')('protects launch symlink aliases, dangling targets and the directories carrying them', async () => {
    const path = (relPath: string) => join(projectRoot, relPath);
    mkdirSync(path('launch-meta'));
    mkdirSync(path('launch-data'));
    writeFileSync(path('launch-data/catalog'), '[]');
    symlinkSync('launch-meta', path('.metaide'));
    symlinkSync('../launch-data/catalog', path('launch-meta/cli-profiles.json'));
    symlinkSync('../launch-data/future-env', path('launch-meta/env'));
    symlinkSync('launch-data', path('alias'));
    const { client } = setup(allowed);
    for (const relPath of ['launch-meta/cli-profiles.json', 'launch-data/catalog', 'alias/catalog', 'alias/future-env']) {
      await expect(client.call('workspace.fileWrite', { projectId, relPath, content: 'denied', createOnly: true }))
        .rejects.toMatchObject({ code: 'protected_path' });
    }
    for (const from of ['launch-meta', 'launch-data']) {
      await expect(client.call('workspace.fileRename', { projectId, from, to: 'archive' }))
        .rejects.toMatchObject({ code: 'protected_path' });
      await expect(client.call('workspace.fileDelete', { projectId, relPath: from }))
        .rejects.toMatchObject({ code: 'protected_path' });
    }
    await expect(client.call('workspace.fileRename', { projectId, from: 'a.txt', to: 'launch-data/future-env' }))
      .rejects.toMatchObject({ code: 'protected_path' });
    await expect(client.call('workspace.fileMkdir', { projectId, relPath: 'launch-data/future-env' }))
      .rejects.toMatchObject({ code: 'protected_path' });
    await expect(client.call('workspace.fileWrite', { projectId, relPath: '.metaide/notes', content: 'ok' }))
      .resolves.toMatchObject({ ok: true });
    expect(readFileSync(path('launch-data/catalog'), 'utf8')).toBe('[]');
    expect(readFileSync(path('a.txt'), 'utf8')).toBe('hello file');
    expect(readFileSync(path('launch-meta/notes'), 'utf8')).toBe('ok');
    expect(existsSync(path('launch-data/future-env'))).toBe(false);
    expect(readlinkSync(path('.metaide'))).toBe('launch-meta');
  });

  test('rejects an oversized catalog during both Settings operations without persisting a selection', async () => {
    const meta = join(projectRoot, '.metaide');
    mkdirSync(meta);
    writeFileSync(join(meta, 'cli-profiles.json'), ' '.repeat(512 * 1024 + 1));
    const { client } = setup(allowed);
    await expect(client.call('workspace.agentSettings', { projectId })).rejects.toMatchObject({ code: 'file_too_large' });
    await expect(client.call('workspace.setDefaultAgent', { projectId, defaultAgent: 'Terminal' }))
      .rejects.toMatchObject({ code: 'file_too_large' });
    expect(projects.get(projectId)?.config.defaultCliName).toBeUndefined();
  });

  test('detects either legacy variant and never clears custom commands remotely', async () => {
    const { client } = setup(allowed);
    const command = { argv: ['private-custom-argv'], env: { CUSTOM_VALUE: 'private-custom-env' } };
    for (const launchCmd of [{ first: command }, { subsequent: command }]) {
      projects.updateConfig(projectId, { launchCmd });
      const current = await client.call('workspace.agentSettings', { projectId });
      expect(current.hasCustomCommand).toBe(true);
      expect(JSON.stringify(current)).not.toMatch(/private-custom|launchCmd/);
      await expect(client.call('workspace.setDefaultAgent', { projectId, defaultAgent: null }))
        .rejects.toMatchObject({ code: 'custom_command' });
      expect(projects.get(projectId)?.config.launchCmd).toEqual(launchCmd);
    }
  });

  test('requires activity logging and resolves only existing in-project file targets', async () => {
    const { client } = setup(allowed);
    const entry = { ts: '2026-06-01T00:00:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Read' } as const;
    const external = join(dir, 'other.txt');
    writeFileSync(external, 'outside');
    await expect(client.call('workspace.fileWrite', { projectId, relPath: '.METAIDE', content: 'cannot block logging' }))
      .rejects.toMatchObject({ code: 'protected_path' });
    appendActivity(projectRoot, { ...entry, id: 'in', target: join(projectRoot, 'a.txt') });
    appendActivity(projectRoot, { ...entry, id: 'out', target: external });
    appendActivity(projectRoot, { ...entry, id: 'gone', target: 'missing.txt' });
    settings.set('activity_log_enabled', false);
    await expect(client.call('workspace.info', { projectId })).resolves.toEqual({ activityEnabled: false });
    await expect(client.call('workspace.activity', { projectId })).rejects.toMatchObject({ code: 'activity_disabled' });
    await expect(client.call('workspace.fileRead', { projectId, relPath: '.metaide/activity.jsonl' }))
      .rejects.toMatchObject({ code: 'protected_path' });
    await expect(client.call('workspace.fileRename', { projectId, from: '.metaide', to: 'archive' }))
      .rejects.toMatchObject({ code: 'protected_path' });
    settings.set('activity_log_enabled', true);
    await expect(client.call('workspace.info', { projectId })).resolves.toEqual({ activityEnabled: true });
    await expect(client.call('workspace.activity', { projectId })).resolves.toEqual({ entries: [
      { ...entry, id: 'in', target: 'a.txt' }, { ...entry, id: 'out' }, { ...entry, id: 'gone' },
    ] });
    appendActivity(projectRoot, { ...entry, id: 'next', target: 'a.txt' });
    const reloaded = await client.call('workspace.activity', { projectId });
    expect(reloaded.entries.at(-1)).toEqual({ ...entry, id: 'next', target: 'a.txt' });
  });

  test('reports an empty timeline, skips invalid entries, and rejects an oversized partial timeline', async () => {
    const path = activityPath(projectRoot);
    const { client } = setup(allowed);
    await expect(client.call('workspace.activity', { projectId })).resolves.toEqual({ entries: [] });
    mkdirSync(join(projectRoot, '.metaide'), { recursive: true });
    writeFileSync(path, 'not JSON\n{"kind":"tool"}\n');
    const entry = { id: 'plain', ts: '2026-06-01T00:00:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Other' } as const;
    appendActivity(projectRoot, entry);
    await expect(client.call('workspace.activity', { projectId })).resolves.toEqual({ entries: [entry] });
    writeFileSync(path, ' '.repeat(MAX_RPC_FRAME_BYTES + 1));
    await expect(client.call('workspace.activity', { projectId })).rejects.toMatchObject({ code: 'result_too_large' });
  });

  test('reports no Diff repository and refuses reads of specific sides', async () => {
    const run = vi.spyOn(git, 'runGit');
    const { client } = setup(allowed);
    await expect(client.call('workspace.diffStatus', { projectId })).resolves.toEqual({
      isRepo: false, branch: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [],
    });
    await expect(client.call('workspace.diffSides', { projectId, kind: 'untracked', path: 'a.txt' }))
      .rejects.toMatchObject({ code: 'git_unavailable' });
    expect(run).not.toHaveBeenCalled();
  });

  test('returns bounded Diff errors for failed commands and an oversized status without exposing stderr', async () => {
    mkdirSync(join(projectRoot, '.git'));
    const repo = realpathSync(projectRoot);
    const { client } = setup(allowed);
    const result = (stdout: string, overrides: Partial<git.GitRunResult> = {}): git.GitRunResult => ({
      stdout: Buffer.from(stdout), stderr: 'private Git diagnostic', status: 0, timedOut: false, tooLarge: false,
      ...overrides,
    });
    const run = vi.spyOn(git, 'runGit');
    const status = () => client.call('workspace.diffStatus', { projectId });
    run.mockResolvedValueOnce(result('', { status: 128 }));
    await expect(status()).rejects.toMatchObject({ code: 'git_unavailable', message: 'project repository could not be verified' });
    run.mockResolvedValueOnce(result(`${repo}\n`)).mockResolvedValueOnce(result('', { status: 2 }));
    await expect(status()).rejects.toMatchObject({ code: 'git_unavailable', message: 'project Git config could not be verified' });
    run.mockResolvedValueOnce(result(`${repo}\n`)).mockResolvedValueOnce(result('', { status: 1 }))
      .mockResolvedValueOnce(result('', { timedOut: true }));
    await expect(status()).rejects.toMatchObject({ code: 'git_unavailable', message: 'project Git status could not be read' });
    run.mockResolvedValueOnce(result(`${repo}\n`)).mockResolvedValueOnce(result('', { status: 1 }))
      .mockResolvedValueOnce(result('', { tooLarge: true }));
    await expect(status()).rejects.toMatchObject({ code: 'result_too_large' });
    expect(run).toHaveBeenCalledTimes(9);
    expect(readFileSync(auditPath, 'utf8')).not.toContain('private Git diagnostic');
  });

  test('Diff status and sides use fresh host state; safe Git arguments never take guessed paths', async () => {
    mkdirSync(join(projectRoot, '.git'));
    const canonical = realpathSync(projectRoot);
    const success = (stdout: string): git.GitRunResult => ({
      stdout: Buffer.from(stdout), stderr: '', status: 0, timedOut: false, tooLarge: false,
    });
    let changed = 'R  a.txt\0old.txt\0 M changed.txt\0?? untracked.txt\0';
    const run = vi.spyOn(git, 'runGit').mockImplementation(async (_root, args) => {
      if (args[0] === 'rev-parse') return success(`${canonical}\n`);
      if (args[0] === 'config') return success('filter.custom.clean\0filter.custom.required\0');
      if (args.includes('status')) return success(`## main\0${changed}`);
      if (args.includes('diff')) return success('a diff');
      if (args.includes('HEAD:old.txt')) return success('before');
      if (args.includes(':0:a.txt')) return success('after');
      throw new Error('unexpected git step');
    });
    const { client } = setup(allowed);
    await expect(client.call('workspace.diffStatus', { projectId })).resolves.toEqual({
      isRepo: true, branch: 'main', ahead: 0, behind: 0,
      staged: [{ path: 'a.txt', status: 'R', origPath: 'old.txt' }],
      unstaged: [{ path: 'changed.txt', status: 'M' }],
      untracked: ['untracked.txt'],
    });
    await expect(client.call('workspace.diffSides', { projectId, kind: 'staged', path: 'a.txt', origPath: 'guessed.txt' }))
      .rejects.toMatchObject({ code: 'unknown_change' });
    await expect(client.call('workspace.diffSides', { projectId, kind: 'unstaged', path: 'a.txt' }))
      .rejects.toMatchObject({ code: 'unknown_change' });
    expect(run.mock.calls.some(([, args]) => args.includes('diff'))).toBe(false);
    const req = { projectId, kind: 'staged', path: 'a.txt', origPath: 'old.txt' } as const;
    const result = await client.call('workspace.diffSides', req);
    expect(result).toMatchObject({ status: 'ok', diff: 'a diff', oldSide: { text: 'before' }, newSide: { text: 'after' } });
    expect(run.mock.calls).toContainEqual([
      canonical, expect.arrayContaining(['filter.custom.clean=', 'filter.custom.required=false', '--no-textconv', '--no-ext-diff']),
      expect.anything(),
    ]);
    if (result.status !== 'ok') throw new Error('expected diff content');
    await expect(client.call('workspace.diffSides', { ...req, ifDiffHashNot: result.diffHash }))
      .resolves.toEqual({ status: 'unchanged' });
    changed = '';
    await expect(client.call('workspace.diffSides', req)).rejects.toMatchObject({ code: 'unknown_change' });
  });

  test.skipIf(process.platform === 'win32')('rejects a listed Git change through an external symlink before reading its sides', async () => {
    mkdirSync(join(projectRoot, '.git'));
    symlinkSync(dir, join(projectRoot, 'escape'));
    const run = vi.spyOn(git, 'runGit').mockImplementation(async (_root, [command]) => ({
      stdout: Buffer.from(command === 'rev-parse' ? `${realpathSync(projectRoot)}\n` : command === 'status' ? '## main\0 M escape/a.txt\0' : ''),
      status: 0, timedOut: false, tooLarge: false, stderr: '',
    }));
    const { client } = setup(allowed);
    await expect(client.call('workspace.diffSides', { projectId, kind: 'unstaged', path: 'escape/a.txt' }))
      .rejects.toMatchObject({ code: 'path_outside_project' });
    expect(run.mock.calls.map(([, args]) => args[0])).toEqual(['rev-parse', 'config', 'status']);
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
