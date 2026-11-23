import { join, resolve, sep } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { workspaceRootFor, type WorkspaceRootPolicy } from '../workspace-root-policy';

const base = resolve(sep, 'synthetic');
const path = (name: string) => join(base, name);
const project = { id: 1, path: path('project') };
type Entry = ReturnType<WorkspaceRootPolicy['fs']['entry']>;
const symlink = (target: string): Entry => ({ kind: 'symlink', target });
const missing: Entry = { kind: 'missing' };

function fixture(overrides: Partial<WorkspaceRootPolicy> = {}, entries: ReadonlyMap<string, Entry> = new Map()): WorkspaceRootPolicy {
  return {
    fs: {
      cwd: () => base,
      directory: (name) => name,
      entry: (name) => entries.get(name) ?? { kind: 'ordinary', canonical: name },
    },
    protectedPaths: () => [path('host/state')],
    registeredRoots: () => [project],
    ...overrides,
  };
}

describe('remote workspace root policy', () => {
  test('allows an independent root and does not match sibling name prefixes', () => {
    const policy = fixture({
      protectedPaths: () => [path('project-adjacent/state')],
      registeredRoots: () => [project, { id: 2, path: path('project-other') }],
    });
    expect(workspaceRootFor(project, policy)).toBe(project.path);
  });

  test.each(['project', 'project/state', 'PROJECT/.metaide'])('refuses a root containing protected location %s', (name) => {
    const policy = fixture({ protectedPaths: () => [path(name)] });
    expect(workspaceRootFor(project, policy)).toBeUndefined();
  });

  test('refuses a project inside host state but allows a child of another registered project', () => {
    expect(workspaceRootFor({ id: 2, path: path('host/state/child') }, fixture())).toBeUndefined();
    expect(workspaceRootFor({ id: 2, path: path('project/child') }, fixture())).toBe(path('project/child'));
  });

  test('rejects missing and symlinked nested roots, including aliases to the same directory', () => {
    const child = path('project/not-mounted');
    const alias = path('project-alias');
    const cases = [
      { path: child, entry: missing },
      { path: alias, entry: symlink(project.path) },
      { path: alias, entry: symlink(child) },
    ];
    for (const other of cases) {
      const policy = fixture(
        { registeredRoots: () => [project, { id: 2, path: other.path }] },
        new Map([[other.path, other.entry]]),
      );
      expect(workspaceRootFor(project, policy)).toBeUndefined();
    }
  });

  test('checks the selected root as registered and as resolved', () => {
    const policy = fixture();
    const root = path('host/state/canonical');
    const fs = { ...policy.fs, directory: () => root };
    expect(workspaceRootFor(project, fixture({ fs }))).toBeUndefined();
    const independent = path('independent');
    const lexicalAlias = { id: 1, path: path('host/state/lexical-alias') };
    expect(workspaceRootFor(lexicalAlias, fixture({ fs: { ...fs, directory: () => independent } }))).toBeUndefined();
    expect(workspaceRootFor(project, fixture({ fs: { ...fs, directory: () => independent } }))).toBe(independent);
  });

  test('resolves missing storage under aliased directories and dangling file targets', () => {
    const inProject = path('project/future');
    const entries = new Map([
      [path('host/alias'), symlink(join('..', 'project'))],
      [path('host/dangling'), symlink(inProject)],
      [inProject, missing],
    ]);
    for (const name of ['host/alias/future', 'host/dangling']) {
      expect(workspaceRootFor(project, fixture({ protectedPaths: () => [path(name)] }, entries))).toBeUndefined();
    }
  });

  test('protects an intermediate link entry even if the final location is outside the project', () => {
    const hostFile = path('host/state');
    const link = path('project/bridge');
    const entries = new Map([
      [hostFile, symlink(link)],
      [link, symlink(path('outside/file'))],
    ]);
    expect(workspaceRootFor(project, fixture({}, entries))).toBeUndefined();
  });

  test('does not mistake a shared ancestor alias for host storage', () => {
    const alias = path('alias');
    const selected = { id: 1, path: join(alias, 'project') };
    const canonical = path('underlying/project');
    const policy = fixture({
      protectedPaths: () => [join(alias, 'service/state')],
      registeredRoots: () => [selected],
    }, new Map([[alias, symlink(path('underlying'))]]));
    expect(workspaceRootFor(selected, { ...policy, fs: { ...policy.fs, directory: () => canonical } })).toBe(canonical);
  });

  test('keeps dot segments on link targets until their parent resolves', () => {
    const entries = new Map([
      [path('host/state'), symlink(`redirect${sep}..${sep}state`)],
      [path('host/redirect'), symlink(path('project/sub'))],
    ]);
    expect(workspaceRootFor(project, fixture({}, entries))).toBeUndefined();
  });

  test('resolves a relative configured location against the host working directory', () => {
    const policy = fixture({ protectedPaths: () => [join('project', 'storage')] });
    expect(workspaceRootFor(project, policy)).toBeUndefined();
  });

  test('fails closed on loops, invalid storage paths, and unavailable root information', () => {
    const policy = fixture();
    const unavailable = () => { throw new Error('private cause'); };
    const policies = [
      fixture({}, new Map([[path('host/state'), symlink(path('host/state'))]])),
      fixture({ protectedPaths: () => [''] }),
      fixture({ protectedPaths: () => ['host\0state'] }),
      fixture({ fs: { ...policy.fs, entry: unavailable } }),
      fixture({ fs: { ...policy.fs, directory: unavailable } }),
      fixture({ registeredRoots: unavailable }),
      fixture({ protectedPaths: unavailable }),
    ];
    for (const candidate of policies) expect(workspaceRootFor(project, candidate)).toBeUndefined();
  });

  test('queries fresh storage and registration on every call', () => {
    const protectedPaths = vi.fn((): readonly string[] => [path('host/state')]);
    const registeredRoots = vi.fn((): readonly { id: number; path: string }[] => [project]);
    const policy = fixture({ protectedPaths, registeredRoots });
    expect(workspaceRootFor(project, policy)).toBe(project.path);
    registeredRoots.mockReturnValueOnce([project, { id: 2, path: path('project/newly-registered') }]);
    expect(workspaceRootFor(project, policy)).toBeUndefined();
    protectedPaths.mockReturnValueOnce([path('project/new-host-location')]);
    expect(workspaceRootFor(project, policy)).toBeUndefined();
    expect(protectedPaths).toHaveBeenCalledTimes(3);
    expect(registeredRoots).toHaveBeenCalledTimes(2);
  });
});
