import {
  closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, opendirSync,
  readlinkSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { Params, Result } from '../../shared/p2p-contract';
import { WorkspaceMethods } from '../../shared/p2p-workspace-contract';
import { TERMINAL_AGENT_NAME } from '../../shared/project-default-agent';
import { parseGitPanelStatus } from '../../shared/parse-git-panel-status';
import type { Project } from '../../shared/types';
import { activityPath } from '../activity/log';
import { readMetaIdeCliProfiles } from '../domain/metaide-conf';
import { isInsideRoot } from '../domain/path-containment';
import { setProjectDefaultAgent } from '../domain/project-default-agent';
import { defaultDiffSidesDeps, nodeWorktreeFs, readDiffSides } from '../git/diff-sides';
import { runGit, type GitRunner } from '../git/run-git';
import type { Services } from '../services';
import { MAX_RPC_FRAME_BYTES, RpcError, type RpcPeer } from './rpc';
import { workspaceRootFor, type WorkspaceRootPolicy } from './workspace-root-policy';

const FILE_MAX_BYTES = 512 * 1024;
const RESULT_MAX_BYTES = MAX_RPC_FRAME_BYTES - 256; // Allow room for the envelope and request ID.
const ACTIVITY_LIMIT = 200;
const MAX_MOVE_SCAN_ENTRIES = 50_000;
const FILE_TOOLS = new Set(['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit']);
const PROFILE_FILE = '.metaide/cli-profiles.json';
const LAUNCH_FILES = [PROFILE_FILE, '.metaide/env'];

type WorkspaceMethod = keyof typeof WorkspaceMethods;
type WorkspaceServices = Pick<Services, 'projects' | 'settings'>;

interface WorkspacePath {
  /** A canonical parent plus the last path component, without dereferencing the last symlink. */
  readonly entry: string;
  readonly canonical: string;
  readonly exists: boolean;
}

function errno(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}

function outsideProject(): RpcError {
  return new RpcError('path_outside_project', 'path is outside the project or cannot be safely resolved');
}

function oversizedResult(): RpcError {
  return new RpcError('result_too_large', 'workspace response exceeds the RPC size limit');
}

function fitsResponse(value: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(value)) <= RESULT_MAX_BYTES;
}

function checkedPath(root: string, requested: string): WorkspacePath {
  if (requested.includes('\0') || parse(requested).root) throw outsideProject();
  const abs = resolve(root, requested);
  if (!isInsideRoot(root, abs)) throw outsideProject();
  const rel = relative(root, abs);
  if (!rel) return { entry: root, canonical: root, exists: true };
  const parts = rel.split(sep);
  // A Windows stream or device name is not an ordinary filesystem entry.
  if (sep === '\\' && parts.some((name) =>
    /[<>:"|?*]|[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name),
  )) throw outsideProject();
  let parent = root;
  for (const [index, name] of parts.entries()) {
    const entry = join(parent, name);
    try {
      lstatSync(entry);
    } catch (error) {
      if (errno(error) !== 'ENOENT') throw error;
      const missing = join(entry, ...parts.slice(index + 1));
      return { entry: missing, canonical: missing, exists: false };
    }
    // A dangling symlink is not a nonexistent destination: fail closed on its target.
    let canonical: string;
    try {
      canonical = realpathSync.native(entry);
    } catch (error) {
      if (errno(error) === 'ENOENT' || errno(error) === 'ELOOP') throw outsideProject();
      throw error;
    }
    if (!isInsideRoot(root, canonical)) throw outsideProject();
    if (index === parts.length - 1) return { entry, canonical, exists: true };
    parent = canonical;
  }
  throw outsideProject();
}

function mutationPath(root: string, path: string): WorkspacePath {
  const target = checkedPath(root, path);
  if (target.canonical === root) throw new RpcError('project_root', 'cannot modify the project root');
  return target;
}

function wirePath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

/** Canonical aliases count; case-fold the reserved names even on case-sensitive volumes. */
function protectedTargets(root: string, path: string): string[] {
  const direct = resolve(root, path);
  try {
    const { canonical } = checkedPath(root, path);
    return [direct, canonical];
  } catch {
    // An external or unresolvable marker has no safe in-project alias here.
    return [direct];
  }
}

function touchesProtected(
  root: string, candidates: readonly string[], targets: readonly string[], moving: boolean, includeDescendants = true,
): boolean {
  return candidates.some((candidate) => {
    const path = wirePath(root, candidate).toLowerCase();
    return targets.some((target) => {
      const protectedPath = wirePath(root, target).toLowerCase();
      return path === protectedPath ||
        (includeDescendants && path.startsWith(`${protectedPath}/`)) ||
        (moving && protectedPath.startsWith(`${path}/`));
    });
  });
}

function gitMetadata(root: string): string[] {
  const targets = protectedTargets(root, '.git');
  const marker = targets.at(-1);
  if (!marker || !isInsideRoot(root, marker)) return targets;
  // A linked worktree's marker is a small Git file rather than a directory.
  try {
    if (!lstatSync(marker).isFile()) return targets;
    const fd = openSync(marker, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) return targets;
      const line = readBytes(fd, 4096, 0).toString('utf8').split(/\r?\n/, 1)[0];
      if (!line?.startsWith('gitdir: ')) return targets;
      const gitDir = resolve(root, line.slice('gitdir: '.length));
      if (gitDir !== root && isInsideRoot(root, gitDir)) targets.push(...protectedTargets(root, relative(root, gitDir)));
    } finally {
      closeSync(fd);
    }
  } catch {
    // An absent/unreadable marker exposes no additional known path.
  }
  return targets;
}

