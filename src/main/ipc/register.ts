import type { IpcMain } from 'electron';
import { dialog, nativeTheme, shell } from 'electron';
import type { Services } from '@main/services';
import type { IpcChannelName, IpcRequest, IpcResponse, IpcEventName, IpcEvents } from '@shared/ipc-contract';
import { discoverProjects } from '@main/domain/discovery';
import { resolveLaunch } from '@main/domain/launch';
import { chooseEvictee } from '@main/pty/keep-alive';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';

type Handler<C extends IpcChannelName> = (services: Services, req: IpcRequest<C>) => Promise<IpcResponse<C>>;
type SendEvent = <E extends IpcEventName>(channel: E, payload: IpcEvents[E]) => void;

export interface WindowHooks {
  createPopoutWindow: (projectId: number, shellIndex: number) => Promise<number>;
  returnPopoutWindow: (projectId: number, shellIndex: number) => boolean;
  listPopped: () => Array<{ projectId: number; shellIndex: number }>;
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

  'files:reveal': async (s, { projectId, relPath }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const abs = resolve(p.path, relPath);
    if (!abs.startsWith(resolve(p.path))) throw new Error('path escapes project root');
    if (!existsSync(abs)) throw new Error(`no such file: ${relPath}`);
    shell.showItemInFolder(abs);
    return { ok: true as const };
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

  const WINDOW_CHANNELS = new Set<IpcChannelName>(['windows:popout-shell', 'windows:return-shell', 'windows:list-popped']);

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
}
