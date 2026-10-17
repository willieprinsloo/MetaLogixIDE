import { app, BrowserWindow, ipcMain, Menu, Notification, screen, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import log from 'electron-log/main';
import { buildServices, type Services } from './services';
import { DROP_MAX_AGE_MS, testModeDropDir } from './drops/staging';
import { registerIpc } from './ipc/register';
import { buildAppMenu } from './menu';
import { installClaudeNotifications } from './notifications/install';
import { installAgentStatus } from './agent-status/install';
import { createHookFanout } from './claude-hooks/hook-fanout';
import { rescanRootsAtBoot } from './startup/boot-rescan';
import { startDoneNotifier } from './startup/done-notifier';
import { startReceivers } from './startup/receivers';
import { withoutHookConfirmed } from './notifications/claude-notifier';
import { resolveLoginShellPath } from './domain/login-shell-path';
import {
  FROSTED_GLASS_FALLBACK,
  applyVibrancy,
  platformChrome,
  readStoredFrostedGlass,
  rendererQuery,
  type StoredFrostedGlass,
} from './window-chrome';

// Route console.log/warn/error to a rolling file at
// `~/Library/Logs/MetaLogix IDE/main.log` (Electron's app.getPath('logs')).
// `preload: true` wires renderer console output through IPC into the same
// file so both sides land in one place — no more "was that a main or a
// renderer error?" hunt when a user reports a blank screen. transports.file
// rotates at 10 MB by default which is fine for a dev-tool desktop app.
log.initialize({ preload: true });
log.transports.file.level = 'info';
log.transports.console.level = 'debug';
Object.assign(console, log.functions);

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
const popoutWindows = new Map<string, BrowserWindow>(); // key = `${projectId}:${shellIndex}`

// ─── File-association / "open with metaIDE" plumbing ───────────────────
// macOS delivers file opens via `app.on('open-file')` (can arrive BEFORE
// the app is ready). Windows/Linux hand them as argv on cold launch, or
// via `second-instance` when a second `metaide <path>` invocation is
// forwarded by the single-instance lock below. We buffer everything until
// the renderer is up, then flush and broadcast one event per path.
const pendingFileOpens: string[] = [];
let rendererReadyForFiles = false;

function flushPendingFileOpens(): void {
  if (!rendererReadyForFiles) return;
  while (pendingFileOpens.length > 0) {
    const p = pendingFileOpens.shift()!;
    try {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('app:open-file-request', { path: p });
      }
    } catch (e) { console.warn('[metaide] failed to forward open-file', p, e); }
  }
}

function queueOpenFile(rawPath: string): void {
  // Only queue paths that actually exist on disk — swallows the transient
  // argv[0] (electron binary path itself) and macOS's `-psn_*` flag.
  if (!rawPath || rawPath.startsWith('-')) return;
  try {
    if (!existsSync(rawPath)) return;
  } catch { return; }
  pendingFileOpens.push(rawPath);
  flushPendingFileOpens();
  // Also raise the main window when a file arrives — the user just asked
  // to open something, so make sure the UI is visible.
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
  }
}

// Argv scan for the initial launch (Windows/Linux). The electron binary
// path is process.argv[0]; process.argv[1] is our own out/main/index.js
// on unpacked runs and the packaged app entry on installed ones. Anything
// after that is a user-supplied file.
function scanArgvForFiles(argv: string[]): void {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '.' || a === '--') continue;
    queueOpenFile(a);
  }
}

// macOS delivers open-file events; register the listener EARLY so events
// fired before app.whenReady are still captured.
app.on('open-file', (event, path) => {
  event.preventDefault();
  queueOpenFile(path);
});

// Single-instance lock. When the user opens a second file via Finder
// (which spawns `MetaLogix IDE.app --args <path>`), Electron routes the
// arguments to the running instance's second-instance event instead of
// launching a second app. Without this the second launch would open a
// duplicate metaIDE with its own DB handle, which would corrupt the
// SQLite WAL.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    scanArgvForFiles(argv);
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show(); mainWindow.focus();
    }
  });
}

