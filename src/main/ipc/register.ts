import type { IpcMain } from 'electron';
import { dialog, nativeTheme, shell, BrowserWindow } from 'electron';
import type { Services } from '@main/services';
import type { IpcChannelName, IpcRequest, IpcResponse, IpcEventName, IpcEvents } from '@shared/ipc-contract';
import { discoverProjects } from '@main/domain/discovery';
import { parseMetaproject } from '@shared/parse-metaproject';
import { resolveLaunch } from '@main/domain/launch';
import { chooseEvictee } from '@main/pty/keep-alive';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseGitStatus } from '@shared/parse-git-status';
import { join, relative, resolve } from 'node:path';

type Handler<C extends IpcChannelName> = (services: Services, req: IpcRequest<C>) => Promise<IpcResponse<C>>;
type SendEvent = <E extends IpcEventName>(channel: E, payload: IpcEvents[E]) => void;

// Keychain service name for the metaproject credential. One row per (service,
// account) pair, keyed by username so a user could theoretically sign into
// multiple accounts by switching the last-used username in settings.
const KEYTAR_SERVICE = 'metaIDE.metaproject';

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
  'dialogs:pick-directory': async () => {
    if (process.env.METAIDE_TEST_MODE === '1') {
      return { path: null };
    }
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
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
  'projects:pin':          async (s, { id, pinned }) => { s.projects.setPinned(id, pinned); return { ok: true } as const; },
  'projects:hide':         async (s, { id, hidden }) => { s.projects.setHidden(id, hidden); return { ok: true } as const; },
  'projects:update-config':async (s, { id, config }) => ({ project: s.projects.updateConfig(id, config) }),
  'projects:recents':      async (s, { limit }) => ({ projects: s.projects.listRecents(limit ?? 10) }),

  'shells:launch': async (s, { projectId }) => {
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

    let launch = resolveLaunch(project, s.settings, s.homeDir);
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
        launch = resolveLaunch(reProject, s.settings, s.homeDir);
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
    const shellBin = process.env.SHELL || '/bin/zsh';
    const launch = { argv: [shellBin, '-l'] as string[], cwd: project.path, env: {}, variant: 'first' as const };
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
    // the user's login shell without hard-coding /bin/zsh.
    if (resolvedArgv[0] === '$SHELL') {
      resolvedArgv = [process.env.SHELL || '/bin/zsh', ...resolvedArgv.slice(1)];
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
    const launch = { argv: resolvedArgv, cwd: project.path, env: resolvedEnv, variant: 'first' as const };
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
  'shells:kill':   async (s, { projectId, shellIndex }) => { await s.ptyManager.kill(projectId, shellIndex); s.shells.remove(projectId, shellIndex); return { ok: true } as const; },
  'shells:resize': async (s, { projectId, shellIndex, cols, rows }) => { s.ptyManager.resize(projectId, shellIndex, cols, rows); return { ok: true } as const; },
  'shells:write':  async (s, { projectId, shellIndex, data }) => { s.ptyManager.write(projectId, shellIndex, data); s.shells.touch(projectId, shellIndex, new Date()); return { ok: true } as const; },
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
  'shells:pin':   async (s, { projectId, shellIndex, pinned }) => { s.shells.setPinned(projectId, shellIndex, pinned); return { ok: true } as const; },
  'shells:snapshot': async (s, { projectId, shellIndex }) => {
    const alive = s.ptyManager?.isAlive(projectId, shellIndex) ?? false;
    const output = s.ptyManager?.getScrollback(projectId, shellIndex) ?? '';
    return { output, alive };
  },

  'settings:get': async (s, { key }) => ({ value: s.settings.get(key) }),
  'settings:set': async (s, { key, value }) => { s.settings.set(key, value as never); return { ok: true } as const; },

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
        const keytar = await import('keytar');
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
      const keytar = await import('keytar');
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
        const keytar = await import('keytar');
        await keytar.deletePassword(KEYTAR_SERVICE, username);
      } catch { /* non-fatal */ }
    }
    return { ok: true } as const;
  },
  'metaproject:auto-login': async (s) => {
    if (s.metaproject.isLoggedIn()) return { ok: true, userName: s.metaproject.currentUserName() ?? undefined };
    const username = s.settings.get('metaproject_last_username') || null;
    if (!username) return { ok: false, reason: 'no-saved-username' };
    let password: string | null = null;
    try {
      const keytar = await import('keytar');
      password = await keytar.getPassword(KEYTAR_SERVICE, username);
    } catch (err) {
      return { ok: false, reason: `keychain-error: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!password) return { ok: false, reason: 'no-saved-password' };
    const baseUrl = s.settings.get('metaproject_base_url') || 'https://projects.metalogix.solutions';
    try {
      const info = await s.metaproject.login({ baseUrl, username, password });
      s.metaproject.connectSocket();
      return { ok: true, userName: info.userName };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
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

  'files:read':   async (s, { projectId, relPath }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    // Prevent path traversal — resolved path must stay within project root.
    const abs = resolve(p.path, relPath);
    if (!abs.startsWith(resolve(p.path))) throw new Error('path escapes project root');
    const st = statSync(abs);
    if (st.isDirectory()) throw new Error(`${relPath} is a directory`);
    if (st.size > 2_000_000) return { content: `File too large (${st.size} bytes) — preview capped at 2 MB.`, kind: 'text' as const, sizeBytes: st.size };
    const buf = readFileSync(abs);
    // Heuristic binary check: NUL byte in first 8KB.
    const scan = buf.subarray(0, Math.min(8192, buf.length));
    const isBinary = scan.includes(0);
    if (isBinary) return { content: '', kind: 'binary' as const, sizeBytes: st.size };
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
  'shells:launch':  ['alive-shells:changed', 'projects:changed'],
  'shells:launch-plain': ['alive-shells:changed'],
  'shells:launch-cli':   ['alive-shells:changed', 'projects:changed'],
  'shells:cli-profiles-remove': ['projects:changed'],
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

  const WINDOW_CHANNELS = new Set<IpcChannelName>(['windows:popout-shell', 'windows:return-shell', 'windows:list-popped', 'windows:tile-all']);

  for (const channel of Object.keys(handlers) as IpcChannelName[]) {
    if (WINDOW_CHANNELS.has(channel)) continue; // wired below
    ipcMain.handle(channel, async (_e, req) => {
      const fn = handlers[channel] as (s: Services, req: unknown) => Promise<unknown>;
      const result = await fn(services, req);
      for (const evt of CHANNEL_EMITS[channel] ?? []) sendEvent(evt, eventPayload(evt));
      return result;
    });
  }

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
}
