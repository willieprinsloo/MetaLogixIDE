import { app, BrowserWindow, ipcMain, Menu, Notification, screen, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import log from 'electron-log/main';
import { buildServices, type Services } from './services';
import { registerIpc } from './ipc/register';
import { buildAppMenu } from './menu';
import { installClaudeNotifications } from './notifications/install';
import { installClaudeStatus } from './claude-status/install';
import { createHookFanout } from './claude-hooks/hook-fanout';
import { withoutHookConfirmed } from './notifications/claude-notifier';

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

// macOS: when the app launches from Finder / Dock, PATH is the pared-down
// GUI default (`/usr/bin:/bin:/usr/sbin:/sbin`). That's missing Homebrew,
// nvm, cargo, and every npm-global install location — so `claude`, `git`,
// `pnpm`, etc. spawn as "command not found" and the PTY exits immediately
// with the dreaded `[shell exited]`. Prepend the well-known user paths so
// spawned shells inherit a workable PATH. Order matters: user-scoped
// installers first, then Homebrew, then system.
function augmentPathForGuiLaunch(): void {
  if (process.platform !== 'darwin') return;
  const home = homedir();
  const candidates = [
    `${home}/.local/bin`,
    `${home}/.cargo/bin`,
    `${home}/.volta/bin`,
    `${home}/.npm-global/bin`,
    `${home}/.nvm/current/bin`,
    `${home}/.bun/bin`,
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
  ];
  const existing = (process.env.PATH ?? '').split(':').filter(Boolean);
  const seen = new Set(existing);
  const extras: string[] = [];
  for (const p of candidates) {
    if (existsSync(p) && !seen.has(p)) {
      extras.push(p);
      seen.add(p);
    }
  }
  process.env.PATH = [...extras, ...existing].join(':');
  if (extras.length > 0) {
    console.log('[metaide] PATH augmented for GUI launch: prepended', extras.join(':'));
  }
}
augmentPathForGuiLaunch();

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

function darwinChrome(): Partial<Electron.BrowserWindowConstructorOptions> {
  return process.platform === 'darwin'
    ? {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 12, y: 10 },
        vibrancy: 'sidebar',
        visualEffectState: 'active',
        roundedCorners: true,
      }
    : {};
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
    ...darwinChrome(),
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
  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(join(__dirname, '../renderer/index.html'));
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
    ...darwinChrome(),
    webPreferences: baseWebPreferences(),
  });
  const query = `popout=1&projectId=${projectId}&shellIndex=${shellIndex}`;
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

/**
 * Starts the Claude hook receiver and writes its settings file. A failure
 * is logged and otherwise ignored: Claude shells then launch undecorated,
 * keep the generic notifier (AC22) and show a green status dot, with no
 * dialog.
 */
async function startClaudeHooks(services: Services): Promise<void> {
  try {
    await services.hookRuntime.start();
  } catch (err) {
    console.warn('[metaide] Claude hook receiver unavailable; Claude notifications disabled and Claude status dots stay green', err);
  }
}

// Renderer signals it's mounted (App.tsx effect) so we can flush any
// file-open events buffered from a cold launch. Registered outside the
// ready handler so the receiver is in place before the renderer boots.
ipcMain.handle('app:renderer-ready-for-files', () => {
  rendererReadyForFiles = true;
  flushPendingFileOpens();
  return { ok: true } as const;
});

