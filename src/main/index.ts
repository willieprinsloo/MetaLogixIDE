import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { buildServices } from './services';
import { registerIpc } from './ipc/register';
import { buildAppMenu } from './menu';

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
const popoutWindows = new Map<string, BrowserWindow>(); // key = `${projectId}:${shellIndex}`

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
  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${query}`);
  else await win.loadFile(join(__dirname, '../renderer/index.html'), { search: `?${query}` });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => popoutWindows.delete(key));
  popoutWindows.set(key, win);
  return win;
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
  });
  Menu.setApplicationMenu(buildAppMenu(mainWindow));
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', async () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow = await createMainWindow(); });
