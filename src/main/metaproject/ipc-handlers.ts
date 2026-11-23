import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import type { IpcEventName, IpcEvents } from '@shared/ipc-contract';
import type { ProjectsRepo } from '@main/repos/projects-repo';
import type { RootsRepo } from '@main/repos/roots-repo';
import type { SettingsRepo } from '@main/repos/settings-repo';

export interface MetaprojectKeyring {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

export interface MetaprojectIpcOptions {
  readonly ipcMain: IpcMain;
  readonly settings: SettingsRepo;
  readonly projects: ProjectsRepo;
  readonly roots: RootsRepo;
  readonly allowLoopbackHttp: boolean;
  readonly keyring: MetaprojectKeyring;
  readonly owner: () => BrowserWindow | null;
  readonly authorize: (event: IpcMainInvokeEvent) => BrowserWindow | null;
  readonly send: <E extends IpcEventName>(channel: E, payload: IpcEvents[E]) => void;
  readonly openExternal: (url: string) => Promise<void>;
}

export interface MetaprojectLifecycle {
  start(): void;
  dispose(): void;
  detachBoard(): void;
}