app.whenReady().then(async () => {
  // Cold-launch argv scan (Windows/Linux + packaged mac when invoked with
  // args). Runs after ready so `existsSync` sees the app-relative CWD.
  scanArgvForFiles(process.argv);
  // Windows toasts are dropped without an AppUserModelID matching build.appId.
  if (process.platform === 'win32') app.setAppUserModelId('com.metalogix.metaide');
  const services = buildServices({ migrationsDir: resolve(app.getAppPath(), 'migrations') });
  await startClaudeHooks(services);
  // Auto-rescan every registered root at boot so folders added on disk since
  // the last launch (or after a discovery-rule change) surface without the
  // user having to remember Settings → Rescan. Cheap: it's just directory
  // reads + SQL upserts, and the file watcher is already running.
  try {
    const { discoverProjects } = await import('./domain/discovery');
    const scanDepth = services.settings.get('scan_depth');
    for (const root of services.roots.list()) {
      for (const disc of discoverProjects(root.path, scanDepth)) {
        const p = services.projects.upsert(root.id, disc.path, disc.name);
        if (disc.metaprojectProjectId) {
          services.projects.updateConfig(p.id, { linkedMetaprojectProjectId: disc.metaprojectProjectId });
        }
      }
      services.watcher.watch(root.path);
    }
  } catch (e) {
    console.warn('[metaide] boot rescan failed', e);
  }
  // New windows read the current opacity setting when they are created.
  readWindowOpacity = () => services.settings.get('window_opacity');
  mainWindow = await createMainWindow();
  registerIpc(ipcMain, services, broadcast, {
    createPopoutWindow: async (projectId, shellIndex) => (await createPopoutWindow(projectId, shellIndex)).id,
    returnPopoutWindow: (projectId, shellIndex) => returnPopoutWindow(projectId, shellIndex),
    listPopped: () => listPopped(),
    tileAll: () => tileAllOurWindows(),
  });
  Menu.setApplicationMenu(buildAppMenu(mainWindow));
  installClaudeNotifications({
    hooks: services.claudeState,
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
  const claudeStatus = installClaudeStatus({
    receiver: createHookFanout(services.hookReceiver),
    tracker: services.claudeState,
    ptyManager: services.ptyManager,
    broadcast,
  });

  // ─── Long-running command "done" notifier ─────────────────────────────
  // Every 500 ms ask the PtyManager which shells just finished a command
  // (idle after long work). Fire a native OS notification for each — but
  // only when the shell isn't the currently-focused one (otherwise it'd
  // ping every time you finish typing a heavy `pytest`).
  const donePoll = setInterval(() => {
    const done = withoutHookConfirmed(services.ptyManager.pollDoneCommands(), (s) => services.hookSessions.isConfirmed(s));
    if (done.length === 0) return;
    const focused = BrowserWindow.getFocusedWindow();
    const mainFocused = !!focused && !focused.isDestroyed() && focused === mainWindow;
    for (const d of done) {
      const project = services.projects.get(d.projectId);
      const projectName = project?.name ?? `#${d.projectId}`;
      const secs = Math.round(d.durationMs / 1000);
      const timeLabel = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
      const key = `${d.projectId}:${d.shellIndex}`;
      const popped = popoutWindows.has(key);
      // Skip the notification when the user is actively looking at that
      // shell — but do fire when a popped-out shell finishes, when the app
      // is unfocused, or when they're on a different tab entirely.
      if (mainFocused && !popped) continue;
      try {
        const notif = new Notification({
          title: `${projectName} — shell ${d.shellIndex}`,
          body: `Command finished in ${timeLabel}`,
          silent: false,
        });
        // Clicking the notification jumps back into that shell: raise the
        // main window (or the popout if this shell lives in one), and ask
        // the renderer to switch project + tab via a broadcast event.
        notif.on('click', () => {
          try {
            if (popped) {
              const w = popoutWindows.get(key);
              if (w && !w.isDestroyed()) { w.show(); w.focus(); return; }
            }
            if (mainWindow && !mainWindow.isDestroyed()) {
              if (mainWindow.isMinimized()) mainWindow.restore();
              mainWindow.show(); mainWindow.focus();
            }
            broadcast('shell:focus-request', { projectId: d.projectId, shellIndex: d.shellIndex });
          } catch (err) { console.warn('[metaide] notification click failed', err); }
        });
        notif.show();
      } catch (e) {
        console.warn('[metaide] notification failed', e);
      }
    }
  }, 500);

  // ─── Ports panel: fan out ports changes to renderer ───────────────────
  services.ptyManager.on('ports', (payload: { projectId: number; shellIndex: number; ports: number[] }) => {
    broadcast('ports:changed', payload);
  });

  app.on('before-quit', () => {
    clearInterval(donePoll);
    claudeStatus.stop();
    void services.hookRuntime.stop();
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', async () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow = await createMainWindow(); });
