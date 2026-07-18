import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
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

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

app.whenReady().then(async () => {
  const services = buildServices({ migrationsDir: resolve(app.getAppPath(), 'migrations') });
  mainWindow = await createMainWindow();
  registerIpc(ipcMain, services, broadcast, {
    createPopoutWindow: async (projectId, shellIndex) => (await createPopoutWindow(projectId, shellIndex)).id,
    returnPopoutWindow: (projectId, shellIndex) => returnPopoutWindow(projectId, shellIndex),
    listPopped: () => listPopped(),
  });
  Menu.setApplicationMenu(buildAppMenu(mainWindow));
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', async () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow = await createMainWindow(); });