/**
 * Track the launch names, symlink chain, and eventual targets even when dangling.
 * Realpath alone loses a missing alias target that Files could otherwise create.
 */
function launchFileTargets(root: string, relPath: string): { entries: string[]; links: string[] } {
  const links: string[] = [];
  const pending = relPath.split('/');
  let parent = root;
  let followed = 0;
  while (pending.length > 0) {
    const name = pending.shift();
    if (!name || name === '.') continue;
    if (name === '..') {
      links.push(parent); // This directory must exist for the link's path to resolve.
      parent = dirname(parent);
      continue;
    }
    const entry = join(parent, name);
    const link = tryReadlink(entry);
    if (link === undefined) {
      parent = entry;
      continue;
    }
    links.push(entry);
    if (++followed > 40) throw new RpcError('protected_path', 'project launch configuration could not be verified');
    const { root: linkRoot } = parse(link);
    if (linkRoot) parent = linkRoot;
    pending.unshift(...link.slice(linkRoot.length).split(sep === '\\' ? /[/\\]/ : '/'));
  }
  const inProject = (target: string) => target !== root && isInsideRoot(root, target);
  return { entries: [join(root, relPath), parent].filter(inProject), links: links.filter(inProject) };
}

function tryReadlink(entry: string): string | undefined {
  try {
    return readlinkSync(entry);
  } catch (error) {
    switch (errno(error)) {
      case 'EINVAL': // An ordinary entry.
      case 'ENOENT':
      case 'ENOTDIR':
        return undefined;
      default:
        throw error;
    }
  }
}

function fileAccessPath(root: string, requested: string, operation: 'read' | 'write' | 'mkdir' | 'move' = 'read'): WorkspacePath {
  const path = operation === 'read' ? checkedPath(root, requested) : mutationPath(root, requested);
  const candidates = [resolve(root, requested), path.entry, path.canonical];
  const altersParents = operation === 'move' || operation === 'write';
  if (touchesProtected(root, candidates, protectedTargets(root, relative(root, activityPath(root))), altersParents)) {
    throw new RpcError('protected_path', 'open the project timeline through Activity');
  }
  if (operation !== 'read' && (
    candidates.some((candidate) => wirePath(root, candidate).toLowerCase().split('/').includes('.git')) ||
    touchesProtected(root, candidates, gitMetadata(root), altersParents)
  )) {
    throw new RpcError('protected_path', 'repository metadata cannot be changed through Files');
  }
  if (operation !== 'read' && touchesLaunchConfig(root, candidates, altersParents)) {
    throw new RpcError('protected_path', 'project launch configuration cannot be changed through Files');
  }
  return path;
}

