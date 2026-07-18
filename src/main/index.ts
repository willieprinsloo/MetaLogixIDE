import { app, BrowserWindow, ipcMain, Menu, screen, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { buildServices } from './services';
import { registerIpc } from './ipc/register';
import { buildAppMenu } from './menu';

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
const popoutWindows = new Map<string, BrowserWindow>(); // key = `${projectId}:${shellIndex}`

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
        trafficLightPosition: { x: 12, y: 14 },
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
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    popoutWindows.delete(key);
    broadcastPopoutChanged();
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
 * Reveal + tile every one of OUR windows on the primary display. Prefers
 * a chatbot-style row of tall side-by-side columns (III), which is what
 * you want when the windows are shells. Falls back to a two-row grid if
 * a single column would end up narrower than MIN_W. Restores minimised
 * windows first.
 */
export function tileAllOurWindows(): number {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  if (wins.length === 0) return 0;
  const display = screen.getPrimaryDisplay().workArea;
  const gap = 10;
  const MIN_W = 380;
  const n = wins.length;

  const singleRowCellW = Math.floor((display.width - gap * (n + 1)) / n);
  let cols: number;
  let rows: number;
  if (singleRowCellW >= MIN_W) {
    cols = n; rows = 1;
  } else {
    // Two rows keeps the columns tall enough to feel like the III layout
    // while giving each window enough width to be usable.
    rows = 2;
    cols = Math.ceil(n / rows);
  }
  const cellW = Math.floor((display.width  - gap * (cols + 1)) / cols);
  const cellH = Math.floor((display.height - gap * (rows + 1)) / rows);

  wins.forEach((w, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    if (w.isMinimized()) w.restore();
    w.setBounds({
      x: display.x + gap + c * (cellW + gap),
      y: display.y + gap + r * (cellH + gap),
      width:  cellW,
      height: cellH,
    }, true);
    w.show();
    w.focus();
  });
  return wins.length;
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

let persistedOpacity = 1.0;
export function applyPersistedOpacity(win: BrowserWindow): void {
  win.setOpacity(persistedOpacity);
}

app.whenReady().then(async () => {
  const services = buildServices({ migrationsDir: resolve(app.getAppPath(), 'migrations') });
  // Load persisted opacity so it's applied to the first window right away.
  try { persistedOpacity = Math.max(30, Math.min(100, services.settings.get('window_opacity'))) / 100; } catch { /* keep 1.0 */ }
  mainWindow = await createMainWindow();
  registerIpc(ipcMain, services, broadcast, {
    createPopoutWindow: async (projectId, shellIndex) => (await createPopoutWindow(projectId, shellIndex)).id,
    returnPopoutWindow: (projectId, shellIndex) => returnPopoutWindow(projectId, shellIndex),
    listPopped: () => listPopped(),
    tileAll: () => tileAllOurWindows(),
  });
  Menu.setApplicationMenu(buildAppMenu(mainWindow));
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', async () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow = await createMainWindow(); });
