import { expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssignmentService, classifyAssignment } from '@main/metaproject/assignment-service';
import { AssignmentOperations } from '@main/metaproject/assignment-operations';
import { MetaprojectClient } from '@main/metaproject/client';
import type { SessionTransport } from '@main/metaproject/session-service';
import { WebFailure } from '@main/metaproject/web-session';
import type { SettingsRepo } from '@main/repos/settings-repo';
import type { Project } from '@shared/types';
import { metaprojectRequests, parseMetaprojectOrigin, remoteProjectId } from '@shared/metaproject-contract';

const operationId = 'f075563b-d4ff-42f4-88f2-5feec34487e9';
const unlinked = '# retained\n';

function fixture(dir: string) {
  const origin = parseMetaprojectOrigin('https://example.test', false);
  if (!origin) throw new Error('invalid fixture origin');
  const path = join(dir, '.metaproject.yaml');
  writeFileSync(path, unlinked);
  const project: Project = { id: 1, rootId: 2, path: dir, name: 'local', metaprojectProjectId: null, linkedChatChannelId: null, lastOpenedAt: null, firstLaunchedAt: null, hidden: false, pinned: false, config: {} };
  const remote = { id: remoteProjectId.parse(3), name: 'remote' };
  const client = new MetaprojectClient({ origin, userId: 4, signal: new AbortController().signal, request: vi.fn(), jar: { cookies: { get: vi.fn() }, getUserAgent: vi.fn() }, changed: vi.fn(), rejected: vi.fn(), forward: vi.fn() });
  vi.spyOn(client, 'listProjects').mockResolvedValue([remote]);
  vi.spyOn(client, 'checkProject').mockResolvedValue(undefined);
  vi.spyOn(client, 'createProject').mockResolvedValue(remote);
  const transport: SessionTransport = { authenticate: vi.fn(), client: () => client, retire: vi.fn() };
  const live = { client, origin, transport, controller: new AbortController(), epoch: 9 };
  const changed = vi.fn();
  const get = vi.fn<(id: number) => Project | null>(() => project);
  const listByRoot = vi.fn(() => [project]);
  const clearLegacyMetaprojectLink = vi.fn();
  const settings = {
    readMetaprojectPrivate: vi.fn<SettingsRepo['readMetaprojectPrivate']>(),
    writeMetaprojectPrivate: vi.fn<SettingsRepo['writeMetaprojectPrivate']>(),
  };
  const lease = vi.fn<() => typeof live | null>(() => live);
  const service = new AssignmentService({
    projects: { get, listByRoot, clearLegacyMetaprojectLink },
    roots: { list: () => [{ id: 2, path: dir, addedAt: '', sortOrder: 0 }] },
    settings,
    session: { snapshot: () => ({ epoch: 9, phase: 'signed-out', configuredOrigin: origin, origin }), client: lease }, allowLoopback: false, changed,
  });
  const assignment = service.get(1);
  if (!assignment.ok || assignment.value.kind !== 'unlinked') throw new Error('invalid assignment fixture');
  return { service, path, get, client, changed, target: { operationId, projectId: 1, epoch: 9, revision: assignment.value.revision }, remote,
    project, settings, lease, origin, clearLegacyMetaprojectLink,
  };
}

it('never treats an equal numeric ID at another origin as the same assignment', () => {
  const oldOrigin = parseMetaprojectOrigin('https://old.test', false);
  const current = parseMetaprojectOrigin('https://new.test', false);
  if (!oldOrigin || !current) throw new Error('invalid fixture');
  const id = remoteProjectId.parse(8);
  expect(classifyAssignment(id, oldOrigin, current)).toEqual({ kind: 'origin-mismatch', remoteId: 8, origin: oldOrigin });
  expect(classifyAssignment(id, null, current)).toEqual({ kind: 'unconfirmed', remoteId: 8 });
});

it('preserves old bytes when the same frame abandons Settings while remote access is pending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'assignment-service-'));
  try {
    const { service, client, path, changed, target, remote } = fixture(dir);
    let allow = (): void => { throw new Error('not started'); };
    vi.mocked(client.checkProject).mockImplementation(() => new Promise(resolve => { allow = resolve; }));
    const input = metaprojectRequests['metaproject:assignment-save'].parse({ ...target, remoteId: remote.id });
    const operations = new AssignmentOperations();
    const frame = {};
    const pending = operations.run(input, { frame, contextCurrent: () => true }, owns => service.save(input, owns));
    await Promise.resolve();
    expect(client.checkProject).toHaveBeenCalledWith(remote.id);
    expect(operations.cancel(input, frame)).toEqual({ ok: true, value: undefined });
    allow();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'stale' });
    expect(readFileSync(path, 'utf8')).toBe(unlinked);
    expect(changed).not.toHaveBeenCalled();
  } finally { rmSync(dir, { force: true, recursive: true }); }
});

