import { beforeEach, describe, expect, it, vi } from 'vitest';

const discoverProjects = vi.fn();
const pruneMissingProjects = vi.fn();

vi.mock('@main/domain/discovery', () => ({ discoverProjects: (...args: unknown[]) => discoverProjects(...args) }));
vi.mock('@main/domain/prune-missing', () => ({ pruneMissingProjects: (...args: unknown[]) => pruneMissingProjects(...args) }));

const { rescanRootsAtBoot } = await import('@main/startup/boot-rescan');
type RescanServices = Parameters<typeof rescanRootsAtBoot>[0];

function makeServices(roots: Array<{ id: number; path: string }>) {
  const calls: string[] = [];
  let nextId = 100;
  const services = {
    settings: { get: vi.fn((key: string) => { calls.push(`settings.get:${key}`); return 3; }) },
    roots: { list: vi.fn(() => roots) },
    projects: {
      upsert: vi.fn((rootId: number, path: string) => { calls.push(`upsert:${rootId}:${path}`); return { id: nextId++ }; }),
      updateConfig: vi.fn((id: number, cfg: unknown) => { calls.push(`updateConfig:${id}:${JSON.stringify(cfg)}`); }),
    },
    watcher: { watch: vi.fn((path: string) => { calls.push(`watch:${path}`); }) },
  };
  return { services, calls };
}

describe('rescanRootsAtBoot', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  beforeEach(() => {
    discoverProjects.mockReset();
    pruneMissingProjects.mockReset();
    warn.mockClear();
  });

  it('upserts, links, prunes then watches each root in order using the stored scan depth', async () => {
    const roots = [{ id: 1, path: '/r1' }, { id: 2, path: '/r2' }];
    const { services, calls } = makeServices(roots);
    discoverProjects.mockImplementation((path: string) => path === '/r1'
      ? [{ path: '/r1/a', name: 'a', metaprojectProjectId: 'MP-1' }, { path: '/r1/b', name: 'b', metaprojectProjectId: null }]
      : []);
    pruneMissingProjects.mockImplementation((_deps: unknown, root: { path: string }) => { calls.push(`prune:${root.path}`); return 0; });

    await rescanRootsAtBoot(services as unknown as RescanServices);

    expect(discoverProjects.mock.calls).toEqual([['/r1', 3], ['/r2', 3]]);
    expect(calls).toEqual([
      'settings.get:scan_depth',
      'upsert:1:/r1/a',
      'updateConfig:100:{"linkedMetaprojectProjectId":"MP-1"}',
      'upsert:1:/r1/b',
      'prune:/r1',
      'watch:/r1',
      'prune:/r2',
      'watch:/r2',
    ]);
    expect(services.projects.upsert).toHaveBeenCalledWith(1, '/r1/a', 'a');
  });

  it('prunes with no live shells at boot', async () => {
    const root = { id: 1, path: '/r1' };
    const { services } = makeServices([root]);
    discoverProjects.mockReturnValue([]);
    await rescanRootsAtBoot(services as unknown as RescanServices);
    const [deps, prunedRoot] = pruneMissingProjects.mock.calls[0]!;
    expect(prunedRoot).toBe(root);
    expect(deps.projects).toBe(services.projects);
    expect(deps.hasLiveShell(7)).toBe(false);
  });

  it('logs and swallows a failure, abandoning the remaining roots', async () => {
    const { services } = makeServices([{ id: 1, path: '/r1' }, { id: 2, path: '/r2' }]);
    const failure = new Error('disk gone');
    discoverProjects.mockImplementation(() => { throw failure; });
    await expect(rescanRootsAtBoot(services as unknown as RescanServices)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[metaide] boot rescan failed', failure);
    expect(discoverProjects).toHaveBeenCalledTimes(1);
    expect(services.watcher.watch).not.toHaveBeenCalled();
  });
});
