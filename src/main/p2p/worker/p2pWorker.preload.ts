import { contextBridge, ipcRenderer } from 'electron';

// Narrow bridge: the worker page can only receive commands, reply to them and
// emit transport events. No generic ipcRenderer is exposed.
contextBridge.exposeInMainWorld('p2p', {
  onCommand: (cb: (id: number, cmd: string, args: unknown[]) => void) => {
    ipcRenderer.on('p2p:worker:cmd', (_e, m: { id: number; cmd: string; args: unknown[] }) => cb(m.id, m.cmd, m.args));
  },
  reply: (id: number, ok: boolean, value: unknown) => ipcRenderer.send('p2p:worker:reply', { id, ok, value }),
  emit: (e: unknown) => ipcRenderer.send('p2p:worker:event', e),
});
