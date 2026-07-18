import type { Project, Root, AliveShellSummary, SettingsMap } from './types';

/**
 * Single-character git status codes we bubble up. The two-position
 * porcelain code (staged/unstaged) is collapsed to the most relevant:
 * conflict > untracked > modified > added > deleted > renamed > ignored.
 */
export type GitFileStatus = 'M' | 'A' | 'D' | 'R' | 'U' | '?' | '!';

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
  'files:peek':      { request: { projectId: number; relPath: string; maxLines?: number };  response: { relPath: string; found: boolean; kind: 'text' | 'binary'; head: string; sizeBytes: number; totalLines: number | null } };
  'search:project':  { request: { projectId: number; query: string; caseSensitive?: boolean; regex?: boolean; maxFiles?: number; maxMatchesPerFile?: number }; response: { matches: Array<{ relPath: string; line: number; col: number; preview: string }>; filesScanned: number; truncated: boolean } };

  // Git — surfaced for the sidebar + status bar; read-only.
  'git:status':      { request: { projectId: number }; response: { isRepo: boolean; branch: string | null; ahead: number; behind: number; files: Record<string, GitFileStatus>; dirty: boolean } };

  // dialogs
  'dialogs:pick-directory': { request: undefined; response: { path: string | null } };

  // windows
  'windows:popout-shell':      { request: { projectId: number; shellIndex: number }; response: { windowId: number } };
  'windows:return-shell':      { request: { projectId: number; shellIndex: number }; response: { ok: true } };
  'windows:list-popped':       { request: undefined;                                    response: { popped: Array<{ projectId: number; shellIndex: number }> } };
  'windows:tile-all':          { request: undefined;                                    response: { arranged: number } };

  // native theme sync (light / dark / system)
  'app:set-native-theme': { request: { source: 'system' | 'light' | 'dark' }; response: { ok: true } };

  // open a URL in the OS default browser (or the file:// path in Finder / xdg-open)
  'app:open-external': { request: { url: string }; response: { ok: true } };

  /** Set every open window's opacity. percent: 30..100. */
  'app:set-window-opacity': { request: { percent: number }; response: { ok: true } };

  /* ─── metaproject chat (Flask-SocketIO backed) ─── */
  'metaproject:login':          { request: { username: string; password: string }; response: { userId: number; userName: string } };
  'metaproject:status':         { request: undefined; response: { loggedIn: boolean; connected: boolean; userName: string | null } };
  'metaproject:logout':         { request: undefined; response: { ok: true } };
  'metaproject:list-channels':  { request: { projectId: number }; response: { channels: Array<{ id: number; project_id: number; name: string; is_private: boolean }> } };
  'metaproject:list-messages':  { request: { channelId: number; limit?: number }; response: { messages: Array<{ id: number; channel_id: number; user_id: number; user_name?: string; message: string; created_at: string; parent_message_id: number | null }> } };
  'metaproject:join-channel':   { request: { channelId: number }; response: { ok: true } };
  'metaproject:send-message':   { request: { channelId: number; message: string; parentMessageId?: number | null }; response: { ok: true } };
  'metaproject:mark-read':      { request: { channelId: number; lastMessageId: number }; response: { ok: true } };

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
  'metaproject:event':      { event: string; payload: unknown };
}
export type IpcEventName = keyof IpcEvents;
