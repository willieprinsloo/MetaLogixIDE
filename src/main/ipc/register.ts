import type { IpcMain } from 'electron';
import { app, dialog, nativeImage, nativeTheme, shell, BrowserWindow } from 'electron';
import log from 'electron-log/main';
import type { Services } from '@main/services';
import type { GitDiffKind, IpcChannelName, IpcRequest, IpcResponse, IpcEventName, IpcEvents } from '@shared/ipc-contract';
import { discoverProjects } from '@main/domain/discovery';
import { pruneMissingProjects } from '@main/domain/prune-missing';
import { discoverAllTasks } from '@main/domain/tasks';
import { randomUUID } from 'node:crypto';
import type { VibrancyMaterial } from '@shared/frosted-glass';
import { isChromeFrostLevel, isTerminalFrostMode, isTerminalFrostOpacity, isVibrancyMaterial, TERMINAL_FROST_OPACITY_KEY } from '@shared/frosted-glass';
import { profileLaunchArgv, resolveLaunch } from '@main/domain/launch';
import { harnessOf, type AgentHarness } from '@shared/agent-harness';
import { parseProjectDefaultAgent, setProjectDefaultAgent } from '@main/domain/project-default-agent';
import { resolveSpawnEnv } from '@main/domain/spawn-env';
import { parseProjectEnv, parseAppEnv } from '@shared/project-env';
import type { Project, ProjectConfig, SettingsMap } from '@shared/types';
import type { TasksDiscovery } from '@shared/tasks-contract';
import { defaultShellArgv, defaultShellBin } from '@main/domain/shell';
import { chooseEvictee } from '@main/pty/keep-alive';
import { applyClaudePermissionMode } from '@main/domain/claude-permission-mode';
import { isClaudePermissionMode } from '@shared/claude-permission-mode';
import type { P2PApi } from '../p2p/types';
import { isFontSettingKey, parseFontFamilyPreference } from '@shared/font-settings';
import { TERMINAL_ENGINE_KEY, isTerminalEngine } from '@shared/terminal-engine';
import { isTerminalPaddingKey, isTerminalPaddingValue } from '@shared/terminal-padding';
import { TERMINAL_FONT_SIZE_KEY, parseTerminalFontSize } from '@shared/terminal-font-size';
import {
  TERMINAL_FONT_WEIGHT_KEY,
  TERMINAL_BOLD_WEIGHT_KEY,
  parseTerminalFontWeight,
  derivedBoldWeight,
  isValidBoldWeight,
  resolveTerminalWeights,
} from '@shared/terminal-font-weight';
import { parseViewedShells } from '@main/notifications/viewed-shells';
import { parseRemoteViewing } from '@main/notifications/fleet-notices';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseGitStatus } from '@shared/parse-git-status';
import { parseGitPanelStatus } from '@shared/parse-git-panel-status';
import { describeGitFailure, runGit } from '@main/git/run-git';
import { gitCommandError, runGitCommand } from '@main/git/run-git-command';
import { GIT_DIFF_MAX_BYTES, readFileDiff } from '@main/git/file-diff';
import { readDiffSides } from '@main/git/diff-sides';
import { explainDiff } from '@main/diff-explain';
import { dropHandlers } from '@main/drops/handlers';
import { keepAwakeHandlers } from '@main/keep-awake/handlers';
import { UsageService, usageDepsFor } from '@main/usage/service';
import { LaunchCoalescer, launchKey } from '@main/ipc/shells-launch-coalesce';
import { ensureAgentStanza, buildOnboardingNudge, nudgeAgentShell } from '@main/chat/onboard';
import { isManagedMetaprojectSetting } from '@main/repos/settings-repo';

/** `<userData>/usage-debug/` holds the last usage response per provider; undefined outside Electron (unit tests). */
function usageDebugDir(): string | undefined {
  try {
    return join(app.getPath('userData'), 'usage-debug');
  } catch {
    return undefined;
  }
}
import { isInsideRoot, resolveInsideRoot } from '@main/domain/path-containment';
import { MIME_BY_EXT } from '@shared/mime';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StopPrimarySessionRequest } from '@shared/unload-session-contract';
import { readRecentActivity } from '@main/activity/log';
import { ACTIVITY_PAGE_MAX } from '@shared/activity';
import { listStoryChunks, readStoryHtml } from '@main/story/narrator';
import { generateStoryChunkAI } from '@main/story/ai-narrator';
import { refreshFeatures } from '@main/story/feature-generator';
import { newestEntryMtime, readFeature, readFeatures, writeFeature } from '@main/story/feature-store';
import { submitReport } from '@main/feedback/reporter';
import { folderNameFor, isBindSkipped, recordBindSkip } from '@main/bind-prompt';
import { release as osRelease } from 'node:os';
import { readMetaIdeEnv, readMetaIdeCliProfiles } from '@main/domain/metaide-conf';

const GIT_DIFF_KINDS: ReadonlySet<GitDiffKind> = new Set(['staged', 'unstaged', 'untracked']);
const execFileAsync = promisify(execFile);

/** Spawn env overlay for a non-template spawn site: `templateEnv` ⊕ the project's interpolated variables. */
function projectSpawnEnv(
  s: Services,
  project: Project,
  templateEnv: Record<string, string>,
): Record<string, string> {
  const appEnv = s.settings.get('app_env');
  const metaIdeEnv = readMetaIdeEnv(project.path);
  return resolveSpawnEnv({ project, templateEnv, inherited: process.env, homeDir: s.homeDir, appEnv, metaIdeEnv }).env;
}

/**
 * Every task of `project`, listing mise with the exact env its tasks are spawned with (spec AC6) and
 * logging the kind of any listing failure. `tasks:run` calls this on every run, never a cache, so an id
 * the current listing does not report, including any mise id while the config is untrusted, is refused (AC9, AC22).
 */
const miseWarnSeen = new Set<string>();
/** Test-only: clear the mise-warn dedup set so each test starts clean. */
export function __resetMiseWarnDedupForTests(): void { miseWarnSeen.clear(); }
const gitPanelStatusWarnSeen = new Set<string>();
/** Test-only: clear the git:panel-status warn dedup set. */
export function __resetGitPanelStatusWarnDedupForTests(): void { gitPanelStatusWarnSeen.clear(); }
async function discoverProjectTasks(s: Services, project: Project): Promise<TasksDiscovery> {
  const env = { ...process.env, ...projectSpawnEnv(s, project, {}) };
  const discovery = await discoverAllTasks(project.path, { env, listMise: s.listMise });
  // Log each (project, kind) pair once per session — tasks:run calls this on
  // every run, which flooded the log with 368 identical warns last week.
  for (const n of discovery.notices) {
    const sig = `${project.id}|${n.kind}`;
    if (miseWarnSeen.has(sig)) continue;
    miseWarnSeen.add(sig);
    log.warn('[tasks] mise listing failed', { projectId: project.id, kind: n.kind });
  }
  return discovery;
}

/**
 * Validates an untrusted `projects:update-config` patch before any write.
 * Only `env` is checked (AC8); the error names a key, never a value (AC17).
 */
function validatedConfigPatch(config: unknown): Partial<ProjectConfig> {
  if (typeof config !== 'object' || config === null || Array.isArray(config))
    throw new Error('config must be an object');
  if ('linkedMetaprojectProjectId' in config) throw new Error('Use Project Settings to change the Metaproject assignment');
  const patch = config as Partial<ProjectConfig>;
  if (patch.env === undefined) return patch;
  const parsed = parseProjectEnv(patch.env);
  if (!parsed.ok) throw new Error(parsed.error);
  return patch;
}


/** True when a live shell of `projectId` (other than `exceptShell`) runs `harness`, launched as it or started by hand in a terminal. */
function harnessBusy(s: Services, projectId: number, harness: AgentHarness, exceptShell: number): boolean {
  const launched = s.shells.list().some((row) => row.projectId === projectId && row.shellIndex !== exceptShell &&
    s.ptyManager.isAlive(projectId, row.shellIndex) && harnessOf(row.launchArgv) === harness);
  return launched || (s.agentStatus?.list() ?? []).some((e) =>
    e.projectId === projectId && e.shellIndex !== exceptShell && e.agent === harness);
}

/** Records that `harness` has run in the project, so its next launch there resumes the session. */
export function rememberResumableHarness(s: Pick<Services, 'projects'>, projectId: number, harness: AgentHarness): void {
  const project = s.projects.get(projectId);
  if (!project || (project.config.resumableAgents ?? []).includes(harness)) return;
  s.projects.updateConfig(projectId, { resumableAgents: [...(project.config.resumableAgents ?? []), harness] });
}