function poppedList(): Array<{ projectId: number; shellIndex: number }> {
  return [...popoutWindows.keys()].map((k) => {
    const [p, s] = k.split(':');
    return { projectId: Number(p), shellIndex: Number(s) };
  });
}

function broadcastPopoutChanged() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('popout:changed', { popped: poppedList() });
  }
}

function baseWebPreferences() {
  return {
    preload: join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}

function wireExternalLinks(win: BrowserWindow): void {
  // Any window.open / target=_blank / Ctrl+click routes to the OS browser
  // instead of spawning a new BrowserWindow inside metaIDE.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto|file):/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  // Block in-place navigation from clicks on external anchor tags.
  win.webContents.on('will-navigate', (e, url) => {
    const isInternal = url.startsWith('file://') && url.includes('/out/renderer/');
    const isDevServer = !!process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL);
    if (isInternal || isDevServer) return;
    e.preventDefault();
    if (/^(https?|mailto|file):/i.test(url)) void shell.openExternal(url);
  });
}

async function createMainWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    backgroundColor: '#00000000',
    ...platformChrome(process.platform, readFrostedGlass().vibrancyMaterial),
    webPreferences: baseWebPreferences(),
  });
  win.once('ready-to-show', () => win.show());
  wireExternalLinks(win);
  applyPersistedOpacity(win);
  // Detect renderer crashes ("blank screen" symptom) and auto-recover by
  // reloading the window. Without this, an OOM / WebGL context loss / stray
  // exception leaves the user with a blank webview and nothing else to do.
  win.webContents.on('render-process-gone', (_evt, details) => {
    console.error('[metaide] renderer gone:', details.reason, details.exitCode);
    if (details.reason !== 'clean-exit' && !win.isDestroyed()) {
      try { win.reload(); } catch (e) { console.error('[metaide] reload failed', e); }
    }
  });
  win.webContents.on('unresponsive', () => console.warn('[metaide] renderer unresponsive'));
  win.webContents.on('responsive', () => console.log('[metaide] renderer responsive again'));
  const query = rendererQuery({ ...readFrostedGlass(), platform: process.platform });
  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${query}`);
  else await win.loadFile(join(__dirname, '../renderer/index.html'), { search: `?${query}` });
  return win;
}

export async function createPopoutWindow(projectId: number, shellIndex: number): Promise<BrowserWindow> {
  const key = `${projectId}:${shellIndex}`;
  const existing = popoutWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return existing;
  }
  const win = new BrowserWindow({
    width: 900,
    height: 620,
    show: false,
    backgroundColor: '#00000000',
    ...platformChrome(process.platform, readFrostedGlass().vibrancyMaterial),
    webPreferences: baseWebPreferences(),
  });
  const query = rendererQuery({
    popout: { projectId, shellIndex },
    ...readFrostedGlass(),
    platform: process.platform,
  });
  wireExternalLinks(win);
  applyPersistedOpacity(win);
  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${query}`);
  else await win.loadFile(join(__dirname, '../renderer/index.html'), { search: `?${query}` });
  win.once('ready-to-show', () => {
    win.show();
    // Once the new window has real dimensions, re-tile everything so
    // the group stays balanced automatically.
    tileAllOurWindows();
  });
  win.on('closed', () => {
    popoutWindows.delete(key);
    broadcastPopoutChanged();
    // Fill the vacated slot with the remaining windows.
    tileAllOurWindows();
  });
  popoutWindows.set(key, win);
  broadcastPopoutChanged();
  return win;
}

export function returnPopoutWindow(projectId: number, shellIndex: number): boolean {
  const win = popoutWindows.get(`${projectId}:${shellIndex}`);
  if (!win || win.isDestroyed()) return false;
  win.close();
  return true;
}

export function listPopped(): Array<{ projectId: number; shellIndex: number }> {
  return poppedList();
}

