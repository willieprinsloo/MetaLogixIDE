import type { IpcMain } from 'electron';
import { app, dialog, nativeImage, nativeTheme, shell, BrowserWindow } from 'electron';
import log from 'electron-log/main';
import type { Services } from '@main/services';
import type { IpcChannelName, IpcRequest, IpcResponse, IpcEventName, IpcEvents } from '@shared/ipc-contract';
import { discoverProjects } from '@main/domain/discovery';
import { discoverTasks } from '@main/domain/tasks';
import { randomUUID } from 'node:crypto';
import { parseMetaproject } from '@shared/parse-metaproject';
import { resolveLaunch } from '@main/domain/launch';
import { resolveSpawnEnv } from '@main/domain/spawn-env';
import { parseProjectEnv } from '@shared/project-env';
import type { Project, ProjectConfig } from '@shared/types';
import { defaultShellArgv, defaultShellBin } from '@main/domain/shell';
import { chooseEvictee } from '@main/pty/keep-alive';
import { applyClaudePermissionMode } from '@main/domain/claude-permission-mode';
import { isClaudePermissionMode } from '@shared/claude-permission-mode';
import { parseViewedShells } from '@main/notifications/viewed-shells';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseGitStatus } from '@shared/parse-git-status';
import { basename, dirname, join, relative, resolve } from 'node:path';

/** Spawn env overlay for a non-template spawn site: `templateEnv` ⊕ the project's interpolated variables. */
function projectSpawnEnv(
  s: Services,
  project: Project,
  templateEnv: Record<string, string>,
): Record<string, string> {
  return resolveSpawnEnv({ project, templateEnv, inherited: process.env, homeDir: s.homeDir }).env;
}

/**
 * Validates an untrusted `projects:update-config` patch before any write.
 * Only `env` is checked (AC8); the error names a key, never a value (AC17).
 */
function validatedConfigPatch(config: unknown): Partial<ProjectConfig> {
  if (typeof config !== 'object' || config === null || Array.isArray(config))
    throw new Error('config must be an object');
  const patch = config as Partial<ProjectConfig>;
  if (patch.env === undefined) return patch;
  const parsed = parseProjectEnv(patch.env);
  if (!parsed.ok) throw new Error(parsed.error);
  return patch;
}

type Handler<C extends IpcChannelName> = (services: Services, req: IpcRequest<C>, event?: Electron.IpcMainInvokeEvent) => Promise<IpcResponse<C>>;
type SendEvent = <E extends IpcEventName>(channel: E, payload: IpcEvents[E]) => void;

// Keychain service name for the metaproject credential. One row per (service,
// account) pair, keyed by username so a user could theoretically sign into
// multiple accounts by switching the last-used username in settings.
const KEYTAR_SERVICE = 'metaIDE.metaproject';

/**
 * Resolve keytar's function bag across the CJS/ESM interop gap. Rollup +
 * electron-vite's synthetic ESM namespace wraps CJS `module.exports` under
 * `.default`, so `(await import('keytar')).setPassword` is undefined in the
 * bundled main process. Some builds expose the functions at the top level;
 * others only via `.default`. This helper prefers whichever is present so we
 * never call `undefined` and blow up the login/remember-me path.
 */
async function loadKeytar(): Promise<{
  getPassword: (service: string, account: string) => Promise<string | null>;
  setPassword: (service: string, account: string, password: string) => Promise<void>;
  deletePassword: (service: string, account: string) => Promise<boolean>;
}> {
  const mod = await import('keytar');
  const m = mod as unknown as {
    default?: typeof mod;
    getPassword?: typeof mod.getPassword;
    setPassword?: typeof mod.setPassword;
    deletePassword?: typeof mod.deletePassword;
  };
  const flat = m.getPassword ? m : (m.default ?? m);
  return flat as unknown as {
    getPassword: (service: string, account: string) => Promise<string | null>;
    setPassword: (service: string, account: string, password: string) => Promise<void>;
    deletePassword: (service: string, account: string) => Promise<boolean>;
  };
}

/**
 * Merges project-scoped CLI profiles with the global defaults, deduping by
 * name (project entries win). Empty project arrays fall all the way through
 * to the global list, so users on a brand-new project still see Claude.
 */
function mergedCliProfiles(
  projectProfiles: Array<{ name: string; argv: string[]; env?: Record<string, string>; icon?: string }> | null,
  globalProfiles: Array<{ name: string; argv: string[]; env?: Record<string, string>; icon?: string }>,
): Array<{ name: string; argv: string[]; env?: Record<string, string>; icon?: string }> {
  const list = projectProfiles ?? [];
  if (list.length === 0) return globalProfiles;
  const names = new Set(list.map(p => p.name));
  return [...list, ...globalProfiles.filter(p => !names.has(p.name))];
}

export interface WindowHooks {
  createPopoutWindow: (projectId: number, shellIndex: number) => Promise<number>;
  returnPopoutWindow: (projectId: number, shellIndex: number) => boolean;
  listPopped: () => Array<{ projectId: number; shellIndex: number }>;
  tileAll: () => number;
}