/** Records that `argv`'s harness has run in the project, so its next launch resumes the session. */
function rememberResumable(s: Services, projectId: number, argv: readonly string[]): void {
  const harness = harnessOf(argv);
  if (harness) rememberResumableHarness(s, projectId, harness);
}

/** True for a subsequent Claude launch that continues a session (`--continue`/`-c` before any `--`): only that can fail with "no conversation found". */
function isClaudeContinuation(launch: { variant: 'first' | 'subsequent'; argv: readonly string[] }): boolean {
  if (launch.variant !== 'subsequent' || harnessOf(launch.argv) !== 'claude') return false;
  for (const arg of launch.argv.slice(1)) {
    if (arg === '--') return false;
    if (arg === '--continue' || arg === '-c') return true;
  }
  return false;
}

/** Records the live primary shell and tells renderers right after spawn, so its tab and status dot appear without waiting on resume checks. A shell that already exited is not recorded. */
function publishPrimary(s: Services, projectId: number, argv: string[]): void {
  if (!s.ptyManager.isAlive(projectId, 0)) return;
  const nowIso = new Date().toISOString().slice(0, 19).replace('T', ' ');
  s.shells.upsert({ projectId, shellIndex: 0, model: null, launchArgv: argv, startedAt: nowIso, lastActiveAt: nowIso, pinned: false });
  emitAliveShellsChanged();
}

/** One-at-a-time per (projectId, shellIndex). See the `shells:launch` handler. */
const SHELLS_LAUNCH_COALESCER = new LaunchCoalescer<{ shellIndex: number }>();

/**
 * The pairing code is minted by the relay on its first Hello, so a call to
 * `generatePairCode` immediately after settings-open can beat the relay
 * and throw `relay_not_ready`. The renderer used to retry at 1s × 15,
 * each attempt logging "Error occurred in handler for ...: relay_not_ready"
 * at error (107 of these last week). Wait for readiness here instead — one
 * IPC, one log at worst if the relay really is down.
 */