/**
 * Reveal + tile every one of OUR windows on the primary display in a
 * chatbot-style row of tall portrait columns (III). The MAIN window gets
 * a wider 1:1.5 aspect (its editor + shell need more horizontal room);
 * popouts stay at 1:2 like phone screens. Falls back to two rows if a
 * single row would make popouts narrower than MIN_W. The whole
 * arrangement is centred on the display so it doesn't hug either edge.
 */
export function tileAllOurWindows(): number {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  if (wins.length === 0) return 0;
  const display = screen.getPrimaryDisplay().workArea;
  const gap = 10;
  const MIN_W = 380;

  // Sort: main window first, then popouts in insertion order. Falls back
  // to whatever getAllWindows returned if we can't identify the main one.
  const sorted = [...wins].sort((a, b) => {
    if (a === mainWindow) return -1;
    if (b === mainWindow) return 1;
    return 0;
  });
  const hasMain = sorted[0] === mainWindow;
  const n = sorted.length;

  function widthForCell(h: number, isMain: boolean) {
    return Math.floor(h / (isMain ? 1.5 : 2));
  }

  // Try a single row. Compute total width required and see if it fits.
  let cols = n;
  let rows = 1;
  let cellH = display.height - gap * 2;

  let widths = sorted.map((_, i) => widthForCell(cellH, hasMain && i === 0));
  let totalW = widths.reduce((a, b) => a + b, 0) + (cols + 1) * gap;

  // If the aspect-capped widths don't fill the display, keep them (centre
  // will absorb the slack). If a natural single-row division would leave
  // each cell too narrow, fall back to two rows.
  const naturalSingleRow = Math.floor((display.width - gap * (n + 1)) / n);
  if (naturalSingleRow < MIN_W) {
    rows = 2;
    cols = Math.ceil(n / rows);
    cellH = Math.floor((display.height - gap * (rows + 1)) / rows);
    widths = sorted.map((_, i) => widthForCell(cellH, hasMain && i === 0));
    totalW = cols * Math.max(...widths) + (cols + 1) * gap; // rows are aligned, use max column width
  }

  // Centre the arrangement in the work area.
  const totalH = rows * cellH + (rows + 1) * gap;
  const xOffset = display.x + Math.max(0, Math.floor((display.width  - totalW) / 2));
  const yOffset = display.y + Math.max(0, Math.floor((display.height - totalH) / 2));

  if (rows === 1) {
    // Single row: place each window at its per-window width, side by side.
    let x = xOffset + gap;
    sorted.forEach((w, i) => {
      const cellW = widths[i]!;
      if (w.isMinimized()) w.restore();
      w.setBounds({ x, y: yOffset + gap, width: cellW, height: cellH }, true);
      w.show(); w.focus();
      x += cellW + gap;
    });
  } else {
    // Two rows: keep columns uniform, use the wider of the two ratios so
    // rows line up. Main still gets its own row-1 slot.
    const cellW = Math.max(...widths);
    sorted.forEach((w, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      if (w.isMinimized()) w.restore();
      w.setBounds({
        x: xOffset + gap + c * (cellW + gap),
        y: yOffset + gap + r * (cellH + gap),
        width: cellW,
        height: cellH,
      }, true);
      w.show(); w.focus();
    });
  }
  return sorted.length;
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    // The BrowserWindow can be alive while its underlying render frame is
    // transient — during Cmd+R, a renderer crash + auto-respawn, or window
    // close. Calling `.send()` on a disposed frame throws
    // "Render frame was disposed before WebFrameMain could be accessed"
    // and, when it happens from a hot PTY, spams the log dozens of times
    // per second. Guard both flags and swallow the residual race.
    if (w.isDestroyed()) continue;
    const wc = w.webContents;
    if (!wc || wc.isDestroyed() || wc.isCrashed()) continue;
    try {
      wc.send(channel, payload);
    } catch { /* frame disposed in the window between the checks and send */ }
  }
}