const handlers: { [C in IpcChannelName]: Handler<C> } = {
  'dialogs:pick-directory': async (_s, _req, event) => {
    if (process.env.METAIDE_TEST_MODE === '1') {
      return { path: null };
    }
    // Attach to the invoking window so macOS renders the picker as a proper
    // sheet — without a parent, the panel can spawn behind vibrancy-backed
    // windows and appear as "nothing happened" to the user.
    const parent = event ? BrowserWindow.fromWebContents(event.sender) : null;
    const options = { properties: ['openDirectory' as const] };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    const picked = result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
    return { path: picked ?? null };
  },

  'app:ping': async () => 'pong',

  'roots:list':   async (s) => ({ roots: s.roots.list() }),
  'roots:add':    async (s, { path }) => {
    const root = s.roots.add(path);
    s.watcher.watch(path);
    for (const disc of discoverProjects(path, s.settings.get('scan_depth'))) {
      const p = s.projects.upsert(root.id, disc.path, disc.name);
      if (disc.metaprojectProjectId || disc.metaprojectBoardUrl) {
        s.projects.updateConfig(p.id, {
          linkedMetaprojectProjectId: disc.metaprojectProjectId ?? p.config.linkedMetaprojectProjectId ?? null,
          // Store board_url alongside — used by the Board button.
          notes: p.config.notes,
        });
        // Persist metaproject_project_id on the row too.
        if (disc.metaprojectProjectId) {
          s.projects.updateConfig(p.id, { linkedMetaprojectProjectId: disc.metaprojectProjectId });
        }
      }
    }
    return { root };
  },
  'roots:remove': async (s, { id }) => { s.roots.remove(id); return { ok: true } as const; },
  'roots:rescan': async (s, { id }) => {
    const root = s.roots.list().find(r => r.id === id);
    if (!root) return { discovered: 0 };
    let n = 0;
    for (const disc of discoverProjects(root.path, s.settings.get('scan_depth'))) {
      const p = s.projects.upsert(root.id, disc.path, disc.name); n++;
      if (disc.metaprojectProjectId) {
        s.projects.updateConfig(p.id, { linkedMetaprojectProjectId: disc.metaprojectProjectId });
      }
    }
    return { discovered: n };
  },

  'projects:list':    async (s) => ({ projects: s.projects.list() }),
  'projects:open':    async (s, { id }) => {
    const p = s.projects.get(id);
    if (!p) throw new Error(`no project ${id}`);
    // Re-read .metaproject.yaml on open so edits to project_id take effect
    // without requiring the user to trigger a full root rescan.
    const yamlPath = join(p.path, '.metaproject.yaml');
    if (existsSync(yamlPath)) {
      try {
        const link = parseMetaproject(readFileSync(yamlPath, 'utf8'));
        if (link.projectId && link.projectId !== p.config.linkedMetaprojectProjectId) {
          s.projects.updateConfig(id, { linkedMetaprojectProjectId: link.projectId });
        }
      } catch { /* leave existing link untouched */ }
    }
    s.projects.markLastOpened(id, new Date());
    return { project: s.projects.get(id)! };
  },
  'projects:create': async (s, { rootId, name, initGit }) => {
    const root = s.roots.list().find(r => r.id === rootId);
    if (!root) throw new Error(`no root ${rootId}`);
    if (!name || !/^[A-Za-z0-9._-][A-Za-z0-9._ -]*$/.test(name) || name === '.' || name === '..') {
      throw new Error('project name must start with a letter/digit and contain only letters, digits, dot, dash, underscore, or spaces');
    }
    const path = join(root.path, name);
    if (existsSync(path)) throw new Error(`already exists: ${path}`);
    mkdirSync(path, { recursive: true });
    if (initGit) {
      const gitDir = join(path, '.git');
      if (!existsSync(gitDir)) {
        const r = spawnSync('git', ['init', '-q', path], { cwd: path });
        if (r.status !== 0) {
          // Fall back to just an empty .git directory marker so discovery picks it up.
          mkdirSync(gitDir, { recursive: true });
        }
      }
      const readme = join(path, 'README.md');
      if (!existsSync(readme)) writeFileSync(readme, `# ${name}\n`);
    } else {
      // Give discovery a marker so the project is recognized.
      writeFileSync(join(path, '.metaproject.yaml'), `name: ${name}\n`);
    }
    const project = s.projects.upsert(rootId, path, name);
    s.projects.markLastOpened(project.id, new Date());
    return { project };
  },
  'projects:clone-git': async (s, { rootId, url, name }) => {
    const root = s.roots.list().find(r => r.id === rootId);
    if (!root) throw new Error(`no root ${rootId}`);
    // Derive a folder name from the URL if the caller didn't provide one:
    //   https://github.com/foo/bar.git → "bar"
    //   git@github.com:foo/bar        → "bar"
    let folder = (name ?? '').trim();
    if (!folder) {
      const last = url.replace(/\.git$/, '').replace(/[/:]$/, '').split(/[/:]/).pop();
      folder = last ?? '';
    }
    if (!folder || !/^[A-Za-z0-9._-][A-Za-z0-9._ -]*$/.test(folder) || folder === '.' || folder === '..') {
      throw new Error('project folder name must start with a letter/digit and contain only letters, digits, dot, dash, underscore, or spaces');
    }
    const path = join(root.path, folder);
    if (existsSync(path)) throw new Error(`already exists: ${path}`);
    // Delegate the clone to system git — much simpler than a JS libgit2
    // dependency and handles SSH, https, credential helpers, submodules, …
    // exactly like the user's own terminal would.
    const r = spawnSync('git', ['clone', '--', url, path], { cwd: root.path });
    if (r.status !== 0) {
      const stderr = r.stderr?.toString() || 'git clone failed';
      throw new Error(stderr.trim());
    }
    const project = s.projects.upsert(rootId, path, folder);
    s.projects.markLastOpened(project.id, new Date());
    return { project };
  },
  'projects:ensure-for-file': async (s, { path }) => {
    // Silently guarantee a project whose root contains `path` — used by the
    // OS file-open flow so a double-clicked .md/.py always lands in an
    // editor without a "add to project?" confirm.
    if (!path || !existsSync(path)) throw new Error(`file not found: ${path}`);
    const abs = resolve(path);
    const parent = dirname(abs);
    const projects = s.projects.list();
    const withSep = (p: string) => p.endsWith('/') ? p : p + '/';
    let match = projects
      .filter((p) => abs === p.path || abs.startsWith(withSep(p.path)))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!match) {
      // Reuse an existing root if one already contains the parent dir,
      // otherwise add the parent as a new root. Either way, upsert the
      // parent dir itself as a project so the file has a Files-tab home.
      const roots = s.roots.list();
      let root = roots.find((r) => parent === r.path || parent.startsWith(withSep(r.path)));
      if (!root) {
        root = s.roots.add(parent);
        s.watcher.watch(parent);
        for (const disc of discoverProjects(parent, s.settings.get('scan_depth'))) {
          const p = s.projects.upsert(root.id, disc.path, disc.name);
          if (disc.metaprojectProjectId) {
            s.projects.updateConfig(p.id, { linkedMetaprojectProjectId: disc.metaprojectProjectId });
          }
        }
      }
      match = s.projects.upsert(root.id, parent, basename(parent));
    }
    s.projects.markLastOpened(match.id, new Date());
    const relPath = abs === match.path ? '' : abs.slice(match.path.length + 1);
    return { project: match, relPath };
  },
  'projects:rename': async (s, { id, newName, killShells = true }) => {
    const project = s.projects.get(id);
    if (!project) throw new Error(`no project ${id}`);
    const cleanName = newName.trim();
    if (!cleanName || !/^[A-Za-z0-9._-][A-Za-z0-9._ -]*$/.test(cleanName) || cleanName === '.' || cleanName === '..') {
      throw new Error('name must start with a letter/digit and contain only letters, digits, dot, dash, underscore, or spaces');
    }
    if (cleanName === project.name && project.path.endsWith(`/${cleanName}`)) {
      return { project };
    }
    const parent = dirname(project.path);
    const target = join(parent, cleanName);
    if (existsSync(target)) throw new Error(`already exists: ${target}`);
    // Kill any live shells for the project first — the pty is chdir'd into
    // the old path and a rename with an open cwd handle either fails
    // (Windows) or silently keeps the old path alive (macOS/Linux).
    if (killShells) {
      const alive = s.shells.list().filter(r => r.projectId === id);
      for (const r of alive) {
        try { await s.ptyManager.kill(r.projectId, r.shellIndex); } catch { /* fine */ }
        s.shells.remove(r.projectId, r.shellIndex);
      }
    }
    // Stop the file watcher for the old path — a stale watcher would keep
    // firing "removed" events after the rename lands.
    try { s.watcher.unwatch(project.path); } catch { /* method may be absent */ }
    renameSync(project.path, target);
    const updated = s.projects.relocate(id, target, cleanName);
    try { s.watcher.watch(target); } catch { /* fine */ }
    return { project: updated };
  },
  'projects:pin':          async (s, { id, pinned }) => { s.projects.setPinned(id, pinned); return { ok: true } as const; },
  'projects:hide':         async (s, { id, hidden }) => { s.projects.setHidden(id, hidden); return { ok: true } as const; },
  'projects:update-config':async (s, { id, config }) => ({ project: s.projects.updateConfig(id, validatedConfigPatch(config)) }),
  'projects:recents':      async (s, { limit }) => ({ projects: s.projects.listRecents(limit ?? 10) }),

  'shells:launch': async (s, { projectId }) => {
    // Defence in depth behind the renderer's blocking modal: never spawn
    // Claude in Manual mode (the local, un-rewritten default) before the
    // user has made an explicit permission-mode choice.
    if (s.settings.get('claude_permission_mode') === null) throw new Error('Choose a Claude permission mode first');
    const project = s.projects.get(projectId);
    if (!project) throw new Error(`no project ${projectId}`);
    const cap = s.settings.get('keep_alive_cap');
    const alive = s.shells.list();
    if (alive.length >= cap) {
      const decision = chooseEvictee(alive, cap, projectId, new Date());
      if (decision.evictee) {
        await s.ptyManager.kill(decision.evictee.projectId, decision.evictee.shellIndex);
        s.shells.remove(decision.evictee.projectId, decision.evictee.shellIndex);
      } else if (decision.reason === 'all-pinned') {
        throw new Error('all shells are pinned — unpin one or raise cap');
      }
    }

    let launch = resolveLaunch(project, s.settings, s.homeDir, process.env);
    let fallbackApplied = false;

    // If subsequent variant (--continue) exits within ~3s with "no
    // conversation found", retry using the first variant instead. This
    // handles the case where the on-disk claude session was cleared.
    if (launch.variant === 'subsequent') {
      const settlement = await new Promise<'ok' | 'no-session'>((resolveP) => {
        const timer = setTimeout(() => resolveP('ok'), 2500);
        const onExit = (ev: { projectId: number; shellIndex: number; code: number | null; uptimeMs?: number; earlyOutput?: string }) => {
          if (ev.projectId !== projectId || ev.shellIndex !== 0) return;
          clearTimeout(timer);
          s.ptyManager.off('exit', onExit);
          const text = (ev.earlyOutput ?? '').toLowerCase();
          if ((ev.uptimeMs ?? 0) < 2500 && /no conversation found to continue|no previous session|--continue.*(?:no|not)/i.test(text)) {
            resolveP('no-session');
          } else {
            resolveP('ok');
          }
        };
        s.ptyManager.on('exit', onExit);
        void s.ptyManager.spawn(projectId, 0, launch).catch(() => resolveP('ok'));
      });

      if (settlement === 'no-session') {
        // Force the "first" variant: temporarily null out firstLaunchedAt
        // in the resolved project view, re-resolve, then restart cleanly.
        s.projects.updateConfig(projectId, {}); // touch — no-op
        const reProject = { ...project, firstLaunchedAt: null };
        launch = resolveLaunch(reProject, s.settings, s.homeDir, process.env);
        fallbackApplied = true;
        await s.ptyManager.spawn(projectId, 0, launch);
      }
    } else {
      await s.ptyManager.spawn(projectId, 0, launch);
    }

    if (!project.firstLaunchedAt) s.projects.setFirstLaunched(projectId, new Date());
    const now = new Date();
    const nowIso = `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}-${String(now.getUTCDate()).padStart(2,'0')} ${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}:${String(now.getUTCSeconds()).padStart(2,'0')}`;
    s.shells.upsert({ projectId, shellIndex: 0, model: null, launchArgv: launch.argv, startedAt: nowIso, lastActiveAt: nowIso, pinned: false });
    void fallbackApplied; // future: return this to renderer as a toast reason
    return { shellIndex: 0 };
  },
  'shells:launch-plain': async (s, { projectId }) => {
    const project = s.projects.get(projectId);
    if (!project) throw new Error(`no project ${projectId}`);
    // Pick the smallest unused shellIndex for this project. shellIndex 0 is
    // typically the Claude shell; ad-hoc terminals get 1, 2, …
    const used = new Set(s.shells.list().filter(r => r.projectId === projectId).map(r => r.shellIndex));
    let idx = 0;
    while (used.has(idx)) idx++;
    // Respect the alive cap the same way the primary launch does.
    const cap = s.settings.get('keep_alive_cap');
    const alive = s.shells.list();
    if (alive.length >= cap) {
      const decision = chooseEvictee(alive, cap, projectId, new Date());
      if (decision.evictee) {
        await s.ptyManager.kill(decision.evictee.projectId, decision.evictee.shellIndex);
        s.shells.remove(decision.evictee.projectId, decision.evictee.shellIndex);
      } else if (decision.reason === 'all-pinned') {
        throw new Error('all shells are pinned — unpin one or raise cap');
      }
    }
    const launch = {
      argv: defaultShellArgv(),
      cwd: project.path,
      env: projectSpawnEnv(s, project, {}),
      variant: 'first' as const,
    };
    await s.ptyManager.spawn(projectId, idx, launch);
    const now = new Date();
    const nowIso = `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}-${String(now.getUTCDate()).padStart(2,'0')} ${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}:${String(now.getUTCSeconds()).padStart(2,'0')}`;
    s.shells.upsert({ projectId, shellIndex: idx, model: null, launchArgv: launch.argv, startedAt: nowIso, lastActiveAt: nowIso, pinned: false });
    return { shellIndex: idx };
  },
  'shells:launch-cli': async (s, { projectId, profileName, argv, env, save }) => {
    const project = s.projects.get(projectId);
    if (!project) throw new Error(`no project ${projectId}`);
    // Resolve the argv: explicit inline wins, otherwise look up the profile
    // (project overrides > global defaults) by name.
    let resolvedArgv = argv;
    let resolvedEnv = env ?? {};
    let resolvedName = profileName;
    if (!resolvedArgv || resolvedArgv.length === 0) {
      if (!profileName) throw new Error('either profileName or argv is required');
      const merged = mergedCliProfiles(project.config.cliProfiles ?? null, s.settings.get('default_cli_profiles'));
      const match = merged.find(p => p.name === profileName);
      if (!match) throw new Error(`no CLI profile named "${profileName}"`);
      resolvedArgv = match.argv;
      resolvedEnv = { ...(match.env ?? {}), ...resolvedEnv };
    }
    // Expand a leading $SHELL sentinel so profiles can portably reference
    // the user's login shell without hard-coding a platform binary.
    if (resolvedArgv[0] === '$SHELL') {
      resolvedArgv = [defaultShellBin(), ...resolvedArgv.slice(1)];
    }
    // Persist as a project profile if the caller asked. Dedupe by name.
    if (save && resolvedName && argv && argv.length > 0) {
      const existing = project.config.cliProfiles ?? [];
      const withoutDupe = existing.filter(p => p.name !== resolvedName);
      const next = [...withoutDupe, { name: resolvedName, argv, env: env && Object.keys(env).length ? env : undefined }];
      s.projects.updateConfig(projectId, { cliProfiles: next });
    }
    // Same alive-cap + shell-slot logic as launch-plain.
    const used = new Set(s.shells.list().filter(r => r.projectId === projectId).map(r => r.shellIndex));
    let idx = 0;
    while (used.has(idx)) idx++;
    const cap = s.settings.get('keep_alive_cap');
    const alive = s.shells.list();
    if (alive.length >= cap) {
      const decision = chooseEvictee(alive, cap, projectId, new Date());
      if (decision.evictee) {
        await s.ptyManager.kill(decision.evictee.projectId, decision.evictee.shellIndex);
        s.shells.remove(decision.evictee.projectId, decision.evictee.shellIndex);
      } else if (decision.reason === 'all-pinned') {
        throw new Error('all shells are pinned — unpin one or raise cap');
      }
    }
    const launch = {
      argv: resolvedArgv,
      cwd: project.path,
      env: projectSpawnEnv(s, project, resolvedEnv),
      variant: 'first' as const,
    };
    await s.ptyManager.spawn(projectId, idx, launch);
    const now = new Date();
    const nowIso = `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}-${String(now.getUTCDate()).padStart(2,'0')} ${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}:${String(now.getUTCSeconds()).padStart(2,'0')}`;
    s.shells.upsert({ projectId, shellIndex: idx, model: null, launchArgv: launch.argv, startedAt: nowIso, lastActiveAt: nowIso, pinned: false });
    return { shellIndex: idx };
  },
  'shells:cli-profiles-list': async (s, { projectId }) => {
    const project = s.projects.get(projectId);
    if (!project) throw new Error(`no project ${projectId}`);
    const projectProfiles = project.config.cliProfiles ?? [];
    const globalProfiles = s.settings.get('default_cli_profiles');
    // Project overrides shadow same-name globals.
    const projectNames = new Set(projectProfiles.map(p => p.name));
    const flat = [
      ...projectProfiles.map(p => ({ ...p, scope: 'project' as const })),
      ...globalProfiles.filter(p => !projectNames.has(p.name)).map(p => ({ ...p, scope: 'global' as const })),
    ];
    return { profiles: flat };
  },
  'shells:cli-profiles-remove': async (s, { projectId, name }) => {
    const project = s.projects.get(projectId);
    if (!project) throw new Error(`no project ${projectId}`);
    const remaining = (project.config.cliProfiles ?? []).filter(p => p.name !== name);
    s.projects.updateConfig(projectId, { cliProfiles: remaining });
    return { ok: true } as const;
  },
  'shells:set-default-cli': async (s, { projectId, name }) => {
    const project = s.projects.get(projectId);
    if (!project) throw new Error(`no project ${projectId}`);
    // Clearing (name === null) also removes any low-level launchCmd
    // override so the project falls all the way back to the global
    // default — otherwise a stale launchCmd would trump defaultCliName.
    const patch: Partial<typeof project.config> = { defaultCliName: name };
    if (name === null) patch.launchCmd = null;
    const updated = s.projects.updateConfig(projectId, patch);
    return { project: updated };
  },
  'shells:kill':   async (s, { projectId, shellIndex }) => { await s.ptyManager.kill(projectId, shellIndex); s.shells.remove(projectId, shellIndex); return { ok: true } as const; },
  'shells:resize': async (s, { projectId, shellIndex, cols, rows }) => { s.ptyManager.resize(projectId, shellIndex, cols, rows); return { ok: true } as const; },
  'shells:write':  async (s, { projectId, shellIndex, data }) => { s.ptyManager.write(projectId, shellIndex, data); s.shells.touch(projectId, shellIndex, new Date()); return { ok: true } as const; },
  'claude-state:list': async (s) => ({ shells: s.claudeState.list() }),
  'shells:alive-list': async (s) => {
    const rows = s.shells.list();
    const projects = new Map(s.projects.list().map(p => [p.id, p]));
    const alive = rows
      .filter(r => s.ptyManager.isAlive(r.projectId, r.shellIndex))
      .map(r => {
        const p = projects.get(r.projectId);
        return { ...r, projectName: p?.name ?? '', projectPath: p?.path ?? '' };
      });
    return { shells: alive };
  },
  'shells:ports': async (s) => ({ entries: s.ptyManager.allPorts() }),
  'shells:live-stats': async (s) => {
    const live = s.ptyManager.liveShells();
    if (live.length === 0) return { shells: [] };
    // One `ps` call for every alive pid — cheap on macOS/Linux (kernel-side
    // process table lookup, no fork per pid). Format: `%CPU RSS_KB`.
    const pids = live.map(l => String(l.pid)).join(',');
    let statsByPid: Record<number, { cpu: number; rssKb: number }> = {};
    try {
      const r = spawnSync('ps', ['-o', 'pid=,%cpu=,rss=', '-p', pids], { encoding: 'utf8', timeout: 3000 });
      if (r.status === 0) {
        for (const line of r.stdout.trim().split('\n')) {
          const cols = line.trim().split(/\s+/);
          if (cols.length < 3) continue;
          const pid = Number(cols[0]); const cpu = Number(cols[1]); const rss = Number(cols[2]);
          if (Number.isFinite(pid)) statsByPid[pid] = { cpu: Number.isFinite(cpu) ? cpu : 0, rssKb: Number.isFinite(rss) ? rss : 0 };
        }
      }
    } catch { statsByPid = {}; }
    const now = Date.now();
    const projectMap = new Map(s.projects.list().map(p => [p.id, p]));
    // Same launchName heuristic as useProjectShells so the popover reads
    // "Claude / Terminal" instead of raw binary paths.
    const shellRows = s.shells.list();
    const shellsByKey = new Map(shellRows.map(r => [`${r.projectId}:${r.shellIndex}`, r]));
    const shells = live.map((l) => {
      const st = statsByPid[l.pid] ?? { cpu: 0, rssKb: 0 };
      const idleMs = now - l.lastDataAt;
      const uptimeMs = now - l.startedAt;
      // "Hanging" heuristic: alive > 30s, idle > 5 min, CPU under 1%.
      // Deliberately conservative — we badge but don't auto-kill.
      const hanging = uptimeMs > 30_000 && idleMs > 5 * 60_000 && st.cpu < 1;
      const shellRow = shellsByKey.get(`${l.projectId}:${l.shellIndex}`);
      const bin = shellRow?.launchArgv?.[0] ?? '';
      const base = bin.replace(/.*\//, '');
      const launchName = base === '$SHELL' || /^(zsh|bash|sh|fish)$/.test(base)
        ? 'Terminal'
        : base ? base[0]!.toUpperCase() + base.slice(1) : `Shell ${l.shellIndex}`;
      return {
        projectId: l.projectId,
        shellIndex: l.shellIndex,
        projectName: projectMap.get(l.projectId)?.name ?? `#${l.projectId}`,
        pid: l.pid,
        cpuPercent: st.cpu,
        memMB: Math.round(st.rssKb / 1024),
        uptimeMs, idleMs,
        launchName,
        hanging,
      };
    });
    return { shells };
  },
  'shells:pin':   async (s, { projectId, shellIndex, pinned }) => { s.shells.setPinned(projectId, shellIndex, pinned); return { ok: true } as const; },
  'shells:snapshot': async (s, { projectId, shellIndex }) => {
    const alive = s.ptyManager?.isAlive(projectId, shellIndex) ?? false;
    const output = await s.ptyManager?.getSnapshot(projectId, shellIndex) ?? '';
    return { output, alive };
  },

  'settings:get': async (s, { key }) => ({ value: s.settings.get(key) }),
  'settings:set': async (s, { key, value }) => {
    // The permission mode can only change through applyClaudePermissionMode
    // (settings:set-claude-permission-mode), which keeps it in lockstep with
    // the managed launch commands it rewrites — never via the generic setter.
    if (key === 'claude_permission_mode') throw new Error('claude_permission_mode can only be changed via settings:set-claude-permission-mode');
    s.settings.set(key, value as never);
    return { ok: true } as const;
  },
  'settings:set-claude-permission-mode': async (s, { mode }) => {
    if (!isClaudePermissionMode(mode)) throw new Error(`invalid Claude permission mode (expected 'auto' or 'bypass')`);
    const changedKeys = applyClaudePermissionMode(s.settings, mode);
    return { mode, changedKeys };
  },

  // Renderer-supplied view data: validated here; a forged view can at worst suppress the user's own notifications.
  'notifications:viewed-shells': async (s, req) => {
    s.viewedShells.setReported(parseViewedShells(req));
    return { ok: true } as const;
  },

  'windows:popout-shell': async () => {
    throw new Error('windows:popout-shell requires WindowHooks — see registerIpc');
  },
  'windows:return-shell': async () => {
    throw new Error('windows:return-shell requires WindowHooks — see registerIpc');
  },
  'windows:list-popped': async () => {
    throw new Error('windows:list-popped requires WindowHooks — see registerIpc');
  },
  'windows:tile-all': async () => {
    throw new Error('windows:tile-all requires WindowHooks — see registerIpc');
  },

  'app:set-native-theme': async (_s, { source }) => {
    nativeTheme.themeSource = source;
    return { ok: true } as const;
  },

  'app:open-external': async (_s, { url }) => {
    // Only allow http(s), mailto:, and file: URLs. Everything else is
    // rejected to prevent renderer-driven shell.openExternal abuse.
    if (!/^(https?|mailto|file):/i.test(url)) throw new Error('unsupported URL scheme');
    await shell.openExternal(url);
    return { ok: true } as const;
  },
  'app:get-log-path': async () => ({ path: log.transports.file.getFile().path }),
  'app:get-version':  async () => ({ version: app.getVersion() }),
  'app:reveal-log-file': async () => {
    shell.showItemInFolder(log.transports.file.getFile().path);
    return { ok: true } as const;
  },
  'app:reveal-in-folder': async (_s, { path }) => {
    shell.showItemInFolder(path);
    return { ok: true } as const;
  },

  'app:set-window-opacity': async (s, { percent }) => {
    const clamped = Math.max(30, Math.min(100, Math.round(percent)));
    s.settings.set('window_opacity', clamped);
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.setOpacity(clamped / 100);
    }
    return { ok: true } as const;
  },

  /* ─── metaproject chat ─── */
  'metaproject:login': async (s, { username, password, remember }) => {
    const baseUrl = s.settings.get('metaproject_base_url') || 'https://projects.metalogix.solutions';
    const info = await s.metaproject.login({ baseUrl, username, password });
    // Remember the username (never the password in settings) so the sign-in
    // card can pre-fill it next time.
    try { s.settings.set('metaproject_last_username', username); } catch { /* non-fatal */ }
    // When the user opted in, store the password in the OS keychain. Keytar
    // uses macOS Keychain / libsecret / Windows Credential Vault under the
    // hood — the plaintext never touches disk in userland.
    if (remember) {
      try {
        const keytar = await loadKeytar();
        await keytar.setPassword(KEYTAR_SERVICE, username, password);
      } catch (err) {
        console.warn('[metaproject] failed to persist credential', err);
      }
    }
    s.metaproject.connectSocket();
    return info;
  },
  'metaproject:credentials-load': async (s) => {
    const username = s.settings.get('metaproject_last_username') || null;
    if (!username) return { username: null, hasPassword: false };
    try {
      const keytar = await loadKeytar();
      const pw = await keytar.getPassword(KEYTAR_SERVICE, username);
      return { username, hasPassword: !!pw };
    } catch {
      return { username, hasPassword: false };
    }
  },
  'metaproject:credentials-clear': async (s) => {
    const username = s.settings.get('metaproject_last_username') || null;
    if (username) {
      try {
        const keytar = await loadKeytar();
        await keytar.deletePassword(KEYTAR_SERVICE, username);
      } catch { /* non-fatal */ }
    }
    return { ok: true } as const;
  },
  'metaproject:auto-login': async (s) => {
    if (s.metaproject.isLoggedIn()) return { ok: true, userName: s.metaproject.currentUserName() ?? undefined };
    const username = s.settings.get('metaproject_last_username') || null;
    if (!username) {
      log.info('[metaproject] auto-login skipped: no saved username');
      return { ok: false, reason: 'no-saved-username' };
    }
    let password: string | null = null;
    try {
      const keytar = await loadKeytar();
      password = await keytar.getPassword(KEYTAR_SERVICE, username);
    } catch (err) {
      log.warn('[metaproject] auto-login: keychain read failed', err);
      return { ok: false, reason: `keychain-error: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!password) {
      // Common on dev builds: the packaged app wrote the item as
      // `com.metalogix.metaide`, but dev-Electron runs as
      // `com.github.Electron` so keytar returns null silently. Fall back to
      // making the user re-enter the password once.
      log.info(`[metaproject] auto-login skipped: no keychain password for user "${username}" (fresh login required)`);
      return { ok: false, reason: 'no-saved-password' };
    }
    const baseUrl = s.settings.get('metaproject_base_url') || 'https://projects.metalogix.solutions';
    try {
      const info = await s.metaproject.login({ baseUrl, username, password });
      s.metaproject.connectSocket();
      log.info(`[metaproject] auto-login ok as ${info.userName}`);
      return { ok: true, userName: info.userName };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn(`[metaproject] auto-login failed for "${username}": ${reason}`);
      return { ok: false, reason };
    }
  },
  'metaproject:status': async (s) => ({
    loggedIn: s.metaproject.isLoggedIn(),
    connected: s.metaproject.isConnected(),
    userName: s.metaproject.currentUserName(),
    userId: s.metaproject.currentUserId(),
  }),
  'metaproject:logout': async (s) => { s.metaproject.disconnect(); return { ok: true } as const; },
  'metaproject:list-channels': async (s, { projectId }) => ({
    channels: await s.metaproject.listChannels(projectId),
  }),
  'metaproject:list-all-channels': async (s, { scope }) => ({
    channels: await s.metaproject.listAllChannels(scope),
  }),
  'metaproject:list-projects': async (s) => ({
    projects: await s.metaproject.listMetaprojectProjects(),
  }),
  'metaproject:list-users': async (s) => ({
    users: await s.metaproject.listUsers(),
  }),
  'metaproject:create-project': async (s, { name, description, projectType }) => ({
    project: await s.metaproject.createMetaprojectProject({ name, description, projectType }),
  }),
  'metaproject:link-local-project': async (s, { projectId, metaprojectProjectId }) => {
    const project = s.projects.get(projectId);
    if (!project) throw new Error(`no project ${projectId}`);
    const yamlPath = join(project.path, '.metaproject.yaml');
    // Upsert `project_id:` in the yaml. Preserves any other keys the user
    // added (identifier, epics, spec_dir, branch_pattern, …).
    let current = '';
    try { current = readFileSync(yamlPath, 'utf8'); } catch { /* fresh file */ }
    const idLine = `project_id: ${metaprojectProjectId}`;
    let next: string;
    if (/^project_id:.*$/m.test(current)) {
      next = current.replace(/^project_id:.*$/m, idLine);
    } else if (current.trim()) {
      next = `${idLine}\n${current}`.replace(/\n{3,}/g, '\n\n');
    } else {
      // Sensible starter yaml so the user has something to edit later.
      next = `${idLine}\nname: ${project.name}\n`;
    }
    writeFileSync(yamlPath, next);
    // Reflect the change immediately in the projects repo (mirrors what
    // `projects:open` does when it re-reads the yaml on next open).
    s.projects.updateConfig(projectId, { linkedMetaprojectProjectId: String(metaprojectProjectId) });
    return { ok: true } as const;
  },
  'metaproject:list-messages': async (s, { channelId, limit, projectId }) => ({
    messages: await s.metaproject.listMessages(channelId, limit, projectId),
  }),
  'metaproject:join-channel':  async (s, { channelId }) => { s.metaproject.joinChannel(channelId);  return { ok: true } as const; },
  'metaproject:send-message':  async (s, { channelId, message, parentMessageId }) => {
    s.metaproject.sendChannelMessage(channelId, message, parentMessageId ?? null);
    return { ok: true } as const;
  },
  'metaproject:mark-read':     async (s, { channelId, lastMessageId }) => {
    s.metaproject.markRead(channelId, lastMessageId);
    return { ok: true } as const;
  },
  'metaproject:edit-message':  async (s, { channelId, messageId, message }) => {
    s.metaproject.editChannelMessage(channelId, messageId, message);
    return { ok: true } as const;
  },
  'metaproject:delete-message': async (s, { channelId, messageId }) => {
    s.metaproject.deleteChannelMessage(channelId, messageId);
    return { ok: true } as const;
  },
  'metaproject:download-attachment': async (s, { projectId, attachmentId, filename }) => {
    const buf = await s.metaproject.fetchAttachment(projectId, attachmentId);
    const downloads = app.getPath('downloads');
    // Never silently overwrite an existing file — append ` (2)`, ` (3)`, …
    // before the extension the way Chromium does.
    let target = join(downloads, filename);
    if (existsSync(target)) {
      const dot = filename.lastIndexOf('.');
      const stem = dot > 0 ? filename.slice(0, dot) : filename;
      const ext  = dot > 0 ? filename.slice(dot) : '';
      let n = 2;
      while (existsSync(join(downloads, `${stem} (${n})${ext}`))) n++;
      target = join(downloads, `${stem} (${n})${ext}`);
    }
    writeFileSync(target, Buffer.from(buf));
    return { path: target };
  },

  'files:tree':   async (s, { projectId, relPath }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const abs = relPath ? join(p.path, relPath) : p.path;
    const entries = readdirSync(abs).map(name => {
      const full = join(abs, name);
      let isDir = false; try { isDir = statSync(full).isDirectory(); } catch {}
      return { name, isDir, relPath: relative(p.path, full) };
    });
    entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return { entries };
  },

  'files:list-all': async (s, { projectId, limit = 5000, filter }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const root = resolve(p.path);
    const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache', 'target', '__pycache__', '.venv', 'venv', '.pnpm-store']);
    const filterLc = filter?.toLowerCase();
    const files: Array<{ relPath: string; name: string }> = [];
    let total = 0;
    let truncated = false;
    function walk(dir: string) {
      if (truncated) return;
      let names: string[];
      try { names = readdirSync(dir); } catch { return; }
      for (const name of names) {
        if (name.startsWith('.') && name !== '.metaproject.yaml') continue;
        if (IGNORE.has(name)) continue;
        const full = join(dir, name);
        let isDir = false;
        try { isDir = statSync(full).isDirectory(); } catch { continue; }
        if (isDir) { walk(full); continue; }
        total++;
        if (filterLc && !name.toLowerCase().includes(filterLc)) continue;
        if (files.length >= limit) { truncated = true; return; }
        files.push({ relPath: relative(root, full), name });
      }
    }
    walk(root);
    return { files, total, truncated };
  },

  'files:write':  async (s, { projectId, relPath, content }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const abs = resolve(p.path, relPath);
    if (!abs.startsWith(resolve(p.path))) throw new Error('path escapes project root');
    // Atomic write via a sibling temp file then rename — protects against
    // partial writes if the process dies mid-flush.
    const tmp = `${abs}.metaide-tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, abs);
    const st = statSync(abs);
    return { ok: true as const, sizeBytes: st.size };
  },

  'files:mkdir':  async (s, { projectId, relPath }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const abs = resolve(p.path, relPath);
    if (!abs.startsWith(resolve(p.path))) throw new Error('path escapes project root');
    if (existsSync(abs)) throw new Error(`already exists: ${relPath}`);
    mkdirSync(abs, { recursive: true });
    return { ok: true as const };
  },

  'files:rename': async (s, { projectId, from, to }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const root = resolve(p.path);
    const src = resolve(root, from);
    const dst = resolve(root, to);
    if (!src.startsWith(root) || !dst.startsWith(root)) throw new Error('path escapes project root');
    if (!existsSync(src)) throw new Error(`no such file: ${from}`);
    if (existsSync(dst)) throw new Error(`target exists: ${to}`);
    renameSync(src, dst);
    return { ok: true as const };
  },

  'files:delete': async (s, { projectId, relPath }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const abs = resolve(p.path, relPath);
    if (!abs.startsWith(resolve(p.path))) throw new Error('path escapes project root');
    if (abs === resolve(p.path)) throw new Error('refusing to delete project root');
    if (!existsSync(abs)) return { ok: true as const };
    rmSync(abs, { recursive: true, force: true });
    return { ok: true as const };
  },

  'files:peek':   async (s, { projectId, relPath, maxLines = 40 }) => {
    const cur = s.projects.get(projectId);
    if (!cur) throw new Error(`no project ${projectId}`);

    // Roots to try, in priority order:
    //   1. the current project
    //   2. absolute path as-is
    //   3. every other visible project (so Claude output referencing a
    //      sibling project still previews)
    const roots: string[] = [resolve(cur.path)];
    const others = s.projects.list().filter((p) => p.id !== projectId).map((p) => resolve(p.path));
    for (const o of others) if (!roots.includes(o)) roots.push(o);

    // Build candidate absolute paths for each root plus the raw path.
    const candidates: Array<{ abs: string; root: string }> = [];
    candidates.push({ abs: resolve(relPath), root: '' });                 // absolute as-is
    for (const r of roots) candidates.push({ abs: resolve(r, relPath), root: r });

    for (const { abs, root } of candidates) {
      if (root && !abs.startsWith(root)) continue;
      try {
        const st = statSync(abs);
        if (st.isDirectory()) continue;
        const displayRel = root ? relative(root, abs) : abs;
        if (st.size > 2_000_000) {
          return { relPath: displayRel, found: true, kind: 'text' as const, head: `File too large (${st.size} bytes).`, sizeBytes: st.size, totalLines: null };
        }
        const buf = readFileSync(abs);
        const scan = buf.subarray(0, Math.min(4096, buf.length));
        if (scan.includes(0)) {
          return { relPath: displayRel, found: true, kind: 'binary' as const, head: '', sizeBytes: st.size, totalLines: null };
        }
        const text = buf.toString('utf8');
        const lines = text.split(/\r?\n/);
        const head = lines.slice(0, maxLines).join('\n');
        return { relPath: displayRel, found: true, kind: 'text' as const, head, sizeBytes: st.size, totalLines: lines.length };
      } catch { /* try next candidate */ }
    }
    return { relPath, found: false, kind: 'text' as const, head: '', sizeBytes: 0, totalLines: null };
  },

  'files:reveal': async (s, { projectId, relPath }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const abs = resolve(p.path, relPath);
    if (!abs.startsWith(resolve(p.path))) throw new Error('path escapes project root');
    if (!existsSync(abs)) throw new Error(`no such file: ${relPath}`);
    shell.showItemInFolder(abs);
    return { ok: true as const };
  },

  'files:start-drag': async () => {
    // Real implementation lives inline in registerIpc — it needs
    // `event.sender` so it can call `webContents.startDrag()`.
    throw new Error('files:start-drag requires webContents access — see registerIpc');
  },

  'app:renderer-ready-for-files': async () => {
    // Real implementation lives in main/index.ts so it can access the
    // file-open buffer state. Registered there BEFORE registerIpc runs.
    throw new Error('app:renderer-ready-for-files is wired in main/index.ts');
  },

  'git:status': async (s, { projectId }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    if (!existsSync(join(p.path, '.git'))) {
      return { isRepo: false, branch: null, ahead: 0, behind: 0, files: {}, dirty: false };
    }
    // porcelain=v1 + --branch gives a stable machine-readable format with header.
    const r = spawnSync('git', ['-C', p.path, 'status', '--porcelain=v1', '--branch', '--untracked-files=all'], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0) {
      return { isRepo: true, branch: null, ahead: 0, behind: 0, files: {}, dirty: false };
    }
    const parsed = parseGitStatus(r.stdout);
    return { isRepo: true, ...parsed, dirty: Object.keys(parsed.files).length > 0 };
  },
  'git:panel-status': async (s, { projectId }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    if (!existsSync(join(p.path, '.git'))) {
      return { isRepo: false, branch: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] };
    }
    const r = spawnSync('git', ['-C', p.path, 'status', '--porcelain=v1', '--branch', '--untracked-files=all'], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0) return { isRepo: true, branch: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] };
    // Parse porcelain lines directly here — we need per-column detail
    // (staged X vs unstaged Y) that the collapsed parseGitStatus loses.
    const lines = r.stdout.split('\n');
    let branch: string | null = null;
    let ahead = 0;
    let behind = 0;
    const staged: Array<{ path: string; status: 'M' | 'A' | 'D' | 'R' | 'U' | '?' | '!' }> = [];
    const unstaged: Array<{ path: string; status: 'M' | 'A' | 'D' | 'R' | 'U' | '?' | '!' }> = [];
    const untracked: string[] = [];
    for (const line of lines) {
      if (line.startsWith('## ')) {
        const branchMatch = line.slice(3).match(/^([^.\s]+)(?:\.\.\.[^\s]+)?/);
        if (branchMatch) branch = branchMatch[1] ?? null;
        const aheadMatch = line.match(/ahead (\d+)/);
        const behindMatch = line.match(/behind (\d+)/);
        if (aheadMatch)  ahead  = Number(aheadMatch[1]);
        if (behindMatch) behind = Number(behindMatch[1]);
        continue;
      }
      if (line.length < 3) continue;
      const x = line[0]!; const y = line[1]!;
      const path = line.slice(3);
      const norm = (c: string): 'M' | 'A' | 'D' | 'R' | 'U' | '?' | '!' => {
        if (c === 'M' || c === 'A' || c === 'D' || c === 'R' || c === 'U' || c === '?' || c === '!') return c;
        return 'M';
      };
      if (x === '?' && y === '?') { untracked.push(path); continue; }
      if (x !== ' ' && x !== '?') staged.push({ path, status: norm(x) });
      if (y !== ' ' && y !== '?') unstaged.push({ path, status: norm(y) });
    }
    return { isRepo: true, branch, ahead, behind, staged, unstaged, untracked };
  },
  'git:stage':   async (s, { projectId, paths }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    if (paths.length === 0) return { ok: true } as const;
    const r = spawnSync('git', ['-C', p.path, 'add', '--', ...paths], { encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0) throw new Error(r.stderr.trim() || 'git add failed');
    return { ok: true } as const;
  },
  'git:unstage': async (s, { projectId, paths }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    if (paths.length === 0) return { ok: true } as const;
    // `git restore --staged` is the modern equivalent of `git reset HEAD --`.
    const r = spawnSync('git', ['-C', p.path, 'restore', '--staged', '--', ...paths], { encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0) throw new Error(r.stderr.trim() || 'git unstage failed');
    return { ok: true } as const;
  },
  'git:commit':  async (s, { projectId, message }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    if (!message.trim()) throw new Error('commit message is empty');
    // Pass the message via `-F -` on stdin so we never worry about shell
    // quoting on multi-line messages or embedded backticks/dollars.
    const r = spawnSync('git', ['-C', p.path, 'commit', '-F', '-'], { encoding: 'utf8', timeout: 30000, input: message });
    if (r.status !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || 'git commit failed');
    return { ok: true } as const;
  },
  'git:push':    async (s, { projectId }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const r = spawnSync('git', ['-C', p.path, 'push'], { encoding: 'utf8', timeout: 60000 });
    if (r.status !== 0) throw new Error((r.stderr || r.stdout).trim() || 'git push failed');
    return { ok: true, output: (r.stdout + r.stderr).trim() } as const;
  },
  'git:pull':    async (s, { projectId }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const r = spawnSync('git', ['-C', p.path, 'pull'], { encoding: 'utf8', timeout: 60000 });
    if (r.status !== 0) throw new Error((r.stderr || r.stdout).trim() || 'git pull failed');
    return { ok: true, output: (r.stdout + r.stderr).trim() } as const;
  },

  'search:project': async (s, { projectId, query, caseSensitive = false, regex = false, maxFiles = 3000, maxMatchesPerFile = 20 }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    if (!query || query.length < 2) return { matches: [], filesScanned: 0, truncated: false };
    const root = resolve(p.path);
    const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache', 'target', '__pycache__', '.venv', 'venv', '.pnpm-store']);
    const matches: Array<{ relPath: string; line: number; col: number; preview: string }> = [];
    let filesScanned = 0;
    let truncated = false;

    let pattern: RegExp;
    try {
      pattern = regex
        ? new RegExp(query, caseSensitive ? 'g' : 'gi')
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
    } catch (e) { throw new Error(`invalid regex: ${String(e).replace(/^Error:\s*/, '')}`); }

    function walk(dir: string) {
      if (truncated || filesScanned >= maxFiles) { truncated = true; return; }
      let names: string[];
      try { names = readdirSync(dir); } catch { return; }
      for (const name of names) {
        if (truncated) return;
        if (name.startsWith('.') && name !== '.metaproject.yaml') continue;
        if (IGNORE.has(name)) continue;
        const full = join(dir, name);
        let isDir = false;
        try { isDir = statSync(full).isDirectory(); } catch { continue; }
        if (isDir) { walk(full); continue; }
        filesScanned++;
        if (filesScanned > maxFiles) { truncated = true; return; }
        let buf: Buffer;
        try { buf = readFileSync(full); } catch { continue; }
        if (buf.length > 1_000_000) continue;                       // skip files > 1 MB
        const scan = buf.subarray(0, Math.min(4096, buf.length));
        if (scan.includes(0)) continue;                             // binary
        const text = buf.toString('utf8');
        const relPath = relative(root, full);
        let perFile = 0;
        // Reset lastIndex each line so we can find multiple matches per line.
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          pattern.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = pattern.exec(line))) {
            if (perFile >= maxMatchesPerFile) break;
            matches.push({ relPath, line: i + 1, col: m.index + 1, preview: line.slice(0, 400) });
            perFile++;
            if (m.index === pattern.lastIndex) pattern.lastIndex++; // guard against empty matches
          }
          if (perFile >= maxMatchesPerFile) break;
        }
      }
    }
    walk(root);
    return { matches, filesScanned, truncated };
  },

  /* ─── Prompt library ─── */
  'prompts:list':   async (s, { projectId }) => ({ prompts: s.prompts.list(projectId) }),
  'prompts:save':   async (s, { prompt }) => {
    const title = prompt.title.trim();
    const body  = prompt.body;
    if (!title) throw new Error('title is required');
    if (!body)  throw new Error('body is required');
    const id = prompt.id || randomUUID();
    const saved = s.prompts.upsert({
      id, projectId: prompt.projectId ?? null,
      title, body, tags: prompt.tags ?? [],
    });
    return { prompt: saved };
  },
  'prompts:delete': async (s, { id }) => { s.prompts.remove(id); return { ok: true } as const; },
  'prompts:paste':  async (s, { projectId, shellIndex, text, submit }) => {
    if (!s.ptyManager.isAlive(projectId, shellIndex)) throw new Error('shell is not running');
    // Write via PtyManager so timing / lastDataAt clock stays consistent
    // with real user input. If submit is true, add \r so the shell runs it.
    s.ptyManager.write(projectId, shellIndex, submit ? `${text}\r` : text);
    s.shells.touch(projectId, shellIndex, new Date());
    return { ok: true } as const;
  },

  /* ─── Task runner ─── */
  'tasks:discover': async (s, { projectId }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    return { tasks: discoverTasks(p.path) };
  },
  'tasks:run': async (s, { projectId, taskId }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const task = discoverTasks(p.path).find(t => t.id === taskId);
    if (!task) throw new Error(`no task ${taskId}`);
    // Reuse the same shell-slot policy the plain launcher uses.
    const used = new Set(s.shells.list().filter(r => r.projectId === projectId).map(r => r.shellIndex));
    let idx = 0;
    while (used.has(idx)) idx++;
    const cap = s.settings.get('keep_alive_cap');
    const alive = s.shells.list();
    if (alive.length >= cap) {
      const decision = chooseEvictee(alive, cap, projectId, new Date());
      if (decision.evictee) {
        await s.ptyManager.kill(decision.evictee.projectId, decision.evictee.shellIndex);
        s.shells.remove(decision.evictee.projectId, decision.evictee.shellIndex);
      } else if (decision.reason === 'all-pinned') {
        throw new Error('all shells are pinned — unpin one or raise cap');
      }
    }
    const launch = {
      argv: task.command,
      cwd: p.path,
      env: projectSpawnEnv(s, p, {}),
      variant: 'first' as const,
    };
    await s.ptyManager.spawn(projectId, idx, launch);
    const now = new Date();
    const nowIso = `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}-${String(now.getUTCDate()).padStart(2,'0')} ${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}:${String(now.getUTCSeconds()).padStart(2,'0')}`;
    s.shells.upsert({ projectId, shellIndex: idx, model: null, launchArgv: launch.argv, startedAt: nowIso, lastActiveAt: nowIso, pinned: false });
    return { shellIndex: idx };
  },

  /* ─── Per-file git diff ─── */
  'git:file-diff': async (s, { projectId, path, staged, untracked }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    if (!existsSync(join(p.path, '.git'))) return { diff: '' };
    // Untracked files aren't in the index; `--no-index` compares against
    // /dev/null so we get a full add-diff — matches what `git diff` prints
    // once the file is added, without side-effects.
    if (untracked) {
      const r = spawnSync('git', ['-C', p.path, 'diff', '--no-index', '--', '/dev/null', path], { encoding: 'utf8', timeout: 15000 });
      // `--no-index` returns non-zero when the files differ (they always do
      // here — one side is /dev/null). Prefer stdout unless it's empty.
      return { diff: r.stdout || r.stderr || '' };
    }
    const args = staged
      ? ['-C', p.path, 'diff', '--cached', '--', path]
      : ['-C', p.path, 'diff', '--', path];
    const r = spawnSync('git', args, { encoding: 'utf8', timeout: 15000 });
    return { diff: r.stdout || '' };
  },

  /* ─── Global scrollback search ─── */
  'shells:search-scrollback': async (s, { query, caseSensitive, regex, contextLines }) => {
    const raw = s.ptyManager.searchScrollback(query, { caseSensitive, regex, contextLines });
    const projectMap = new Map(s.projects.list().map(p => [p.id, p]));
    const shellRows = s.shells.list();
    const shellsByKey = new Map(shellRows.map(r => [`${r.projectId}:${r.shellIndex}`, r]));
    const shellsScanned = s.ptyManager.list().length;
    const matches = raw.map((m) => {
      const shellRow = shellsByKey.get(`${m.projectId}:${m.shellIndex}`);
      const bin = shellRow?.launchArgv?.[0] ?? '';
      const base = bin.replace(/.*\//, '');
      const launchName = base === '$SHELL' || /^(zsh|bash|sh|fish)$/.test(base)
        ? 'Terminal'
        : base ? base[0]!.toUpperCase() + base.slice(1) : `Shell ${m.shellIndex}`;
      return {
        projectId: m.projectId,
        shellIndex: m.shellIndex,
        projectName: projectMap.get(m.projectId)?.name ?? `#${m.projectId}`,
        launchName,
        pid: m.pid,
        line: m.line,
        lineNumber: m.lineNumber,
        contextBefore: m.contextBefore,
        contextAfter: m.contextAfter,
      };
    });
    return { matches, shellsScanned };
  },

  'files:read':   async (s, { projectId, relPath, forceText }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    // Prevent path traversal — resolved path must stay within project root.
    const abs = resolve(p.path, relPath);
    if (!abs.startsWith(resolve(p.path))) throw new Error('path escapes project root');
    const st = statSync(abs);
    if (st.isDirectory()) throw new Error(`${relPath} is a directory`);
    if (st.size > 2_000_000) return { content: `File too large (${st.size} bytes) — preview capped at 2 MB.`, kind: 'text' as const, sizeBytes: st.size };
    const buf = readFileSync(abs);
    // Heuristic binary check: NUL byte in first 8KB. `forceText` skips the
    // check (used by the "Edit as text anyway" escape hatch on the binary
    // preview placeholder — some UTF-16 / encoded files trip the heuristic
    // even though they're valid text).
    if (!forceText) {
      const scan = buf.subarray(0, Math.min(8192, buf.length));
      const isBinary = scan.includes(0);
      if (isBinary) return { content: '', kind: 'binary' as const, sizeBytes: st.size };
    }
    return { content: buf.toString('utf8'), kind: 'text' as const, sizeBytes: st.size };
  },
};