async function waitForPairCode(s: Services): Promise<{ code: string; expiresAt: number }> {
  const start = Date.now();
  const deadlineMs = 10_000;
  for (;;) {
    try {
      return p2pApi(s).generatePairCode();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== 'relay_not_ready' || Date.now() - start >= deadlineMs) throw err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * The real body of `shells:launch`, hoisted out so the handler can run it
 * under the coalescer. `project` is the already-resolved row (with
 * `firstLaunchedAt` nulled out for forceFirst), so this function makes no
 * decisions about which variant to launch — it only acts on it.
 */
async function doShellsLaunch(s: Services, project: Project): Promise<{ shellIndex: number }> {
  const projectId = project.id;
  // Idempotent: clicking an already-open project (or a tab the sidebar
  // thinks might not be alive) used to re-enter here and throw "already
  // spawned". Just return the index — the renderer re-attaches the stream.
  if (s.ptyManager.isAlive(projectId, 0)) return { shellIndex: 0 };
  assertProjectPathExists(project);
  const cap = s.settings.get('keep_alive_cap');
  const alive = s.shells.list();
  if (alive.length >= cap) {
    // Pass `inRunningGroupChat` so a Claude tab that is a member of a running
    // group chat is never evicted — that would break the round it is
    // participating in (group-chats design §7.5).
    const decision = chooseEvictee(alive, cap, projectId, new Date(), inRunningGroupChat(s));
    if (decision.evictee) {
      await s.ptyManager.kill(decision.evictee.projectId, decision.evictee.shellIndex);
      s.shells.remove(decision.evictee.projectId, decision.evictee.shellIndex);
    } else if (decision.reason === 'all-pinned') {
      throw new Error('all shells are pinned — unpin one or raise cap');
    }
  }

  const launchOptions = { resumeBlocked: (harness: AgentHarness) => harnessBusy(s, projectId, harness, 0) };
  let launch = resolveLaunch(project, s.settings, s.homeDir, process.env, launchOptions);
  let fallbackApplied = false;

  // If a Claude continuation (--continue) exits within ~2.5s with "no
  // conversation found", retry using the first variant instead. This
  // handles the case where the on-disk claude session was cleared. The
  // shell is published as soon as it spawns, so the tab label and status
  // dot never wait on this check; other launches skip it entirely.
  if (isClaudeContinuation(launch)) {
    const settlement = await new Promise<'ok' | 'no-session' | { error: string }>((resolveP) => {
      // The settle timer must also drop the exit listener, or one leaks per relaunch.
      const timer = setTimeout(() => { s.ptyManager.off('exit', onExit); resolveP('ok'); }, 2500);
      const onExit = (ev: { projectId: number; shellIndex: number; generation: string; code: number | null; uptimeMs?: number; earlyOutput?: string }) => {
        if (ev.projectId !== projectId || ev.shellIndex !== 0) return;
        const live = s.ptyManager.liveShell(projectId, 0);
        if (live && live.generation !== ev.generation) return;
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
      // Surface spawn failures instead of swallowing them — a missing
      // `claude` binary used to end up as a blank terminal with no cause.
      void s.ptyManager.spawn(projectId, 0, launch).then(() => publishPrimary(s, projectId, launch.argv)).catch((err: unknown) => {
        clearTimeout(timer);
        s.ptyManager.off('exit', onExit);
        resolveP({ error: err instanceof Error ? err.message : String(err) });
      });
    });

    if (typeof settlement === 'object' && 'error' in settlement) {
      throw new Error(`shell failed to start: ${settlement.error}`);
    }

    if (settlement === 'no-session') {
      // Force the "first" variant: temporarily null out firstLaunchedAt
      // in the resolved project view, re-resolve, then restart cleanly.
      s.projects.updateConfig(projectId, {}); // touch — no-op
      const reProject = { ...project, firstLaunchedAt: null };
      launch = resolveLaunch(reProject, s.settings, s.homeDir, process.env, launchOptions);
      fallbackApplied = true;
      await s.ptyManager.spawn(projectId, 0, launch);
      publishPrimary(s, projectId, launch.argv);
    }
  } else {
    await s.ptyManager.spawn(projectId, 0, launch);
    publishPrimary(s, projectId, launch.argv);
  }

  if (!project.firstLaunchedAt) s.projects.setFirstLaunched(projectId, new Date());
  rememberResumable(s, projectId, launch.argv);
  void fallbackApplied; // future: return this to renderer as a toast reason
  return { shellIndex: 0 };
}

/** Validates a local guarded-unload target before reading PTY or tracker state. */
function primaryProjectId(request: unknown): number {
  if (typeof request !== 'object' || request === null || !('projectId' in request) ||
    typeof request.projectId !== 'number' || !Number.isSafeInteger(request.projectId) || request.projectId <= 0)
    throw new Error('invalid projectId');
  return request.projectId;
}

/** Parses consent as a bounded opaque generation and an explicit work-risk acknowledgment. */
function stopPrimaryRequest(request: unknown): StopPrimarySessionRequest {
  const projectId = primaryProjectId(request);
  if (typeof request !== 'object' || request === null || !('generation' in request) ||
    typeof request.generation !== 'string' || request.generation.length > 128 ||
    !/^[A-Za-z0-9-]+$/.test(request.generation))
    throw new Error('invalid generation');
  if (!('acknowledgedWorkRisk' in request) || typeof request.acknowledgedWorkRisk !== 'boolean')
    throw new Error('invalid acknowledgedWorkRisk');
  return { projectId, generation: request.generation, acknowledgedWorkRisk: request.acknowledgedWorkRisk };
}
export type Handler<C extends IpcChannelName> = (services: Services, req: IpcRequest<C>, event?: Electron.IpcMainInvokeEvent) => Promise<IpcResponse<C>>;
type SendEvent = <E extends IpcEventName>(channel: E, payload: IpcEvents[E]) => void;

const HEADLESS_ENGINES: ReadonlySet<string> = new Set(['codex', 'gemini', 'ollama']);

/** The group-chat service, or a clear error before startup has installed it. */
function groupChat(s: Services): NonNullable<Services['groupChat']> {
  if (!s.groupChat) throw new Error('group chats are not ready yet');
  return s.groupChat;
}

/** Keep-alive eviction skips Claude tabs that are members of a running group chat. */
function inRunningGroupChat(s: Services): (sh: { projectId: number; shellIndex: number }) => boolean {
  const kept = s.groupChat?.protectedShells() ?? [];
  return (sh) => kept.some((p) => p.projectId === sh.projectId && p.shellIndex === sh.shellIndex);
}


/**
 * Merges project-scoped CLI profiles with the global defaults, deduping by
 * name (project entries win). Empty project arrays fall all the way through
 * to the global list, so users on a brand-new project still see Claude.
 */
export function mergedCliProfiles(
  projectProfiles: Array<{ name: string; argv: string[]; env?: Record<string, string>; icon?: string }> | null,
  globalProfiles: Array<{ name: string; argv: string[]; env?: Record<string, string>; icon?: string }>,
): Array<{ name: string; argv: string[]; env?: Record<string, string>; icon?: string }> {
  const list = projectProfiles ?? [];
  if (list.length === 0) return globalProfiles;
  const names = new Set(list.map(p => p.name));
  return [...list, ...globalProfiles.filter(p => !names.has(p.name))];
}

/**
 * Pre-flight for every shell-launch IPC: the project's folder must exist on
 * disk, otherwise node-pty's spawn would fail with ENOENT on cwd and the
 * terminal used to end up as a silent blank cursor. Throwing here lets the
 * renderer surface a specific, actionable message instead ("Project folder
 * no longer exists at /path — remove it from the sidebar?").
 */
function assertProjectPathExists(project: { id: number; name: string; path: string }): void {
  if (!existsSync(project.path)) {
    throw new Error(`Project folder no longer exists at ${project.path} — remove the project from the sidebar or restore the folder.`);
  }
}

function hasLiveShell(s: Services, projectId: number): boolean {
  return s.ptyManager.liveShells().some((shell) => shell.projectId === projectId);
}

export interface WindowHooks {
  createPopoutWindow: (projectId: number, shellIndex: number) => Promise<number>;
  returnPopoutWindow: (projectId: number, shellIndex: number) => boolean;
  listPopped: () => Array<{ projectId: number; shellIndex: number }>;
  tileAll: () => number;
  /** Applies the vibrancy material to every open window (no-op off darwin). */
  setVibrancy: (material: VibrancyMaterial) => void;
  onProjectOpen?: (event: Electron.IpcMainInvokeEvent, request: unknown) => void;
  onProjectAuthorityChanged?: () => void;
}

/** A file files:peek may read: its absolute path, the root it is displayed relative to, and that root's project (null when outside every project). */
interface PeekCandidate { abs: string; root: string | null; projectId: number | null }

/**
 * Candidate files for `files:peek`, in priority order. An absolute `relPath` yields itself, attributed to the project with
 * the longest root containing it; a relative one yields one candidate per project root that contains it, `projects` order
 * kept, and is never resolved against the process working directory.
 */
function peekCandidates(projects: ReadonlyArray<{ id: number; path: string }>, relPath: string): PeekCandidate[] {
  const roots = projects.map((p) => ({ projectId: p.id, root: resolve(p.path) }));
  if (isAbsolute(relPath)) {
    const abs = resolve(relPath);
    const owner = roots.filter((r) => isInsideRoot(r.root, abs)).sort((a, b) => b.root.length - a.root.length)[0];
    return [{ abs, root: owner?.root ?? null, projectId: owner?.projectId ?? null }];
  }
  return roots
    .map((r) => ({ ...r, abs: resolve(r.root, relPath) }))
    .filter((c) => isInsideRoot(c.root, c.abs));
}

/** Reads the head of a peek candidate, or returns null when it is missing, unreadable or a directory so the next candidate is tried. */
function peekFile({ abs, root, projectId }: PeekCandidate, maxLines: number): IpcResponse<'files:peek'> | null {
  try {
    const st = statSync(abs);
    if (st.isDirectory()) return null;
    const base = { relPath: root ? relative(root, abs) : abs, projectId, found: true, sizeBytes: st.size };
    if (st.size > 2_000_000) return { ...base, kind: 'text', head: `File too large (${st.size} bytes).`, totalLines: null };
    const buf = readFileSync(abs);
    if (buf.subarray(0, Math.min(4096, buf.length)).includes(0)) return { ...base, kind: 'binary', head: '', totalLines: null };
    const lines = buf.toString('utf8').split(/\r?\n/);
    return { ...base, kind: 'text', head: lines.slice(0, maxLines).join('\n'), totalLines: lines.length };
  } catch {
    return null;
  }
}

function p2pApi(s: Services): P2PApi {
  if (!s.p2p) throw new Error('p2p_not_started');
  return s.p2p.api;
}

/** Returns whether to publish settings:changed after this synchronous write. */
function setSetting(s: Services, { key, value }: IpcRequest<'settings:set'>): boolean {
  if (typeof key !== 'string') throw new Error('Invalid settings key');
  if (isManagedMetaprojectSetting(key)) throw new Error('Use Metaproject Settings to change the service');
  if (key === TERMINAL_ENGINE_KEY) {
    if (!isTerminalEngine(value)) throw new Error('Invalid terminal engine');
    if (s.settings.get(key) === value) return false;
    s.settings.set(key, value);
    return true;
  }
  if (isTerminalPaddingKey(key)) {
    if (!isTerminalPaddingValue(value)) throw new Error('Invalid terminal padding');
    if (s.settings.get(key) === value) return false;
    s.settings.set(key, value);
    return true;
  }
  if (key === TERMINAL_FROST_OPACITY_KEY) {
    if (!isTerminalFrostOpacity(value)) throw new Error('Invalid terminal frost opacity');
    if (s.settings.get(key) === value) return false;
    s.settings.set(key, value);
    return true;
  }
  // Permission mode and font preferences have dedicated validated setters.
  if (key === 'claude_permission_mode') throw new Error('claude_permission_mode can only be changed via settings:set-claude-permission-mode');
  if (isFontSettingKey(key)) throw new Error(`${key} can only be changed via settings:set-font`);
  if (key === TERMINAL_FONT_SIZE_KEY) throw new Error(`${key} can only be changed via settings:set-terminal-font-size`);
  if (key === TERMINAL_FONT_WEIGHT_KEY) throw new Error(`${key} can only be changed via settings:set-terminal-font-weight`);
  if (key === TERMINAL_BOLD_WEIGHT_KEY) throw new Error(`${key} can only be changed via settings:set-terminal-bold-weight`);
  if (key === 'app_env') throw new Error('app_env can only be changed via settings:set-app-env');
  // Legacy key: read only by the terminal_frost_level migration, never written again (D19).
  if ((key as string) === 'frost_terminal') throw new Error('frost_terminal is a legacy key; use settings:set-terminal-frost-level');
  if (key === 'frost_chrome') throw new Error('frost_chrome can only be changed via settings:set-frost-chrome');
  if (key === 'chrome_frost_level') throw new Error('chrome_frost_level can only be changed via settings:set-chrome-frost-level');
  if (key === 'terminal_frost_level') throw new Error('terminal_frost_level can only be changed via settings:set-terminal-frost-level');
  if (key === 'vibrancy_material') throw new Error('vibrancy_material can only be changed via settings:set-vibrancy-material');
  s.settings.set(key, value as never);
  return true;
}

/** Exported so the P2P hub can call the same implementations directly (no ipcMain round-trip). */
type CoreChannel = Exclude<IpcChannelName, `metaproject:${string}`>;

export const handlers: { [C in Exclude<CoreChannel, 'shells:snapshot' | 'settings:set'>]: Handler<C> } = {
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
      s.projects.upsert(root.id, disc.path, disc.name);
    }
    return { root };
  },
  'roots:remove': async (s, { id }) => { s.roots.remove(id); return { ok: true } as const; },
  'roots:rescan': async (s, { id }) => {
    const root = s.roots.list().find(r => r.id === id);
    if (!root) return { discovered: 0 };
    let n = 0;
    for (const disc of discoverProjects(root.path, s.settings.get('scan_depth'))) {
      s.projects.upsert(root.id, disc.path, disc.name); n++;
    }
    pruneMissingProjects({ projects: s.projects, hasLiveShell: (id) => hasLiveShell(s, id) }, root);
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
        const r = await runGitCommand(path, ['init', '-q', path]);
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
    const r = await runGitCommand(root.path, ['clone', '--', url, path]);
    if (r.status !== 0) throw gitCommandError(r, 'git clone failed');
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
          s.projects.upsert(root.id, disc.path, disc.name);
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

  'shells:launch': async (s, { projectId, forceFirst }) => {
    // Defence in depth behind the renderer's blocking modal: never spawn
    // Claude in Manual mode (the local, un-rewritten default) before the
    // user has made an explicit permission-mode choice.
    if (s.settings.get('claude_permission_mode') === null) throw new Error('Choose a Claude permission mode first');
    const projectRow = s.projects.get(projectId);
    if (!projectRow) throw new Error(`no project ${projectId}`);
    // forceFirst bypasses --continue and starts a brand-new session (used by
    // "Start fresh Claude session" and the corrupted-session overlay). Earlier
    // sessions stay on disk untouched: plain `claude` never resumes one, and
    // `claude --resume` must still be able to list them.
    const project = forceFirst ? { ...projectRow, firstLaunchedAt: null } : projectRow;
    // Coalesce concurrent launches for the same slot: the `isAlive` check
    // below is synchronous, but the `spawn` it fronts is awaited, so a
    // second IPC arriving in that gap used to trip "already spawned: N:0"
    // from the PTY manager's single-entry guard.
    return SHELLS_LAUNCH_COALESCER.run(launchKey(projectId, 0), () => doShellsLaunch(s, project));
  },
  'shells:launch-plain': async (s, { projectId }) => {
    const project = s.projects.get(projectId);
    if (!project) throw new Error(`no project ${projectId}`);
    assertProjectPathExists(project);
    const used = new Set(s.shells.list().filter(r => r.projectId === projectId).map(r => r.shellIndex));
    let idx = 1;
    while (used.has(idx)) idx++;
    // Respect the alive cap the same way the primary launch does.
    const cap = s.settings.get('keep_alive_cap');
    const alive = s.shells.list();
    if (alive.length >= cap) {
      const decision = chooseEvictee(alive, cap, projectId, new Date(), inRunningGroupChat(s));
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
    assertProjectPathExists(project);
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
      const decision = chooseEvictee(alive, cap, projectId, new Date(), inRunningGroupChat(s));
      if (decision.evictee) {
        await s.ptyManager.kill(decision.evictee.projectId, decision.evictee.shellIndex);
        s.shells.remove(decision.evictee.projectId, decision.evictee.shellIndex);
      } else if (decision.reason === 'all-pinned') {
        throw new Error('all shells are pinned — unpin one or raise cap');
      }
    }
    // A saved profile continues its harness's last session here; a one-off inline command starts fresh.
    const launchArgv = argv && argv.length > 0
      ? resolvedArgv
      : profileLaunchArgv(project, resolvedArgv, 'subsequent', (harness) => harnessBusy(s, projectId, harness, idx));
    const launch = {
      argv: launchArgv,
      cwd: project.path,
      env: projectSpawnEnv(s, project, resolvedEnv),
      variant: 'first' as const,
    };
    await s.ptyManager.spawn(projectId, idx, launch);
    rememberResumable(s, projectId, launch.argv);
    const now = new Date();
    const nowIso = `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}-${String(now.getUTCDate()).padStart(2,'0')} ${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}:${String(now.getUTCSeconds()).padStart(2,'0')}`;
    s.shells.upsert({ projectId, shellIndex: idx, model: null, launchArgv: launch.argv, startedAt: nowIso, lastActiveAt: nowIso, pinned: false });
    return { shellIndex: idx };
  },
  'shells:cli-profiles-list': async (s, { projectId }) => {
    const project = s.projects.get(projectId);
    if (!project) throw new Error(`no project ${projectId}`);
    const projectProfiles = project.config.cliProfiles ?? [];
    // `.metaide/cli-profiles.json` — shared project convention; sits between
    // the per-user project settings (above) and the global catalog (below).
    const metaIdeProfiles = readMetaIdeCliProfiles(project.path);
    const globalProfiles = s.settings.get('default_cli_profiles');
    const projectNames = new Set(projectProfiles.map(p => p.name));
    const projectAndMeta = new Set([...projectProfiles, ...metaIdeProfiles].map(p => p.name));
    const flat = [
      ...projectProfiles.map(p => ({ ...p, scope: 'project' as const })),
      ...metaIdeProfiles.filter(p => !projectNames.has(p.name)).map(p => ({ ...p, scope: 'project' as const })),
      ...globalProfiles.filter(p => !projectAndMeta.has(p.name)).map(p => ({ ...p, scope: 'global' as const })),
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
  'shells:set-default-cli': async (s, request) => {
    const parsed = parseProjectDefaultAgent(request);
    if (!parsed.ok) throw new Error(parsed.error);
    const result = setProjectDefaultAgent(s, parsed.value);
    if (!result.ok) throw new Error(result.error);
    return { project: result.project };
  },
  'shells:kill':   async (s, { projectId, shellIndex }) => { await s.ptyManager.kill(projectId, shellIndex); s.shells.remove(projectId, shellIndex); return { ok: true } as const; },
  'shells:inspect-primary': async (s, request) => {
    const projectId = primaryProjectId(request);
    const live = s.ptyManager.liveShell(projectId, 0);
    if (!live) return { kind: 'gone' };
    if (!s.agentStatus) throw new Error('agent status not installed');
    const status = s.agentStatus.readForGuard(projectId, 0, live.generation);
    return { kind: 'live', generation: live.generation, ...status };
  },
  'shells:stop-primary': async (s, request) => {
    const { projectId, generation, acknowledgedWorkRisk } = stopPrimaryRequest(request);
    const live = s.ptyManager.liveShell(projectId, 0);
    if (!live) return { kind: 'gone' };
    if (live.generation !== generation) return { kind: 'replaced' };
    if (!s.agentStatus) throw new Error('agent status not installed');
    const { state } = s.agentStatus.readForGuard(projectId, 0, generation);
    if (!acknowledgedWorkRisk && (state === 'busy' || state === 'blocked'))
      return { kind: 'escalated' };
    const kind = s.ptyManager.stopIfGeneration(projectId, generation);
    if (kind === 'stopped') s.shells.remove(projectId, 0);
    return { kind };
  },
  /**
   * Repair a corrupted Claude session: find the project's session dir
   * (`~/.claude/projects/<encoded-path>/`), locate the most recently
   * modified .jsonl file (the one `--continue` would resume), back it up,
   * then stream-rewrite it with every `type: "thinking"` content block
   * removed. Fixes the "invalid signature in thinking block" API error.
   */
  'claude:repair-session': async (s, { projectId }) => {
    const project = s.projects.get(projectId);
    if (!project) throw new Error(`no project ${projectId}`);
    // Claude encodes paths by replacing `/` and ` ` with `-`.
    const encoded = project.path.replace(/[/ ]/g, '-');
    const sessionDir = join(s.homeDir, '.claude', 'projects', encoded);
    if (!existsSync(sessionDir)) {
      return { repaired: 0, blocksStripped: 0, backup: null, reason: `no Claude session dir at ${sessionDir}` } as const;
    }
    const files = readdirSync(sessionDir)
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => ({ name: n, mtime: statSync(join(sessionDir, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) {
      return { repaired: 0, blocksStripped: 0, backup: null, reason: 'no .jsonl session files found' } as const;
    }
    // Repair all session files whose most-recent content is from the same
    // day as the newest one. Claude's --continue picks the newest, but a
    // bad message can live in any of them if the user switched sessions.
    // We play it safe: only touch the single newest file by default.
    const target = files[0]!;
    const targetPath = join(sessionDir, target.name);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${targetPath}.corrupted-${timestamp}`;
    const raw = readFileSync(targetPath, 'utf8');
    const lines = raw.split('\n');
    let blocksStripped = 0;
    const repaired = lines.map((ln) => {
      if (!ln.trim()) return ln;
      try {
        const d = JSON.parse(ln);
        const content = d?.message?.content;
        if (Array.isArray(content)) {
          const kept = content.filter((b: { type?: string }) => {
            if (b?.type === 'thinking') { blocksStripped++; return false; }
            return true;
          });
          if (kept.length !== content.length) {
            d.message.content = kept;
            return JSON.stringify(d);
          }
        }
        return ln;
      } catch {
        // Non-JSON or malformed line — leave untouched.
        return ln;
      }
    });
    // Write backup first, THEN overwrite the original — if the backup
    // write fails we haven't corrupted the user's data.
    writeFileSync(backupPath, raw, 'utf8');
    writeFileSync(targetPath, repaired.join('\n'), 'utf8');
    return { repaired: 1, blocksStripped, backup: backupPath } as const;
  },
  'shells:resize': async (s, { projectId, shellIndex, cols, rows }) => {
    s.ptyManager.resize(projectId, shellIndex, cols, rows);
    return { ok: true } as const;
  },
  'shells:write':  async (s, { projectId, shellIndex, data }) => { s.ptyManager.write(projectId, shellIndex, data); s.shells.touch(projectId, shellIndex, new Date()); return { ok: true } as const; },
  'agent-state:list': async (s) => {
    if (!s.agentStatus) throw new Error('agent status not installed');
    return { shells: s.agentStatus.list() };
  },
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
    // Async so a `ps` slowed by agent load never stalls the main process; a non-zero exit rejects, giving no stats.
    let statsByPid: Record<number, { cpu: number; rssKb: number }> = {};
    try {
      const r = await execFileAsync('ps', ['-o', 'pid=,%cpu=,rss=', '-p', pids], { encoding: 'utf8', timeout: 3000 });
      for (const line of r.stdout.trim().split('\n')) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 3) continue;
        const pid = Number(cols[0]); const cpu = Number(cols[1]); const rss = Number(cols[2]);
        if (Number.isFinite(pid)) statsByPid[pid] = { cpu: Number.isFinite(cpu) ? cpu : 0, rssKb: Number.isFinite(rss) ? rss : 0 };
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

  'settings:get': async (s, { key }) => {
    if (isManagedMetaprojectSetting(key) && key !== 'metaproject_base_url') throw new Error('Private Metaproject setting');
    return { value: s.settings.get(key) };
  },
  'settings:set-font': async (s, request) => {
    if (!isFontSettingKey(request.key)) throw new Error('invalid font setting key');
    const parsed = parseFontFamilyPreference(request.value);
    if (!parsed.ok) throw new Error(parsed.error);
    s.settings.set(request.key, parsed.value);
    return { value: parsed.value };
  },
  'settings:set-terminal-font-size': async (s, request) => {
    const parsed = parseTerminalFontSize(request.value);
    if (!parsed.ok) throw new Error(parsed.error);
    const stored = s.settings.get(TERMINAL_FONT_SIZE_KEY);
    if (request.onlyIfUnset === true && stored !== null) {
      return { value: stored, changed: false };
    }
    s.settings.set(TERMINAL_FONT_SIZE_KEY, parsed.value);
    return { value: parsed.value, changed: true };
  },
  // Parses W, derives B = derivedBoldWeight(W) itself (never trusts a renderer-sent B), and
  // writes only the keys whose stored value actually differs through one setMany transaction,
  // so a write failure leaves neither key changed (AC8). changedKeys drives the per-key emit.
  'settings:set-terminal-font-weight': async (s, request) => {
    const parsed = parseTerminalFontWeight(request.value);
    if (!parsed.ok) throw new Error(parsed.error);
    const weight = parsed.value;
    const boldWeight = derivedBoldWeight(weight);
    const entries: Partial<SettingsMap> = {};
    const changedKeys: Array<keyof SettingsMap> = [];
    if (s.settings.get(TERMINAL_FONT_WEIGHT_KEY) !== weight) {
      entries[TERMINAL_FONT_WEIGHT_KEY] = weight;
      changedKeys.push(TERMINAL_FONT_WEIGHT_KEY);
    }
    if (s.settings.get(TERMINAL_BOLD_WEIGHT_KEY) !== boldWeight) {
      entries[TERMINAL_BOLD_WEIGHT_KEY] = boldWeight;
      changedKeys.push(TERMINAL_BOLD_WEIGHT_KEY);
    }
    if (changedKeys.length > 0) s.settings.setMany(entries);
    return { weight, boldWeight, changedKeys };
  },
  // Validates B against the font weight in use (resolveTerminalWeights on the stored pair, so a
  // null or invalid stored weight counts as 400) and never writes the stored font weight itself.
  'settings:set-terminal-bold-weight': async (s, request) => {
    const parsed = parseTerminalFontWeight(request.value);
    if (!parsed.ok) throw new Error(parsed.error);
    const bold = parsed.value;
    const { weight } = resolveTerminalWeights(s.settings.get(TERMINAL_FONT_WEIGHT_KEY), s.settings.get(TERMINAL_BOLD_WEIGHT_KEY));
    if (!isValidBoldWeight(weight, bold)) throw new Error(`terminal bold weight must be heavier than the font weight in use (${weight})`);
    const stored = s.settings.get(TERMINAL_BOLD_WEIGHT_KEY);
    if (stored === bold) return { value: bold, changed: false };
    s.settings.set(TERMINAL_BOLD_WEIGHT_KEY, bold);
    return { value: bold, changed: true };
  },
  'settings:set-app-env': async (s, { env }) => {
    const parsed = parseAppEnv(env);
    if (!parsed.ok) throw new Error(parsed.error);
    s.settings.set('app_env', parsed.env);
    return { env: parsed.env };
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

  // Renderer-supplied view data: validated here; a forged view can at worst hold back the user's own fleet notices.
  'p2p:viewing': async (s, req) => {
    s.remoteViewing?.set(parseRemoteViewing(req));
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

  'bind-prompt:status': async (s, { projectId }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    return { shouldPrompt: !isBindSkipped(p.path), folderName: folderNameFor(p.path) };
  },
  'bind-prompt:skip': async (s, { projectId }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    recordBindSkip(p.path);
    return { ok: true } as const;
  },

  'feedback:submit': async (_s, req) => {
    const title = (req.title ?? '').toString().trim();
    if (!title) throw new Error('title is required');
    if (req.type !== 'bug' && req.type !== 'idea') throw new Error('type must be bug or idea');
    const result = submitReport({
      type: req.type,
      title,
      description: (req.description ?? '').toString(),
      source: { kind: 'user' },
      context: {
        appVersion: app.getVersion(),
        osPlatform: process.platform,
        osRelease: osRelease(),
        terminalEngine: req.terminalEngine ?? 'unknown',
        composedAt: new Date().toISOString(),
      },
    }, {});
    return {
      ok: result.ok,
      message: result.message,
      markdown: result.submitted?.markdown,
      boardUrl: result.submitted?.boardUrl ?? null,
    };
  },

  /**
   * Resolve a `file://` URL (or absolute path) against every known project
   * root. Used by the shell's OSC-8 link handler to prefer opening a local
   * file in the IDE's Files tab (with its HTML preview / image viewer /
   * markdown render) over launching the system browser, where relative
   * assets break because the browser's base path is wrong. Returns null
   * when the path doesn't lie inside any project root.
   */
  'app:resolve-local-file': async (s, { url }) => {
    let abs: string;
    try {
      if (url.startsWith('file://')) abs = fileURLToPath(url);
      else if (url.startsWith('/')) abs = url;
      else return { match: null } as const;
    } catch { return { match: null } as const; }
    for (const p of s.projects.list()) {
      if (isInsideRoot(p.path, abs)) {
        const rel = relative(p.path, abs);
        return { match: { projectId: p.id, relPath: rel.split(/[/\\]/).join('/') } } as const;
      }
    }
    return { match: null } as const;
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

  'window:toggle-fullscreen': async (_s, _req, event) => {
    const w = event ? BrowserWindow.fromWebContents(event.sender) : BrowserWindow.getFocusedWindow();
    if (!w || w.isDestroyed()) return { fullscreen: false } as const;
    const next = !w.isFullScreen();
    w.setFullScreen(next);
    return { fullscreen: next } as const;
  },

  'settings:set-frost-chrome': async (s, { enabled }) => {
    if (typeof enabled !== 'boolean') return { ok: false, error: 'invalid' } as const;
    s.settings.set('frost_chrome', enabled);
    return { ok: true } as const;
  },
  'settings:set-chrome-frost-level': async (s, { level }) => {
    if (!isChromeFrostLevel(level)) return { ok: false, error: 'invalid' } as const;
    s.settings.set('chrome_frost_level', level);
    return { ok: true } as const;
  },
  'settings:set-terminal-frost-level': async (s, { level }) => {
    if (!isTerminalFrostMode(level)) return { ok: false, error: 'invalid' } as const;
    s.settings.set('terminal_frost_level', level);
    return { ok: true } as const;
  },
  'settings:set-vibrancy-material': async (s, { material }) => {
    if (!isVibrancyMaterial(material)) return { ok: false, error: 'invalid' } as const;
    s.settings.set('vibrancy_material', material);
    return { ok: true } as const;
  },

  // metaproject chat handlers moved to src/main/metaproject/ipc-handlers.ts as part of PR #16.
  // Credential store + auto-login are now owned by the shared session service in that module.


  'files:tree':   async (s, { projectId, relPath }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const abs = resolveInsideRoot(p.path, relPath ?? '');
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
    const abs = resolveInsideRoot(p.path, relPath);
    // The temp file sits beside the target, so the root as target would put it outside the project.
    if (abs === resolve(p.path)) throw new Error('refusing to write to project root');
    // Atomic write via a sibling temp file then rename — protects against
    // partial writes if the process dies mid-flush.
    const tmp = `${abs}.metaide-tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, content, 'utf8');
    try {
      renameSync(tmp, abs);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    const st = statSync(abs);
    return { ok: true as const, sizeBytes: st.size };
  },

  'files:mkdir':  async (s, { projectId, relPath }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const abs = resolveInsideRoot(p.path, relPath);
    if (existsSync(abs)) throw new Error(`already exists: ${relPath}`);
    mkdirSync(abs, { recursive: true });
    return { ok: true as const };
  },

  'files:rename': async (s, { projectId, from, to }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const root = resolve(p.path);
    const src = resolveInsideRoot(root, from);
    const dst = resolveInsideRoot(root, to);
    if (!existsSync(src)) throw new Error(`no such file: ${from}`);
    if (existsSync(dst)) throw new Error(`target exists: ${to}`);
    renameSync(src, dst);
    return { ok: true as const };
  },

  'files:delete': async (s, { projectId, relPath }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const abs = resolveInsideRoot(p.path, relPath);
    if (abs === resolve(p.path)) throw new Error('refusing to delete project root');
    if (!existsSync(abs)) return { ok: true as const };
    rmSync(abs, { recursive: true, force: true });
    return { ok: true as const };
  },

  'files:peek':   async (s, { projectId, relPath, maxLines = 40 }) => {
    const cur = s.projects.get(projectId);
    if (!cur) throw new Error(`no project ${projectId}`);
    const projects = [cur, ...s.projects.list().filter((p) => p.id !== projectId)];
    for (const candidate of peekCandidates(projects, relPath)) {
      const res = peekFile(candidate, maxLines);
      if (res) return res;
    }
    return { relPath, projectId: null, found: false, kind: 'text' as const, head: '', sizeBytes: 0, totalLines: null };
  },

  'files:reveal': async (s, { projectId, relPath }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const abs = resolveInsideRoot(p.path, relPath);
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
    const r = await runGit(p.path, ['status', '--porcelain=v1', '--branch', '--untracked-files=all'], { maxBuffer: GIT_DIFF_MAX_BYTES, timeout: 5000 });
    if (r.status !== 0) {
      return { isRepo: true, branch: null, ahead: 0, behind: 0, files: {}, dirty: false };
    }
    const parsed = parseGitStatus(r.stdout.toString('utf8'));
    return { isRepo: true, ...parsed, dirty: Object.keys(parsed.files).length > 0 };
  },
  'git:panel-status': async (s, { projectId }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const empty = { branch: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] };
    if (!existsSync(join(p.path, '.git'))) return { isRepo: false, ...empty };
    const r = await runGit(p.path, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'], { maxBuffer: GIT_DIFF_MAX_BYTES, timeout: 5000 });
    if (r.status !== 0 || r.tooLarge || r.timedOut) {
      const error = describeGitFailure(r, 'status');
      // panel-status polls on every file-tree change, so one broken repo
      // used to warn dozens of times. Dedup by (projectId, status, error).
      const sig = `${projectId}|${r.status}|${error}`;
      if (!gitPanelStatusWarnSeen.has(sig)) {
        gitPanelStatusWarnSeen.add(sig);
        log.warn('[git:panel-status] git status failed', { projectId, status: r.status, error });
      }
      return { isRepo: true, ...empty, error };
    }
    return { isRepo: true, ...parseGitPanelStatus(r.stdout.toString('utf8')) };
  },
  'git:stage':   async (s, { projectId, paths }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    if (paths.length === 0) return { ok: true } as const;
    const r = await runGitCommand(p.path, ['add', '--', ...paths], { timeout: 15000 });
    if (r.status !== 0) throw gitCommandError(r, 'git add failed');
    return { ok: true } as const;
  },
  'git:unstage': async (s, { projectId, paths }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    if (paths.length === 0) return { ok: true } as const;
    // `git restore --staged` is the modern equivalent of `git reset HEAD --`.
    const r = await runGitCommand(p.path, ['restore', '--staged', '--', ...paths], { timeout: 15000 });
    if (r.status !== 0) throw gitCommandError(r, 'git unstage failed');
    return { ok: true } as const;
  },
  'git:commit':  async (s, { projectId, message }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    if (!message.trim()) throw new Error('commit message is empty');
    // Pass the message via `-F -` on stdin so we never worry about shell
    // quoting on multi-line messages or embedded backticks/dollars.
    const r = await runGitCommand(p.path, ['commit', '-F', '-'], { timeout: 30000, input: message });
    if (r.status !== 0) throw gitCommandError(r, 'git commit failed');
    return { ok: true } as const;
  },
  'git:push':    async (s, { projectId }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const r = await runGitCommand(p.path, ['push'], { timeout: 60000 });
    if (r.status !== 0) throw gitCommandError(r, 'git push failed');
    return { ok: true, output: (r.stdout + r.stderr).trim() } as const;
  },
  'git:pull':    async (s, { projectId }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const r = await runGitCommand(p.path, ['pull'], { timeout: 60000 });
    if (r.status !== 0) throw gitCommandError(r, 'git pull failed');
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

  /* ─── P2P (fleet) — implementations live behind Services.p2p.api, attached by startP2P ─── */
  'p2p:fleet-list':         async (s) => ({ fleet: s.p2p ? await s.p2p.api.fleetList() : [] }),
  'p2p:settings-get':       async (s) => p2pApi(s).getSettings(),
  'p2p:settings-set':       async (s, patch) => { await p2pApi(s).setSettings(patch); return { ok: true } as const; },
  'p2p:pair-generate-code': async (s) => waitForPairCode(s),
  'p2p:pair-redeem-code':   async (s, { code }) => p2pApi(s).redeemPairCode(code),
  'p2p:revoke-device':      async (s, { deviceId }) => { await p2pApi(s).revokeDevice(deviceId); return { ok: true } as const; },
  'p2p:set-workspace-access': async (s, { deviceId, allowed }) => {
    await p2pApi(s).setWorkspaceAccess(deviceId, allowed);
    return { ok: true } as const;
  },
  'p2p:reconnect-device':   async (s, { deviceId }) => { await p2pApi(s).reconnectDevice(deviceId); return { ok: true } as const; },
  'p2p:rpc-call':           async (s, { deviceId, method, params }) => ({ result: await p2pApi(s).rpcCall(deviceId, method, params ?? {}) }),
  'p2p:rpc-close-stream':   async (s, { streamId }) => { p2pApi(s).rpcCloseStream(streamId); return { ok: true } as const; },
  'p2p:upload':             async (s, req) => (s.p2p ? s.p2p.api.upload(req) : { kind: 'failed', reason: 'p2p_not_started' }),
  'p2p:upload-cancel':      async (s, req) => { if (typeof req?.uploadId === 'string') s.p2p?.api.cancelUpload(req.uploadId); return { ok: true } as const; },

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

  /* ─── Group chats ─── */
  'groups:list':          async (s, { projectId }) => ({ groups: groupChat(s).list(projectId) }),
  'groups:create':        async (s, { projectId, name, claudeShell }) => {
    const svc = groupChat(s);
    const group = svc.create(projectId, { name, claudeShell });
    if (!claudeShell || Object.values(group.memberInfo).some((m) => m.engine === 'claude')) return { group };
    // the tab in view didn't join: say why instead of leaving the user guessing
    const tab = svc.joinableClaudeTabs(projectId).find((t) => t.shellIndex === claudeShell.shellIndex);
    const notice = tab?.why
      ? `Your Claude tab couldn’t join yet: ${tab.why}, then use + Add.`
      : 'The tab in view isn’t running Claude, so it wasn’t added. Use + Add once a Claude tab is running.';
    return { group, notice };
  },
  'groups:update':        async (s, { id, name, maxRounds }) => ({ group: groupChat(s).update(id, { name, maxRounds }) }),
  'groups:add-claude':    async (s, { id, shell }) => ({ group: groupChat(s).addClaudeTab(id, shell) }),
  'groups:add-headless':  async (s, { id, engine, name, model }) => {
    if (!HEADLESS_ENGINES.has(engine)) throw new Error(`unknown engine: ${String(engine)}`);
    return { group: groupChat(s).addHeadless(id, { engine, name, model }) };
  },
  'groups:reconnect-claude': async (s, { id, member }) => ({ group: groupChat(s).reconnectClaude(id, member) }),
  'groups:remove-member': async (s, { id, member }) => ({ group: groupChat(s).removeMember(id, member) }),
  'groups:say':           async (s, { id, text }) => {
    if (typeof text !== 'string' || !text.trim()) throw new Error('the message is empty');
    return { group: groupChat(s).say(id, text) };
  },
  'groups:stop':          async (s, { id }) => ({ group: groupChat(s).stop(id) }),
  'groups:delete':        async (s, { id }) => { groupChat(s).remove(id); return { ok: true } as const; },
  'groups:joinable':      async (s, { projectId, id }) => ({ tabs: groupChat(s).joinableClaudeTabs(projectId, id) }),
  'groups:engines':       async (s) => groupChat(s).engineStatus(),

  /* ─── Task runner ─── */
  'tasks:discover': async (s, { projectId }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    return discoverProjectTasks(s, p);
  },
  'tasks:run': async (s, { projectId, taskId }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const task = (await discoverProjectTasks(s, p)).tasks.find(t => t.id === taskId);
    if (!task) throw new Error(`no task ${taskId}`);
    // Reuse the same shell-slot policy the plain launcher uses.
    const used = new Set(s.shells.list().filter(r => r.projectId === projectId).map(r => r.shellIndex));
    let idx = 0;
    while (used.has(idx)) idx++;
    const cap = s.settings.get('keep_alive_cap');
    const alive = s.shells.list();
    if (alive.length >= cap) {
      const decision = chooseEvictee(alive, cap, projectId, new Date(), inRunningGroupChat(s));
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

  /* ─── Diff tab: side-by-side data ─── */
  'git:diff-sides': async (s, { projectId, kind, path, origPath, ifDiffHashNot }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    if (!GIT_DIFF_KINDS.has(kind)) throw new Error(`invalid diff kind ${String(kind)}`);
    if (!existsSync(join(p.path, '.git'))) throw new Error(`${p.path} is not a git repository`);
    return readDiffSides(p.path, { kind, path, origPath, ifDiffHashNot });
  },

  /* ─── Per-file git diff ─── */
  'git:file-diff': async (s, { projectId, path, origPath, staged, untracked }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    if (!existsSync(join(p.path, '.git'))) return { diff: '' };
    return readFileDiff(p.path, { path, origPath, staged, untracked });
  },

  /* ─── AI diff explainer / commit-message drafter ─── */
  'diff:explain': async (s, { projectId, kind, diff, newPath, oldPath, cacheHash }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    if (kind !== 'explain' && kind !== 'commit') throw new Error(`invalid kind ${String(kind)}`);
    if (typeof diff !== 'string' || diff.length === 0) {
      return { status: 'error' as const, message: 'Nothing to explain — the diff is empty.' };
    }
    return explainDiff({
      projectId,
      projectPath: p.path,
      kind,
      diff,
      newPath,
      oldPath,
      cacheHash,
    });
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
    const abs = resolveInsideRoot(p.path, relPath);
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

  'files:read-bytes': async (s, { projectId, relPath }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const abs = resolveInsideRoot(p.path, relPath);
    const st = statSync(abs);
    if (st.isDirectory()) throw new Error(`${relPath} is a directory`);
    if (st.size > 50_000_000) throw new Error(`file too large (${st.size} bytes) — 50 MB cap`);
    const buf = readFileSync(abs);
    // Must OWN a fresh ArrayBuffer sized to the file — a view over Node's
    // shared Buffer pool (readFileSync returns one; byteOffset is often
    // non-zero) can survive Electron's structured clone with the pool's
    // extra bytes preserved, and the renderer's Blob then draws broken
    // images. Copy once at offset 0 to decouple from the pool.
    const bytes = new Uint8Array(buf.byteLength);
    bytes.set(buf);
    const ext = relPath.slice(relPath.lastIndexOf('.') + 1).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
    return { bytes, mime, sizeBytes: st.size };
  },

  'activity:list': async (s, { projectId, limit }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const cap = Math.max(1, Math.min(ACTIVITY_PAGE_MAX, limit ?? 100));
    const entries = readRecentActivity(p.path, cap);
    return { entries };
  },

  'story:list': async (s, { projectId }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    return { chunks: listStoryChunks(p.path) };
  },
  'story:read': async (s, { projectId, file }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    return { html: readStoryHtml(p.path, file) };
  },
  'story:generate': async (s, { projectId, windowMinutes }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const { chunk } = await generateStoryChunkAI({
      projectPath: p.path,
      projectName: p.name,
      // Default to 'auto' — the picker walks a ladder from 15 min out to 7
      // days until it finds a window with enough signal to narrate. A
      // caller can still pin a specific number of minutes.
      windowMinutes: windowMinutes ?? 'auto',
    });
    // Tell every open renderer the chunk list changed so the left column refreshes.
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('story:changed', { projectId });
    }
    return { chunk };
  },

  'story:features:list': async (s, { projectId }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    return {
      features: readFeatures(p.path),
      lastRefresh: newestEntryMtime(p.path),
    };
  },
  'story:features:refresh': async (s, { projectId }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const result = await refreshFeatures({
      projectPath: p.path,
      projectName: p.name,
      // Stream entries to the UI as they land — long refreshes don't
      // leave the user staring at a spinner.
      onEntry: (feature) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('story:features:changed', { projectId, feature });
        }
      },
    });
    // Signal batch end so the renderer drops its "refreshing…" state.
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('story:features:changed', { projectId, feature: null });
    }
    return { added: result.added, failed: result.failed };
  },
  'story:features:repo-url': async (s, { projectId }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { parseGithubRepoUrl } = await import('@shared/story-ref-extract');
      const run = promisify(execFile);
      const { stdout } = await run('git', ['remote', 'get-url', 'origin'], { cwd: p.path });
      return { repoUrl: parseGithubRepoUrl(stdout.trim()) };
    } catch {
      return { repoUrl: null };
    }
  },
  'story:features:update': async (s, { projectId, id, title, body }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const existing = readFeature(p.path, id);
    if (!existing) throw new Error(`no feature entry ${id}`);
    const next = {
      ...existing,
      title: title ?? existing.title,
      body: body ?? existing.body,
      edited: true,
    };
    writeFeature(p.path, next);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('story:features:changed', { projectId, feature: next });
    }
    return { feature: next };
  },

  'chat:append': async (s, req) => {
    if (!s.chat) throw new Error('chat service not ready');
    return s.chat.append(req);
  },
  'chat:list': async (s, req) => {
    if (!s.chat) throw new Error('chat service not ready');
    return s.chat.list(req);
  },
  'chat:roster': async (s) => {
    const rows = s.chatRoster ? s.chatRoster() : [];
    // Ground truth for "is this row local?" — the renderer's P2P hook
    // returns '' when P2P is off, which is not the same canonical string
    // the main process tags local rows with. Return it explicitly so the
    // renderer doesn't leak a "·device" suffix on every local pill.
    return { rows, selfDevice: s.selfDevice ?? '' };
  },

  /**
   * Set or clear a shell's nickname. Nickname becomes the Roster label and
   * `@mention` string ("@frontend-dev" vs. "@claude#2"). Pass null or an
   * empty string to clear. Nickname is sanitized to [a-z0-9_-] (lowercased)
   * so mentions remain unambiguously parseable.
   */
  'shells:set-nickname': async (s, { projectId, shellIndex, nickname }) => {
    const current = { ...s.settings.get('shell_nicknames') };
    const key = `${projectId}:${shellIndex}`;
    const cleaned = (nickname ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    if (!cleaned) delete current[key];
    else current[key] = cleaned;
    s.settings.set('shell_nicknames', current);
    return { ok: true as const, nickname: cleaned || null };
  },

  /**
   * Manual re-onboard: writes the stanza if missing (idempotent) and
   * always fires the nudge, ignoring `chat_auto_onboard` — the user
   * explicitly asked for this one, so their earlier opt-out doesn't apply.
   */
  'chat:onboard-agent': async (s, { projectId, shellIndex, agent }) => {
    const project = s.projects.get(projectId);
    if (!project) throw new Error(`unknown project ${projectId}`);
    const res = ensureAgentStanza(project.path, agent);
    if (res.appended) log.info('[chat] onboarded agent (manual)', { cli: agent, file: res.file });
    try {
      // Hand nudgeAgentShell a narrow write-only shim rather than
      // s.ptyManager itself. Passing s.ptyManager as a value escapes it
      // past the shell-mutation static analyser, which then can't prove
      // the handler never calls .spawn/.kill. The shim only exposes
      // write(), which isn't a mutation, and the analyser is happy.
      nudgeAgentShell(
        { write: (p, si, d) => s.ptyManager.write(p, si, d) },
        projectId,
        shellIndex,
        buildOnboardingNudge(agent),
      );
      log.info('[chat] nudged agent (manual)', { cli: agent, shell: shellIndex });
    } catch (err) { log.warn('[chat] manual nudge failed', { err: String(err) }); }
    return { ok: true as const, appended: res.appended, file: res.file };
  },

  /**
   * Bootstrap list of every live agent intent for the given project.
   * Returns an empty list before the intent watcher has attached (early
   * startup) — the renderer handles that the same way as "no agent has
   * posted yet", so there's no need for a separate not-ready signal.
   */
  'intent:list': async (s, { projectId }) => {
    const updates = s.intent?.list(projectId) ?? [];
    return { updates };
  },

  ...dropHandlers,
  ...keepAwakeHandlers,
  'usage:get': async (s, req) => {
    s.usage ??= new UsageService(usageDepsFor(s.homeDir, process.env, usageDebugDir()));
    return s.usage.get(req?.force === true);
  },
};


/** Events broadcast after a channel's handler resolves; exported for the CHANNEL_EMITS guard test. */
export const CHANNEL_EMITS: Partial<Record<IpcChannelName, IpcEventName[]>> = {
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
  'shells:launch':  ['alive-shells:changed', 'projects:changed'],
  'shells:launch-plain': ['alive-shells:changed'],
  'tasks:run':           ['alive-shells:changed'],
  'shells:launch-cli':   ['alive-shells:changed', 'projects:changed'],
  'shells:cli-profiles-remove': ['projects:changed'],
  'shells:set-default-cli': ['projects:changed'],
  'projects:update-config': ['projects:changed'],
  'shells:kill':    ['alive-shells:changed'],
  'shells:stop-primary': ['alive-shells:changed'],
  'shells:pin':     ['alive-shells:changed'],
  'shells:set-nickname': ['alive-shells:changed'],
};

function eventPayload<E extends IpcEventName>(name: E): IpcEvents[E] {
  if (name === 'projects:changed') return { kind: 'updated' } as IpcEvents[E];
  return {} as IpcEvents[E];
}

let broadcastEvent: SendEvent | null = null;

const PROJECT_AUTHORITY_CHANNELS = new Set<CoreChannel>([
  'roots:add', 'roots:rescan', 'roots:remove', 'projects:open', 'projects:hide', 'projects:rename',
]);

/** Broadcast for in-process callers (p2p hub) that bypass the ipcMain wrapper's CHANNEL_EMITS. No-op before registerIpc. */
export function emitAliveShellsChanged(): void { broadcastEvent?.('alive-shells:changed', {}); }
export function emitProjectsChanged(): void { broadcastEvent?.('projects:changed', { kind: 'updated' }); }

function registerDesktopReplayIpc(ipcMain: IpcMain, services: Services, sendEvent: SendEvent): void {
  let position = 0;
  const pty = services.ptyManager;
  pty?.on('data', (event: Omit<IpcEvents['pty:data'], 'replayPosition'>) => {
    sendEvent('pty:data', { ...event, replayPosition: ++position });
  });

  ipcMain.handle('shells:snapshot', async (_event, { projectId, shellIndex }: IpcRequest<'shells:snapshot'>): Promise<IpcResponse<'shells:snapshot'>> => {
    const replayPosition = position;
    const dead = { output: '', alive: false, replayPosition };
    const generation = pty?.liveShell(projectId, shellIndex)?.generation;
    if (!pty || generation === undefined) return dead;
    // getSnapshot queues the existing parser barrier before yielding. Capture the IPC cut in the same turn.
    const output = await pty.getSnapshot(projectId, shellIndex);
    if (pty.liveShell(projectId, shellIndex)?.generation !== generation) return dead;
    return { output, alive: true, replayPosition };
  });
}

/** Registers IPC handlers and forwards PTY exits only when no newer generation owns the shell. */
export function registerIpc(ipcMain: IpcMain, services: Services, sendEvent: SendEvent, windowHooks?: WindowHooks): void {
  broadcastEvent = sendEvent;
  registerDesktopReplayIpc(ipcMain, services, sendEvent);
  if (services.ptyManager) {
    services.ptyManager.on('exit', (ev: IpcEvents['pty:exit'] & { generation: string }) => {
      const live = services.ptyManager.liveShell(ev.projectId, ev.shellIndex);
      if (live && live.generation !== ev.generation) return;
      services.shells?.remove(ev.projectId, ev.shellIndex);
      sendEvent('pty:exit', { projectId: ev.projectId, shellIndex: ev.shellIndex, code: ev.code });
      sendEvent('alive-shells:changed', {});
    });
  }

  const WINDOW_CHANNELS = new Set<IpcChannelName>(['windows:popout-shell', 'windows:return-shell', 'windows:list-popped', 'windows:tile-all', 'files:start-drag', 'app:renderer-ready-for-files']);
  // Wired separately below: these channels emit keyed `settings:changed`
  // events that the fixed per-channel payload cannot express.
  const CUSTOM_EMIT_CHANNELS: Partial<Record<IpcChannelName, true>> = {
    'settings:set-font': true,
    'settings:set-terminal-font-size': true,
    'settings:set-terminal-font-weight': true,
    'settings:set-terminal-bold-weight': true,
    'settings:set-app-env': true,
    'settings:set-claude-permission-mode': true,
    'settings:set-frost-chrome': true,
    'settings:set-chrome-frost-level': true,
    'settings:set-terminal-frost-level': true,
    'settings:set-vibrancy-material': true,
  };

  for (const channel of Object.keys(handlers) as (keyof typeof handlers)[]) {
    if (WINDOW_CHANNELS.has(channel) || CUSTOM_EMIT_CHANNELS[channel]) continue; // wired below
    ipcMain.handle(channel, async (event, req) => {
      if (channel === 'projects:open') windowHooks?.onProjectOpen?.(event, req);
      const fn = handlers[channel] as (s: Services, req: unknown, e?: Electron.IpcMainInvokeEvent) => Promise<unknown>;
      const result = await fn(services, req, event);
      if (PROJECT_AUTHORITY_CHANNELS.has(channel)) windowHooks?.onProjectAuthorityChanged?.();
      for (const evt of CHANNEL_EMITS[channel] ?? []) sendEvent(evt, eventPayload(evt));
      return result;
    });
  }

  ipcMain.handle('settings:set', async (_e, req: IpcRequest<'settings:set'>): Promise<IpcResponse<'settings:set'>> => {
    if (setSetting(services, req)) sendEvent('settings:changed', { key: req.key });
    return { ok: true };
  });

  ipcMain.handle('settings:set-font', async (_e, req: IpcRequest<'settings:set-font'>) => {
    const result = await handlers['settings:set-font'](services, req);
    sendEvent('settings:changed', { key: req.key });
    return result;
  });

  ipcMain.handle('settings:set-terminal-font-size', async (_e, req: IpcRequest<'settings:set-terminal-font-size'>) => {
    const result = await handlers['settings:set-terminal-font-size'](services, req);
    if (result.changed) sendEvent('settings:changed', { key: TERMINAL_FONT_SIZE_KEY });
    return result;
  });

  ipcMain.handle('settings:set-terminal-font-weight', async (_e, req: IpcRequest<'settings:set-terminal-font-weight'>) => {
    const result = await handlers['settings:set-terminal-font-weight'](services, req);
    for (const key of result.changedKeys) sendEvent('settings:changed', { key });
    return result;
  });

  ipcMain.handle('settings:set-terminal-bold-weight', async (_e, req: IpcRequest<'settings:set-terminal-bold-weight'>) => {
    const result = await handlers['settings:set-terminal-bold-weight'](services, req);
    if (result.changed) sendEvent('settings:changed', { key: TERMINAL_BOLD_WEIGHT_KEY });
    return result;
  });

  ipcMain.handle('settings:set-app-env', async (_e, req: IpcRequest<'settings:set-app-env'>) => {
    const result = await handlers['settings:set-app-env'](services, req);
    sendEvent('settings:changed', { key: 'app_env' });
    return result;
  });

  ipcMain.handle('settings:set-claude-permission-mode', async (_e, req: IpcRequest<'settings:set-claude-permission-mode'>) => {
    const result = await handlers['settings:set-claude-permission-mode'](services, req);
    for (const key of result.changedKeys) sendEvent('settings:changed', { key });
    return result;
  });

  ipcMain.handle('settings:set-frost-chrome', async (_e, req: IpcRequest<'settings:set-frost-chrome'>) => {
    const result = await handlers['settings:set-frost-chrome'](services, req);
    if (result.ok) sendEvent('settings:changed', { key: 'frost_chrome' });
    return result;
  });

  ipcMain.handle('settings:set-chrome-frost-level', async (_e, req: IpcRequest<'settings:set-chrome-frost-level'>) => {
    const result = await handlers['settings:set-chrome-frost-level'](services, req);
    if (result.ok) sendEvent('settings:changed', { key: 'chrome_frost_level' });
    return result;
  });

  ipcMain.handle('settings:set-terminal-frost-level', async (_e, req: IpcRequest<'settings:set-terminal-frost-level'>) => {
    const result = await handlers['settings:set-terminal-frost-level'](services, req);
    if (result.ok) sendEvent('settings:changed', { key: 'terminal_frost_level' });
    return result;
  });

  ipcMain.handle('settings:set-vibrancy-material', async (_e, req: IpcRequest<'settings:set-vibrancy-material'>) => {
    const result = await handlers['settings:set-vibrancy-material'](services, req);
    if (result.ok) {
      sendEvent('settings:changed', { key: 'vibrancy_material' });
      windowHooks?.setVibrancy(req.material);
    }
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
    const absPaths = req.paths.map((p) => resolve(root, p)).filter((abs) => isInsideRoot(root, abs) && existsSync(abs));
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