function touchesLaunchConfig(root: string, candidates: readonly string[], altersParents: boolean): boolean {
  return LAUNCH_FILES.some((file) => {
    const { entries, links } = launchFileTargets(root, file);
    return touchesProtected(root, candidates, entries, altersParents) ||
      touchesProtected(root, candidates, links, altersParents, false);
  });
}

function rejectNestedGitMetadata(target: WorkspacePath): void {
  if (!target.exists || !lstatSync(target.entry).isDirectory()) return;
  const pending = [target.entry];
  let count = 0;
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) return;
    const handle = opendirSync(next);
    try {
      for (let dirent = handle.readSync(); dirent; dirent = handle.readSync()) {
        if (++count > MAX_MOVE_SCAN_ENTRIES) {
          throw new RpcError('file_operation_too_large', 'directory is too large to safely modify remotely');
        }
        if (dirent.name.toLowerCase() === '.git') {
          throw new RpcError('protected_path', 'repository metadata cannot be changed through Files');
        }
        if (dirent.isDirectory()) pending.push(join(next, dirent.name));
      }
    } finally {
      handle.closeSync();
    }
  }
}

function regularFile(target: WorkspacePath): Stats {
  return requireRegularFile(statSync(target.canonical));
}

function requireRegularFile(stat: Stats): Stats {
  if (stat.isDirectory()) throw new RpcError('is_directory', 'path is a directory');
  if (!stat.isFile()) throw new RpcError('not_a_file', 'path is not a regular file');
  return stat;
}

function fileTree(root: string, relPath: string): Result<'workspace.fileTree'> {
  const directory = fileAccessPath(root, relPath);
  const base = relative(root, resolve(root, relPath));
  const entries: Result<'workspace.fileTree'>['entries'] = [];
  const protectedLog = protectedTargets(root, relative(root, activityPath(root)));
  const handle = opendirSync(directory.canonical);
  let bytes = 0;
  try {
    for (let dirent = handle.readSync(); dirent; dirent = handle.readSync()) {
      const path = join(base, dirent.name);
      if (touchesProtected(root, [join(directory.canonical, dirent.name)], protectedLog, false)) continue;
      let isDir = dirent.isDirectory();
      if (dirent.isSymbolicLink()) {
        try {
          const target = fileAccessPath(root, path);
          if (target.canonical === root) continue;
          const stat = statSync(target.canonical);
          if (!stat.isFile() && !stat.isDirectory()) continue;
          isDir = stat.isDirectory();
        } catch { continue; } // Broken, raced or out-of-project links are not navigable.
      } else if (!isDir && !dirent.isFile()) {
        continue;
      }
      const entry = { name: dirent.name, isDir, relPath: wirePath(root, resolve(root, path)) };
      if (entry.relPath.length > 4096) throw oversizedResult();
      bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (bytes > RESULT_MAX_BYTES) throw oversizedResult();
      entries.push(entry);
    }
  } finally {
    handle.closeSync();
  }
  entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  return { entries };
}

function fileRead(root: string, relPath: string, forceText?: boolean): Result<'workspace.fileRead'> {
  const target = fileAccessPath(root, relPath);
  regularFile(target);
  const fd = openSync(target.canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new RpcError('not_a_file', 'path is not a regular file');
    if (stat.size > FILE_MAX_BYTES) throw new RpcError('file_too_large', 'file exceeds the workspace preview limit');
    const buffer = readBytes(fd, FILE_MAX_BYTES + 1, 0);
    if (buffer.length > FILE_MAX_BYTES) throw new RpcError('file_too_large', 'file exceeds the workspace preview limit');
    const binary = !forceText && buffer.subarray(0, 8192).includes(0);
    return { content: binary ? '' : buffer.toString('utf8'), kind: binary ? 'binary' : 'text', sizeBytes: buffer.length };
  } finally {
    closeSync(fd);
  }
}

function readBytes(fd: number, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = readSync(fd, buffer, read, length - read, position + read);
    if (count === 0) break;
    read += count;
  }
  return buffer.subarray(0, read);
}