it('retains a successful remote create when cancellation prevents the local link', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'assignment-service-'));
  try {
    const { service, client, path, target, remote } = fixture(dir);
    let finish = (): void => { throw new Error('not started'); };
    vi.mocked(client.createProject).mockImplementation(() => new Promise(resolve => { finish = () => resolve(remote); }));
    const input = metaprojectRequests['metaproject:assignment-create'].parse({ ...target, name: remote.name });
    const owns = vi.fn(() => true);
    const pending = service.create(input, owns);
    expect(client.createProject).toHaveBeenCalledOnce();
    owns.mockReturnValue(false);
    finish();
    await expect(pending).resolves.toEqual({ ok: true, value: { kind: 'created-not-assigned', project: remote, reason: 'stale' } });
    expect(client.listProjects).not.toHaveBeenCalled();
    expect(readFileSync(path, 'utf8')).toBe(unlinked);
  } finally { rmSync(dir, { force: true, recursive: true }); }
});

it('reports committed-reload when authority is lost after the rename; does not roll back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'assignment-service-'));
  try {
    const { service, path, get, changed, target, remote } = fixture(dir);
    changed.mockImplementation(() => { get.mockReturnValue(null); });
    const input = metaprojectRequests['metaproject:assignment-save'].parse({ ...target, remoteId: remote.id });
    await expect(service.save(input, () => true)).resolves.toEqual({ ok: true, value: { kind: 'committed-reload', projectId: 1 } });
    expect(readFileSync(path, 'utf8')).toBe(`${unlinked}project_id: 3\nmetaproject_origin: https://example.test\n`);
    expect(changed).toHaveBeenCalledWith(1);
  } finally { rmSync(dir, { force: true, recursive: true }); }
});

it('freezes provenance at the recorded origin for exact bytes and never restores a removed link', () => {
  const dir = mkdtempSync(join(tmpdir(), 'assignment-service-'));
  try {
    const { service, path, settings, origin, remote, project, get } = fixture(dir);
    writeFileSync(path, '# retained\nproject_id: PROJ-3\n');
    service.captureLegacy();
    const saved = settings.writeMetaprojectPrivate.mock.lastCall?.[0];
    expect(saved).toMatchObject({ metaproject_legacy_assignments_v1: { origin, entries: { 1: { kind: 'yaml', remoteId: 3, revision: expect.stringMatching(/^[0-9a-f]{64}$/) } } } });
    if (!saved) throw new Error('migration did not write evidence');
    settings.readMetaprojectPrivate.mockReturnValue(saved.metaproject_legacy_assignments_v1);
    service.captureLegacy();
    expect(settings.writeMetaprojectPrivate).toHaveBeenCalledOnce();
    expect(service.get(1)).toMatchObject({ ok: true, value: { kind: 'linked', origin, remoteId: remote.id } });
    writeFileSync(path, '# edited\nproject_id: PROJ-3\n');
    expect(service.get(1)).toMatchObject({ ok: true, value: { kind: 'unconfirmed', remoteId: remote.id } });
    get.mockReturnValue({ ...project, metaprojectProjectId: 'PROJ-3' });
    writeFileSync(path, unlinked);
    expect(service.get(1)).toMatchObject({ ok: true, value: { kind: 'unlinked' } });
  } finally { rmSync(dir, { force: true, recursive: true }); }
});

it('removes a current local assignment while offline but rejects invalid origin bytes without rewriting them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'assignment-service-'));
  try {
    const { service, path, changed, client, target, origin, clearLegacyMetaprojectLink } = fixture(dir);
    const invalid = `${unlinked}project_id: 3\nmetaproject_origin: not-an-origin\n`;
    writeFileSync(path, invalid);
    expect(service.get(1)).toMatchObject({ ok: true, value: { kind: 'invalid' } });
    expect(service.remove(target, () => true)).toEqual({ ok: false, reason: 'conflict' });
    expect(readFileSync(path, 'utf8')).toBe(invalid);
    writeFileSync(path, `${unlinked}project_id: 3\nmetaproject_origin: ${origin}\n`);
    const current = service.get(1);
    if (!current.ok || current.value.kind !== 'linked') throw new Error('fixture did not load');
    expect(service.remove({ ...target, revision: current.value.revision }, () => true))
      .toMatchObject({ ok: true, value: { kind: 'assigned', assignment: { kind: 'unlinked' } } });
    expect(readFileSync(path, 'utf8')).toBe(unlinked);
    expect(clearLegacyMetaprojectLink).toHaveBeenCalledWith(1);
    expect(changed).toHaveBeenCalledOnce();
    expect(client.listProjects).not.toHaveBeenCalled();
  } finally { rmSync(dir, { force: true, recursive: true }); }
});

it('keeps protected list failures distinct from empty and fences a stale success across a lease change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'assignment-service-'));
  try {
    const { service, client, lease } = fixture(dir);
    await expect(service.list(8)).resolves.toEqual({ ok: false, reason: 'stale' });
    expect(client.listProjects).not.toHaveBeenCalled();
    vi.mocked(client.listProjects).mockRejectedValueOnce(new WebFailure('network')).mockResolvedValueOnce([]);
    await expect(service.list(9)).resolves.toEqual({ ok: false, reason: 'network' });
    await expect(service.list(9)).resolves.toEqual({ ok: true, value: { epoch: 9, projects: [] } });
    const pending = service.list(9);
    lease.mockReturnValue(null);
    await expect(pending).resolves.toEqual({ ok: false, reason: 'stale' });
    await expect(service.list(9)).resolves.toEqual({ ok: false, reason: 'signed-out' });
    expect(client.listProjects).toHaveBeenCalledTimes(3);
  } finally { rmSync(dir, { force: true, recursive: true }); }
});