/**
 * Reads the four frosted-glass settings for `BrowserWindow` creation and the renderer query
 * string (AC1, AC5), each validated by `readStoredFrostedGlass`. Late-bound: set once services
 * exist; a window created before then, or a failed read, falls back to the shared defaults (AC1).
 */
let readFrostedGlass: () => StoredFrostedGlass = () => FROSTED_GLASS_FALLBACK;

// Reads the stored `window_opacity`. Set once services exist. The value is
// clamped to 30..100 here; a window created before then, a failed read or a
// non-numeric value stays fully opaque.
let readWindowOpacity: (() => number) | null = null;
export function applyPersistedOpacity(win: BrowserWindow): void {
  let opacity = 1;
  try {
    const percent = readWindowOpacity?.();
    if (typeof percent === 'number' && Number.isFinite(percent)) opacity = Math.max(30, Math.min(100, percent)) / 100;
  } catch { /* keep 1.0 */ }
  win.setOpacity(opacity);
}

// Renderer signals it's mounted (App.tsx effect) so we can flush any
// file-open events buffered from a cold launch. Registered outside the
// ready handler so the receiver is in place before the renderer boots.
ipcMain.handle('app:renderer-ready-for-files', () => {
  rendererReadyForFiles = true;
  flushPendingFileOpens();
  return { ok: true } as const;
});

/**
 * Replaces PATH with the interactive login shell's on non-Windows platforms: GUI launches (Dock,
 * desktop launchers) inherit a minimal PATH lacking version-manager shims, so `claude` and
 * friends would not resolve. On failure the inherited PATH is kept and a warning logged.
 */