function fileWrite(root: string, { relPath, content, createOnly }: Params<'workspace.fileWrite'>): Result<'workspace.fileWrite'> {
  const target = fileAccessPath(root, relPath, 'write');
  const sizeBytes = Buffer.byteLength(content);
  if (sizeBytes > FILE_MAX_BYTES) throw new RpcError('file_too_large', 'content exceeds the workspace save limit');
  const mode = !createOnly && target.exists ? saveMode(target.entry) : undefined;
  const tmpDir = mkdtempSync(join(dirname(target.entry), '.metaide-write-'));
  try {
    const tmp = join(tmpDir, 'content');
    writeStagedFile(tmp, content, mode);
    if (createOnly) publishNewFile(tmp, target.entry);
    else renameSync(tmp, target.entry);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  return { ok: true, sizeBytes };
}

function saveMode(entry: string): number | undefined {
  const stat = lstatSync(entry);
  if (stat.isSymbolicLink()) throw new RpcError('symlink_not_writable', 'open the target file directly to save changes');
  requireRegularFile(stat);
  return process.platform === 'win32' ? undefined : stat.mode & 0o7777;
}

function writeStagedFile(path: string, content: string, mode: number | undefined): void {
  const fd = openSync(path, 'wx', mode === undefined ? 0o666 : 0o600);
  try {
    writeFileSync(fd, content, 'utf8');
    if (mode !== undefined) fchmodSync(fd, mode); // Restore the exact mode after writes and independently of umask.
  } finally {
    closeSync(fd);
  }
}

function publishNewFile(staged: string, destination: string): void {
  try {
    // Publish complete bytes, without ever replacing an existing directory entry.
    linkSync(staged, destination);
  } catch (error) {
    if (errno(error) === 'EEXIST') throw new RpcError('already_exists', 'destination already exists');
    throw error;
  }
}

/** The shared runner disables fsmonitor; also suppress executable filters for remote worktree reads. */
async function workspaceGit(root: string): Promise<GitRunner> {
  const config = await runGit(root, ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process|smudge|required)$'], {
    maxBuffer: 16 * 1024, timeout: 5000,
  });
  if (config.status !== 0 && config.status !== 1) throw new RpcError('git_unavailable', 'project Git config could not be verified');
  const overrides = new Set<string>();
  for (const key of config.stdout.toString('utf8').split('\0').filter(Boolean)) {
    if (/[\u0000-\u001f=]/.test(key)) throw new RpcError('git_unavailable', 'project Git filter could not be verified');
    overrides.add(`${key}=${key.endsWith('.required') ? 'false' : ''}`);
  }
  const options = [...overrides].flatMap((setting) => ['-c', setting]);
  return (repo, args, opts) => runGit(repo, [...options, ...args], opts);
}

async function readGitStatus(root: string): Promise<{ status: Result<'workspace.diffStatus'>; run: GitRunner }> {
  const empty = { branch: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] };
  if (!checkedPath(root, '.git').exists) return { status: { isRepo: false, ...empty }, run: runGit };
  const top = await runGit(root, ['rev-parse', '--show-toplevel'], { maxBuffer: 16 * 1024, timeout: 5000 });
  if (top.status !== 0 || realpathSync.native(top.stdout.toString('utf8').replace(/\r?\n$/, '')) !== root) {
    throw new RpcError('git_unavailable', 'project repository could not be verified');
  }
  const run = await workspaceGit(root);
  const status = await run(root, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=dirty'], {
    maxBuffer: RESULT_MAX_BYTES, timeout: 5000,
  });
  if (status.tooLarge) throw oversizedResult();
  if (status.status !== 0 || status.timedOut) throw new RpcError('git_unavailable', 'project Git status could not be read');
  return { status: { isRepo: true, ...parseGitPanelStatus(status.stdout.toString('utf8')) }, run };
}