const CHANNEL_EMITS: Partial<Record<IpcChannelName, IpcEventName[]>> = {
  'roots:add':      ['projects:changed'],
  'roots:remove':   ['projects:changed'],
  'roots:rescan':   ['projects:changed'],
  'projects:open':  ['projects:changed'],
  'projects:pin':   ['projects:changed'],
  'projects:hide':  ['projects:changed'],
  'projects:create':['projects:changed'],
  'projects:ensure-for-file': ['projects:changed'],
  'projects:clone-git':['projects:changed'],
  'projects:rename': ['projects:changed', 'alive-shells:changed'],
  'metaproject:link-local-project': ['projects:changed'],
  'shells:launch':  ['alive-shells:changed', 'projects:changed'],
  'shells:launch-plain': ['alive-shells:changed'],
  'shells:launch-cli':   ['alive-shells:changed', 'projects:changed'],
  'shells:cli-profiles-remove': ['projects:changed'],
  'shells:set-default-cli': ['projects:changed'],
  'projects:update-config': ['projects:changed'],
  'shells:kill':    ['alive-shells:changed'],
  'shells:pin':     ['alive-shells:changed'],
};

function eventPayload<E extends IpcEventName>(name: E): IpcEvents[E] {
  if (name === 'projects:changed') return { kind: 'updated' } as IpcEvents[E];
  return {} as IpcEvents[E];
}

