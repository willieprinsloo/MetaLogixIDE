import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { isInsideRoot } from '../domain/path-containment';

interface RegisteredRoot {
  readonly id: number;
  readonly path: string;
}

type PathEntry =
  | { readonly kind: 'symlink'; readonly target: string }
  | { readonly kind: 'ordinary'; readonly canonical: string }
  | { readonly kind: 'missing' };

interface RootFilesystem {
  cwd(): string;
  directory(path: string): string;
  entry(path: string): PathEntry;
}

export interface WorkspaceRootPolicy {
  readonly fs: RootFilesystem;
  protectedPaths(): readonly string[];
  registeredRoots(): readonly RegisteredRoot[];
}

export const nodeWorkspaceRootFs: RootFilesystem = {
  cwd: process.cwd,
  directory(path) {
    const canonical = realpathSync.native(path);
    if (!lstatSync(canonical).isDirectory()) throw new Error('not a directory');
    return canonical;
  },
  entry(path) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat === undefined) return { kind: 'missing' };
    if (stat.isSymbolicLink()) return { kind: 'symlink', target: readlinkSync(path) };
    return { kind: 'ordinary', canonical: realpathSync.native(path) };
  },
};

function components(path: string): string[] {
  return path.split(sep === '\\' ? /[/\\]/ : '/');
}

interface PathAliases {
  readonly locations: readonly string[];
  readonly dependencies: readonly string[];
}

function absolutePath(path: string, cwd: string): string {
  if (!path || path.includes('\0')) throw new Error('invalid storage path');
  // Preserve dot segments after links; normalizing them first changes what the OS opens.
  return isAbsolute(path) ? path : `${cwd}${sep}${path}`;
}

function pathAliases(absolute: string, entryAt: RootFilesystem['entry']): PathAliases {
  let parent = parse(absolute).root;
  const pending = components(absolute.slice(parent.length));
  const dependencies: string[] = [];
  let followed = 0;
  while (pending.length > 0) {
    const name = pending.shift();
    if (!name || name === '.') continue;
    if (name === '..') {
      dependencies.push(parent);
      parent = dirname(parent);
      continue;
    }
    const entry = join(parent, name);
    const info = entryAt(entry);
    if (info.kind !== 'symlink') {
      parent = info.kind === 'missing' ? entry : info.canonical;
      continue;
    }
    dependencies.push(entry);
    if (++followed > 40) throw new Error('storage path has too many links');
    const root = parse(info.target).root;
    if (root) parent = root;
    pending.unshift(...components(info.target.slice(root.length)));
  }
  return { locations: [resolve(absolute), parent], dependencies };
}

function contains(root: string, path: string): boolean {
  // Conservatively treat case and Unicode aliases alike even on case-sensitive volumes.
  return isInsideRoot(root.normalize('NFC').toLowerCase(), path.normalize('NFC').toLowerCase());
}

function overlaps(root: string, candidate: PathAliases): boolean {
  return candidate.locations.some((path) => contains(root, path) || contains(path, root)) ||
    candidate.dependencies.some((path) => contains(root, path));
}

function containsRegisteredRoot(root: string, candidate: PathAliases): boolean {
  return [...candidate.locations, ...candidate.dependencies].some((path) => contains(root, path));
}

/** Returns the verified root for this call. An ambiguous/unreadable boundary never grants access. */
export function workspaceRootFor(project: RegisteredRoot, policy: WorkspaceRootPolicy): string | undefined {
  try {
    const cwd = policy.fs.cwd();
    const absolute = absolutePath(project.path, cwd);
    const canonical = policy.fs.directory(absolute);
    const roots = [resolve(absolute), canonical];
    const entries = new Map<string, PathEntry>();
    function aliases(path: string): PathAliases {
      return pathAliases(absolutePath(path, cwd), (entry) => {
        const info = entries.get(entry) ?? policy.fs.entry(entry);
        entries.set(entry, info);
        return info;
      });
    }

    for (const path of policy.protectedPaths()) {
      const candidate = aliases(path);
      if (roots.some((root) => overlaps(root, candidate))) return undefined;
    }
    for (const other of policy.registeredRoots()) {
      if (other.id === project.id) continue;
      const candidate = aliases(other.path);
      if (roots.some((root) => containsRegisteredRoot(root, candidate))) return undefined;
    }
    return canonical;
  } catch {
    return undefined;
  }
}
