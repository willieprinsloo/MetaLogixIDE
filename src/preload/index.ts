import { contextBridge, ipcRenderer } from 'electron';
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
};

contextBridge.exposeInMainWorld('api', api);
export type Api = typeof api;