export function registerIpc(ipcMain: IpcMain, services: Services, sendEvent: SendEvent, windowHooks?: WindowHooks): void {
  if (services.ptyManager) {
    services.ptyManager.on('data', (ev: IpcEvents['pty:data']) => sendEvent('pty:data', ev));
    services.ptyManager.on('exit', (ev: IpcEvents['pty:exit']) => {
      sendEvent('pty:exit', ev);
      services.shells?.remove(ev.projectId, ev.shellIndex);
      sendEvent('alive-shells:changed', {});
    });
  }

  // Forward every metaproject socket event to renderer as a single generic
  // channel; the chat pane fans them out by name.
  if (services.metaproject) {
    services.metaproject.onEvent('*', (raw: unknown) => {
      const { event, payload } = raw as { event: string; payload: unknown };
      sendEvent('metaproject:event', { event, payload });
    });
  }

  const WINDOW_CHANNELS = new Set<IpcChannelName>(['windows:popout-shell', 'windows:return-shell', 'windows:list-popped', 'windows:tile-all', 'files:start-drag', 'app:renderer-ready-for-files']);
  // Wired separately below: its emitted `settings:changed` events are keyed
  // per changed setting, which the fixed per-channel CHANNEL_EMITS payload
  // (one static payload per event name) can't express.
  const CUSTOM_EMIT_CHANNELS = new Set<IpcChannelName>(['settings:set-claude-permission-mode']);

  for (const channel of Object.keys(handlers) as IpcChannelName[]) {
    if (WINDOW_CHANNELS.has(channel) || CUSTOM_EMIT_CHANNELS.has(channel)) continue; // wired below
    ipcMain.handle(channel, async (event, req) => {
      const fn = handlers[channel] as (s: Services, req: unknown, e?: Electron.IpcMainInvokeEvent) => Promise<unknown>;
      const result = await fn(services, req, event);
      for (const evt of CHANNEL_EMITS[channel] ?? []) sendEvent(evt, eventPayload(evt));
      return result;
    });
  }

  ipcMain.handle('settings:set-claude-permission-mode', async (_e, req: IpcRequest<'settings:set-claude-permission-mode'>) => {
    const result = await handlers['settings:set-claude-permission-mode'](services, req);
    for (const key of result.changedKeys) sendEvent('settings:changed', { key });
    return result;
  });

  ipcMain.handle('windows:popout-shell', async (_e, req: IpcRequest<'windows:popout-shell'>) => {
    if (!windowHooks) throw new Error('windows:popout-shell not wired');
    const windowId = await windowHooks.createPopoutWindow(req.projectId, req.shellIndex);
    return { windowId };
  });
  ipcMain.handle('windows:return-shell', async (_e, req: IpcRequest<'windows:return-shell'>) => {
    if (!windowHooks) throw new Error('windows:return-shell not wired');
    windowHooks.returnPopoutWindow(req.projectId, req.shellIndex);
    return { ok: true } as const;
  });
  ipcMain.handle('windows:list-popped', async () => {
    if (!windowHooks) return { popped: [] };
    return { popped: windowHooks.listPopped() };
  });
  ipcMain.handle('windows:tile-all', async () => {
    if (!windowHooks) return { arranged: 0 };
    return { arranged: windowHooks.tileAll() };
  });

  ipcMain.handle('files:start-drag', async (event, req: IpcRequest<'files:start-drag'>) => {
    const project = services.projects.get(req.projectId);
    if (!project) throw new Error(`no project ${req.projectId}`);
    const root = resolve(project.path);
    // Reject anything that escapes the project root — we only expose files
    // the user could already see in the Files tab.
    const absPaths = req.paths.map((p) => resolve(root, p)).filter((abs) => abs.startsWith(root) && existsSync(abs));
    if (absPaths.length === 0) throw new Error('no valid files to drag');
    // startDrag needs a non-empty NativeImage. app.getFileIcon returns the
    // OS's own icon for the file (or a generic folder icon for dirs), which
    // renders under the cursor in Finder / other targets — matches the
    // native feel users expect from Chromium's built-in file drag.
    let icon;
    try {
      icon = await app.getFileIcon(absPaths[0]!, { size: 'small' });
    } catch {
      // Extremely unlikely — but a 16x16 opaque grey fallback keeps the
      // drag session valid rather than throwing during the user's gesture.
      icon = nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAG0lEQVR4AWMYBaNgFIyCUTAKRsEoGAWjYBSMglEAAAgAAeGa4l4AAAAASUVORK5CYII=',
      );
    }
    // Electron's `Item` type requires `file` even when `files` is used —
    // `file` is the single-drag fallback + hint for anti-macros; `files`
    // is what actually gets picked up by multi-file targets.
    event.sender.startDrag({ file: absPaths[0]!, files: absPaths, icon });
    return { ok: true } as const;
  });
}