async function adoptLoginShellPath(): Promise<void> {
  if (process.platform === 'win32') return;
  const loginShell = process.env.SHELL || '/bin/zsh';
  try {
    process.env.PATH = await resolveLoginShellPath(loginShell, homedir(), process.env);
  } catch (err) {
    log.warn(
      '[metaide] Could not resolve interactive login-shell PATH; retaining inherited PATH. Check your shell startup files and runtime PATH configuration.',
      loginShell,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Sets the Windows AppUserModelID; Windows drops toasts without one matching `build.appId`. */
function registerWindowsAppId(): void {
  if (process.platform === 'win32') app.setAppUserModelId('com.metalogix.metaide');
}

/** Builds the service graph from the app's install paths and the test-mode drop directory env. */
function createServices(): Services {
  const ompExtensionPath = app.isPackaged
    ? join(process.resourcesPath, 'omp-status-extension.js')
    : resolve(app.getAppPath(), 'resources/omp-status-extension.js');
  return buildServices({
    migrationsDir: resolve(app.getAppPath(), 'migrations'),
    ompExtensionPath,
    dropDir: testModeDropDir(process.env, app.getPath('userData')),
  });
}

/** Installs the agent-status monitor, publishes its tracker on `services`, and returns the handle for shutdown. */
function attachAgentStatus(services: Services): ReturnType<typeof installAgentStatus> {
  const agentStatus = installAgentStatus({
    ptyManager: services.ptyManager,
    receiver: services.ompReceiver,
    broadcast,
  });
  services.agentStatus = agentStatus.tracker;
  return agentStatus;
}

/** Binds the late-bound window setting readers so new windows pick up the stored opacity and frosted glass. */
function bindWindowSettings(services: Services): void {
  readWindowOpacity = () => services.settings.get('window_opacity');
  readFrostedGlass = () => readStoredFrostedGlass((key) => services.settings.get(key));
}

/** Registers the renderer IPC surface, with window operations bound to this module's windows. */
function registerMainIpc(services: Services): void {
  registerIpc(ipcMain, services, broadcast, {
    createPopoutWindow: async (projectId, shellIndex) => (await createPopoutWindow(projectId, shellIndex)).id,
    returnPopoutWindow: (projectId, shellIndex) => returnPopoutWindow(projectId, shellIndex),
    listPopped: () => listPopped(),
    tileAll: () => tileAllOurWindows(),
    setVibrancy: (material) => applyVibrancy(BrowserWindow.getAllWindows(), material, process.platform),
  });
}

/** Wires Claude hook events to OS notifications, resolving target windows from this module's state. */
function installNotifications(services: Services): void {
  installClaudeNotifications({
    hooks: createHookFanout(services.hookReceiver),
    history: services.hookHistory,
    sessions: services.hookSessions,
    ptyManager: services.ptyManager,
    viewedShells: services.viewedShells,
    settings: services.settings,
    projects: services.projects,
    notificationClass: Notification,
    windows: {
      main: () => mainWindow,
      popout: (s) => popoutWindows.get(`${s.projectId}:${s.shellIndex}`) ?? null,
      focused: () => BrowserWindow.getFocusedWindow(),
    },
    broadcast,
  });
}

/** Creates the main window and app menu, then prunes stale drop staging in the background. */
async function openMainWindow(services: Services): Promise<void> {
  mainWindow = await createMainWindow();
  Menu.setApplicationMenu(buildAppMenu(mainWindow));
  void services.dropStaging.pruneOlderThan(DROP_MAX_AGE_MS).then(
    (summary) => log.info('[drops] startup prune finished', summary),
    (err: unknown) => log.warn('[drops] startup prune failed', err),
  );
}

/** Starts the long-running command "done" notifier against this module's windows, skipping hook-confirmed shells. */
function startCommandDoneNotifier(services: Services): NodeJS.Timeout {
  return startDoneNotifier({
    pollDone: () => withoutHookConfirmed(services.ptyManager.pollDoneCommands(), (s) => services.hookSessions.isConfirmed(s)),
    focusedWindow: () => BrowserWindow.getFocusedWindow(),
    mainWindow: () => mainWindow,
    popout: (key) => popoutWindows.get(key),
    isPopped: (key) => popoutWindows.has(key),
    projectName: (projectId) => services.projects.get(projectId)?.name,
    notificationClass: Notification,
    broadcast,
  });
}

/** Fans out per-shell listening-port changes to every renderer for the ports panel. */
function forwardPortChanges(services: Services): void {
  services.ptyManager.on('ports', (payload: { projectId: number; shellIndex: number; ports: number[] }) => {
    broadcast('ports:changed', payload);
  });
}

/** Stops the done poller, the agent-status monitor and both receivers when the app quits. */
function stopOnQuit(services: Services, donePoll: NodeJS.Timeout, agentStatus: ReturnType<typeof installAgentStatus>): void {
  app.on('before-quit', () => {
    clearInterval(donePoll);
    agentStatus.stop();
    services.ompReceiver.stop();
    void services.hookRuntime.stop();
  });
}

/**
 * App startup once Electron is ready, in a fixed order: login-shell PATH, cold-launch argv scan
 * (after ready so `existsSync` sees the app-relative CWD), Windows app id, services, receivers,
 * agent status, boot rescan, window settings, IPC, Claude notifications, main window, done
 * notifier, ports fan-out, quit teardown.
 */
async function startApp(): Promise<void> {
  await adoptLoginShellPath();
  scanArgvForFiles(process.argv);
  registerWindowsAppId();
  const services = createServices();
  await startReceivers(services);
  const agentStatus = attachAgentStatus(services);
  await rescanRootsAtBoot(services);
  bindWindowSettings(services);
  registerMainIpc(services);
  installNotifications(services);
  await openMainWindow(services);
  const donePoll = startCommandDoneNotifier(services);
  forwardPortChanges(services);
  stopOnQuit(services, donePoll, agentStatus);
}

const startupReady = app.whenReady().then(startApp);

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', async () => {
  if (process.platform === 'darwin') await startupReady;
  if (BrowserWindow.getAllWindows().length === 0) mainWindow = await createMainWindow();
});
