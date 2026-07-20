import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { IpcChannelName, IpcRequest, IpcResponse, IpcEventName, IpcEvents } from '../shared/ipc-contract';

const api = {
  invoke<C extends IpcChannelName>(channel: C, req: IpcRequest<C>): Promise<IpcResponse<C>> {
    return ipcRenderer.invoke(channel, req) as Promise<IpcResponse<C>>;
  },
  on<E extends IpcEventName>(channel: E, cb: (payload: IpcEvents[E]) => void): () => void {
    const listener = (_e: unknown, payload: IpcEvents[E]) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  /**
   * Resolve the absolute filesystem path of a dragged-in File. Electron
   * removed the non-standard `File.path` in v32; the sandbox-safe way to
   * get it is `webUtils.getPathForFile(file)`, which requires the electron
   * module — hence living in the preload bridge.
   */
  pathForFile(file: File): string {
    try { return webUtils.getPathForFile(file); }
    catch { return ''; }
  },
};

contextBridge.exposeInMainWorld('api', api);
export type Api = typeof api;
