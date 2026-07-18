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
  'projects:create':        { request: { rootId: number; name: string; initGit?: boolean }; response: { project: Project } };

  // shells
  'shells:launch':      { request: { projectId: number };                       response: { shellIndex: number } };
  'shells:kill':        { request: { projectId: number; shellIndex: number };   response: { ok: true } };
  'shells:resize':      { request: { projectId: number; shellIndex: number; cols: number; rows: number }; response: { ok: true } };
  'shells:write':       { request: { projectId: number; shellIndex: number; data: string }; response: { ok: true } };
  'shells:alive-list':  { request: undefined;                                   response: { shells: AliveShellSummary[] } };
  'shells:pin':         { request: { projectId: number; shellIndex: number; pinned: boolean }; response: { ok: true } };
  'shells:snapshot':    { request: { projectId: number; shellIndex: number };   response: { output: string; alive: boolean } };

  // settings
  'settings:get': { request: { key: keyof SettingsMap };                        response: { value: SettingsMap[keyof SettingsMap] } };
  'settings:set': { request: { key: keyof SettingsMap; value: SettingsMap[keyof SettingsMap] }; response: { ok: true } };

  // files (read-only)
  'files:tree':      { request: { projectId: number; relPath?: string };                    response: { entries: Array<{ name: string; isDir: boolean; relPath: string }> } };
  'files:read':      { request: { projectId: number; relPath: string };                     response: { content: string; kind: 'text' | 'binary'; sizeBytes: number } };
  'files:list-all':  { request: { projectId: number; limit?: number; filter?: string };     response: { files: Array<{ relPath: string; name: string }>; total: number; truncated: boolean } };
  'files:write':     { request: { projectId: number; relPath: string; content: string };    response: { ok: true; sizeBytes: number } };
  'files:mkdir':     { request: { projectId: number; relPath: string };                     response: { ok: true } };
  'files:rename':    { request: { projectId: number; from: string; to: string };            response: { ok: true } };
  'files:delete':    { request: { projectId: number; relPath: string };                     response: { ok: true } };
  'files:reveal':    { request: { projectId: number; relPath: string };                     response: { ok: true } };
  'search:project':  { request: { projectId: number; query: string; caseSensitive?: boolean; regex?: boolean; maxFiles?: number; maxMatchesPerFile?: number }; response: { matches: Array<{ relPath: string; line: number; col: number; preview: string }>; filesScanned: number; truncated: boolean } };

  // dialogs
  'dialogs:pick-directory': { request: undefined; response: { path: string | null } };

  // windows
  'windows:popout-shell':      { request: { projectId: number; shellIndex: number }; response: { windowId: number } };
  'windows:return-shell':      { request: { projectId: number; shellIndex: number }; response: { ok: true } };
  'windows:list-popped':       { request: undefined;                                    response: { popped: Array<{ projectId: number; shellIndex: number }> } };

  // native theme sync (light / dark / system)
  'app:set-native-theme': { request: { source: 'system' | 'light' | 'dark' }; response: { ok: true } };

  // open a URL in the OS default browser (or the file:// path in Finder / xdg-open)
  'app:open-external': { request: { url: string }; response: { ok: true } };

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
  'popout:changed':         { popped: Array<{ projectId: number; shellIndex: number }> };
}
export type IpcEventName = keyof IpcEvents;
