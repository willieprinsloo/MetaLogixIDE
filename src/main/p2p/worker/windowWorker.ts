import { BrowserWindow, ipcMain } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TransportWorker } from '../transport';
import type { WorkerCommand, WorkerEvent } from './peerEngine';

const here = typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));

const workerWindowIds = new Set<number>();

/** True for the hidden worker window, so app lifecycle checks don't count it as a user window. */
export function isWorkerWindowId(id: number): boolean {
  return workerWindowIds.has(id);
}

/**
 * Spawns a hidden BrowserWindow hosting p2pWorker.html and returns a
 * TransportWorker that drives it over IPC (p2p:worker:cmd / reply / event).
 * Replies and events are accepted only from this window's webContents.
 */
export function createWindowWorker(): TransportWorker {
  const win = new BrowserWindow({
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, '../preload/p2pWorker.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const winId = win.id;
  workerWindowIds.add(winId);
  win.on('closed', () => workerWindowIds.delete(winId));
  const wc = win.webContents;
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  let nextId = 1;
  let sink: (e: WorkerEvent) => void = () => {};
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const onReply = (ev: Electron.IpcMainEvent, m: { id: number; ok: boolean; value: unknown }) => {
    if (ev.sender !== wc) return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.value); else p.reject(new Error(String(m.value)));
  };
  const onEvent = (ev: Electron.IpcMainEvent, e: WorkerEvent) => { if (ev.sender === wc) sink(e); };
  ipcMain.on('p2p:worker:reply', onReply);
  ipcMain.on('p2p:worker:event', onEvent);

  const url = process.env['ELECTRON_RENDERER_URL'];
  const loaded = url
    ? win.loadURL(`${url}/p2pWorker.html`)
    : win.loadFile(join(here, '../renderer/p2pWorker.html'));

  return {
    async call(cmd: WorkerCommand, ...args: unknown[]) {
      await loaded;
      if (wc.isDestroyed()) throw new Error('p2p worker destroyed');
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        wc.send('p2p:worker:cmd', { id, cmd, args });
      });
    },
    onEvent(cb) { sink = cb; },
    destroy() {
      ipcMain.removeListener('p2p:worker:reply', onReply);
      ipcMain.removeListener('p2p:worker:event', onEvent);
      for (const p of pending.values()) p.reject(new Error('p2p worker destroyed'));
      pending.clear();
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