async function diffSides(root: string, request: Params<'workspace.diffSides'>): Promise<Result<'workspace.diffSides'>> {
  const { status, run } = await readGitStatus(root);
  if (!status.isRepo) throw new RpcError('git_unavailable', 'project is not a Git repository');
  const { kind, path, origPath, ifDiffHashNot } = request;
  const known = kind === 'untracked'
    ? origPath === undefined && status.untracked.includes(path)
    : status[kind].some((entry) => entry.path === path && entry.origPath === origPath);
  if (!known) throw new RpcError('unknown_change', 'path is not a current project change of this kind');
  const target = fileAccessPath(root, path, 'read');
  if (origPath !== undefined) fileAccessPath(root, origPath);
  // No-index diff must not re-interpret a now-directory path as a directory diff.
  if (kind === 'untracked' && !lstatSync(target.entry).isFile()) {
    throw new RpcError('git_unavailable', 'untracked change is not a regular file');
  }
  const result = await readDiffSides(root, { kind, path, origPath, ifDiffHashNot }, {
    ...defaultDiffSidesDeps,
    // Ignore submodule worktree dirtiness instead of running a nested repo's Git config.
    run(repo, args, opts) {
      const [command, ...rest] = args;
      if (command === 'diff') return run(repo, ['diff', '--ignore-submodules=dirty', ...rest], opts);
      return run(repo, args, opts);
    },
    fs: {
      ...nodeWorktreeFs,
      lstat(abs) {
        // Git returns asynchronously. Recheck before the helper reads the worktree side.
        fileAccessPath(root, relative(root, abs));
        return nodeWorktreeFs.lstat(abs);
      },
    },
  });
  return fitsResponse(result) ? result : { status: 'too-large' };
}

function agentSettings(s: WorkspaceServices, project: Project, root: string): Result<'workspace.agentSettings'> {
  const file = checkedPath(root, PROFILE_FILE);
  if (file.exists && regularFile(file).size > FILE_MAX_BYTES) {
    throw new RpcError('file_too_large', 'project agent catalog exceeds the workspace size limit');
  }
  const choices = new Set([
    TERMINAL_AGENT_NAME,
    ...(project.config.cliProfiles ?? []).map(({ name }) => name),
    ...readMetaIdeCliProfiles(root).map(({ name }) => name),
    ...s.settings.get('default_cli_profiles').map(({ name }) => name),
  ].filter((name) => name.length > 0 && name.length <= 256));
  const configured = project.config.defaultCliName;
  return {
    defaultAgent: configured && configured.length <= 256 ? configured : null,
    choices: [...choices],
    hasCustomCommand: hasCustomLaunchCommand(project),
  };
}

function activityTarget(project: Project, root: string, target: string): string | undefined {
  try {
    const base = isInsideRoot(project.path, target) ? project.path : root;
    const path = isAbsolute(target) ? relative(base, target) : target;
    if (path.length > 4096) return undefined;
    regularFile(fileAccessPath(root, path));
    return wirePath(root, resolve(root, path));
  } catch {
    return undefined; // No remote Files link when the file is missing or outside the project.
  }
}

function activityLines(root: string): string[] {
  const log = checkedPath(root, relative(root, activityPath(root)));
  if (!log.exists) return [];
  regularFile(log);
  const fd = openSync(log.canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new RpcError('not_a_file', 'activity log is not a regular file');
    const start = Math.max(0, stat.size - MAX_RPC_FRAME_BYTES);
    const lines = readBytes(fd, stat.size - start, start).toString('utf8').split('\n');
    if (start > 0) lines.shift(); // The first line may be cut mid-entry.
    const complete = lines.filter(Boolean);
    if (start > 0 && complete.length < ACTIVITY_LIMIT) throw oversizedResult();
    return complete.slice(-ACTIVITY_LIMIT);
  } finally {
    closeSync(fd);
  }
}

function readActivity(project: Project, root: string): Result<'workspace.activity'> {
  const entries: Result<'workspace.activity'>['entries'] = [];
  const schema = WorkspaceMethods['workspace.activity'].result.shape.entries.element;
  for (const line of activityLines(root)) {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { continue; }
    const result = schema.safeParse(raw);
    if (!result.success) continue;
    const entry = result.data;
    if (entry.kind === 'tool' && entry.tool && FILE_TOOLS.has(entry.tool) && entry.target) {
      const { target, ...rest } = entry;
      const path = activityTarget(project, root, target);
      entries.push(path === undefined ? rest : { ...rest, target: path });
    } else {
      entries.push(entry);
    }
  }
  return { entries };
}

