import type { Project, Root, AliveShellSummary, SettingsMap } from './types';

export interface IpcContract {
  // roots
  'roots:list':    { request: undefined;                  response: { roots: Root[] } };
  'roots:add':     { request: { path: string };           response: { root: Root } };
  'roots:remove':  { request: { id: number };             response: { ok: true } };
  'roots:rescan':  { request: { id: number };             response: { discovered: number } };

  // projects
  'projects:list':          { request: undefined;                               response: { projects: Project[] } };
  'projects:open':          { request: { id: number };                          response: { project: Project } };
  'projects:pin':           { request: { id: number; pinned: boolean };         response: { ok: true } };
  'projects:hide':          { request: { id: number; hidden: boolean };         response: { ok: true } };
  'projects:update-config': { request: { id: number; config: Project['config'] }; response: { project: Project } };
  'projects:recents':       { request: { limit?: number };                      response: { projects: Project[] } };

  // shells
  'shells:launch':      { request: { projectId: number };                       response: { shellIndex: number } };
  'shells:kill':        { request: { projectId: number; shellIndex: number };   response: { ok: true } };
  'shells:resize':      { request: { projectId: number; shellIndex: number; cols: number; rows: number }; response: { ok: true } };
  'shells:write':       { request: { projectId: number; shellIndex: number; data: string }; response: { ok: true } };
  'shells:alive-list':  { request: undefined;                                   response: { shells: AliveShellSummary[] } };
  'shells:pin':         { request: { projectId: number; shellIndex: number; pinned: boolean }; response: { ok: true } };

  // settings
  'settings:get': { request: { key: keyof SettingsMap };                        response: { value: SettingsMap[keyof SettingsMap] } };
  'settings:set': { request: { key: keyof SettingsMap; value: SettingsMap[keyof SettingsMap] }; response: { ok: true } };

  // files (read-only)
  'files:tree':  { request: { projectId: number; relPath?: string };            response: { entries: Array<{ name: string; isDir: boolean; relPath: string }> } };

  // dialogs
  'dialogs:pick-directory': { request: undefined; response: { path: string | null } };

  // health / dev
  'app:ping':    { request: undefined; response: 'pong' };
}

export type IpcChannelName = keyof IpcContract;
export type IpcRequest<C extends IpcChannelName>  = IpcContract[C]['request'];
export type IpcResponse<C extends IpcChannelName> = IpcContract[C]['response'];

// Streaming (main → renderer) event channels — separate from request/response.
export interface IpcEvents {
  'pty:data':               { projectId: number; shellIndex: number; data: string };
  'pty:exit':               { projectId: number; shellIndex: number; code: number | null };
  'pty:input-owner-changed':{ projectId: number; shellIndex: number; ownerWindowId: number };
  'projects:changed':       { kind: 'added' | 'removed' | 'updated'; projectId?: number };
  'settings:changed':       { key: keyof SettingsMap };
  'alive-shells:changed':   Record<string, never>;
}
export type IpcEventName = keyof IpcEvents;