/** The error every grant-gated method raises when the paired desktop lacks the host's workspace grant. */
export function workspaceForbidden(): RpcError {
  return new RpcError('forbidden', 'workspace access requires a grant from the host');
}

/** True when the project's config carries a custom first or subsequent launch command. */
export function hasCustomLaunchCommand(project: Project): boolean {
  return Boolean(project.config.launchCmd?.first || project.config.launchCmd?.subsequent);
}

/** Registers only the workspace contract; both the device and root must be eligible. */
export function registerWorkspace(
  peer: RpcPeer, s: WorkspaceServices, desktopAllowed: () => boolean, projectsChanged: () => void, policy: WorkspaceRootPolicy,
): void {
  function on<M extends WorkspaceMethod>(
    method: M, run: (root: string, params: Params<M>, project: Project) => Result<M> | Promise<Result<M>>,
  ): void {
    peer.handle(method, async (params, ctx) => {
      if (!desktopAllowed()) throw workspaceForbidden();
      if (ctx.stream !== undefined) throw new RpcError('not_a_stream', 'workspace methods are not streams');
      const project = s.projects.get(params.projectId);
      if (!project) throw new RpcError('unknown_project', 'no such project');
      const root = workspaceRootFor(project, policy);
      if (root === undefined) throw new RpcError('forbidden', 'this project is not available through remote workspace');
      const result = await run(root, params, project);
      if (!fitsResponse(result)) throw oversizedResult();
      return result;
    });
  }

  on('workspace.info', () => ({ activityEnabled: s.settings.get('activity_log_enabled') === true }));
  on('workspace.fileTree', (root, { relPath }) => fileTree(root, relPath ?? ''));
  on('workspace.fileRead', (root, { relPath, forceText }) => fileRead(root, relPath, forceText));
  on('workspace.fileWrite', fileWrite);
  on('workspace.fileMkdir', (root, { relPath }) => {
    const target = fileAccessPath(root, relPath, 'mkdir');
    if (target.exists) throw new RpcError('already_exists', 'destination already exists');
    mkdirSync(target.entry, { recursive: true });
    return { ok: true };
  });
  on('workspace.fileRename', (root, { from, to }) => {
    const src = fileAccessPath(root, from, 'move');
    const dst = fileAccessPath(root, to, 'move');
    if (dst.exists) throw new RpcError('already_exists', 'destination already exists');
    rejectNestedGitMetadata(src);
    renameSync(src.entry, dst.entry);
    return { ok: true };
  });
  on('workspace.fileDelete', (root, { relPath }) => {
    const target = fileAccessPath(root, relPath, 'move');
    rejectNestedGitMetadata(target);
    rmSync(target.entry, { recursive: true, force: true });
    return { ok: true };
  });
  on('workspace.diffStatus', async (root) => (await readGitStatus(root)).status);
  on('workspace.diffSides', diffSides);
  on('workspace.agentSettings', (root, _params, project) => agentSettings(s, project, root));
  on('workspace.setDefaultAgent', (root, { projectId, defaultAgent }, project) => {
    const current = agentSettings(s, project, root);
    if (current.hasCustomCommand) throw new RpcError('custom_command', 'change custom launch commands on the host');
    if (defaultAgent !== null && !current.choices.includes(defaultAgent)) {
      throw new RpcError('unknown_agent', 'selected agent is not available on the host');
    }
    if (!fitsResponse({ ...current, defaultAgent })) throw oversizedResult();
    const saved = setProjectDefaultAgent(s, { projectId, name: defaultAgent });
    if (!saved.ok) throw new RpcError('unknown_agent', 'selected agent is not available on the host');
    projectsChanged();
    return { ...current, defaultAgent: saved.project.config.defaultCliName ?? null };
  });
  on('workspace.activity', (root, _params, project) => {
    if (s.settings.get('activity_log_enabled') !== true) {
      throw new RpcError('activity_disabled', 'activity logging is not enabled on the host');
    }
    return readActivity(project, root);
  });
}
