import type { Project, Root, AliveShellSummary, SettingsMap } from './types';
import type { ClaudePermissionMode } from './claude-permission-mode';
import type { ClaudeShellStateEntry } from './claude-state';
import type { FontFamilyPreference, FontSettingKey } from './font-settings';
import type { TerminalFontWeight } from './terminal-font-weight';

/**
 * Single-character git status codes we bubble up. The two-position
 * porcelain code (staged/unstaged) is collapsed to the most relevant:
 * conflict > untracked > modified > added > deleted > renamed > ignored.
 */
export type GitFileStatus = 'M' | 'A' | 'D' | 'R' | 'U' | '?' | '!';

/** One changed path in the git panel / Diff tab. `origPath` is set for renames and copies (status 'R'). */
export interface GitChangeEntry { path: string; status: GitFileStatus; origPath?: string }

/** Which comparison a Diff tab entry shows: staged = HEAD vs index, unstaged = index vs worktree, untracked = nothing vs worktree. */
export type GitDiffKind = 'staged' | 'unstaged' | 'untracked';

/** Full content of one side, used only for syntax highlighting. `text` is null when it was not read; `skipped` says why. */
export interface GitSideContent {
  text: string | null;
  skipped?: 'absent' | 'too-large' | 'binary' | 'unavailable';
}

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
  /**
   * Given an absolute file path, guarantee there's a project whose root
   * contains that file — creating a root + project for the file's parent
   * directory if none exists. Used by the OS file-open flow so a
   * double-clicked .md / .py always lands in an editor without a prompt.
   */
  'projects:ensure-for-file': { request: { path: string }; response: { project: Project; relPath: string } };
  /**
   * Clones a remote git repo into `<root>/<name>` and registers it as a
   * project. When `name` is empty, defaults to the URL's repo basename
   * (`https://…/foo.git` → `foo`).
   */
  'projects:clone-git':     { request: { rootId: number; url: string; name?: string }; response: { project: Project } };
  /**
   * Rename the project's on-disk folder AND update the project record. The
   * new folder lives in the same root; passing a name that already exists
   * on disk fails cleanly. When `killShells: true` (the default) any live
   * shells for the project are killed first — a running pty holds an inode
   * handle to the cwd, which on macOS keeps the OLD path accessible but
   * confuses tools; on Windows the rename would fail outright.
   */
  'projects:rename':        { request: { id: number; newName: string; killShells?: boolean }; response: { project: Project } };

  // shells
  'shells:launch':      { request: { projectId: number };                       response: { shellIndex: number } };
  // Spawn a plain login shell (user's $SHELL, or /bin/zsh) at the project's
  // cwd. Auto-picks the next unused shellIndex. Used by the "New Terminal"
  // button and the ⌘T shortcut for ad-hoc shells alongside the Claude one.
  'shells:launch-plain': { request: { projectId: number };                       response: { shellIndex: number } };
  // Spawn a named CLI profile (Claude, Llama, custom, …) at the project's cwd.
  // Passing `argv` inline lets the user try a one-off command; when `save`
  // is true, the (name, argv) pair is persisted to the project's cliProfiles.
  'shells:launch-cli':   {
    request: {
      projectId: number;
      profileName?: string;
      argv?: string[];
      env?: Record<string, string>;
      save?: boolean;
    };
    response: { shellIndex: number };
  };
  // Project-level CLI profile management. Lists resolve project overrides
  // ∪ global defaults so the renderer sees one flat, deduplicated list.
  'shells:cli-profiles-list': {
    request: { projectId: number };
    response: { profiles: Array<{ name: string; argv: string[]; env?: Record<string, string>; icon?: string; scope: 'project' | 'global' }> };
  };
  'shells:cli-profiles-remove': { request: { projectId: number; name: string }; response: { ok: true } };
  /**
   * Set (or clear with `name: null`) the CLI profile that auto-launches
   * when this project is opened. Name is resolved against project +
   * global profiles at spawn time, so renaming a profile after pinning
   * gracefully falls back to the classic Claude default.
   */
  'shells:set-default-cli':     { request: { projectId: number; name: string | null }; response: { project: Project } };
  'shells:kill':        { request: { projectId: number; shellIndex: number };   response: { ok: true } };
  'shells:resize':      { request: { projectId: number; shellIndex: number; cols: number; rows: number }; response: { ok: true } };
  'shells:write':       { request: { projectId: number; shellIndex: number; data: string }; response: { ok: true } };
  'shells:alive-list':  { request: undefined;                                   response: { shells: AliveShellSummary[] } };
  /** Claude state of every shell that is not idle; shells absent from the list are idle. */
  'claude-state:list':  { request: undefined;                                   response: { shells: ClaudeShellStateEntry[] } };
  'shells:pin':         { request: { projectId: number; shellIndex: number; pinned: boolean }; response: { ok: true } };
  'shells:snapshot':    { request: { projectId: number; shellIndex: number };   response: { output: string; alive: boolean } };
  /**
   * Snapshot of every alive shell's currently-detected ports. The main
   * process scans PTY output for common "listening on 3000" / "Local:
   * http://localhost:3000/" patterns and keeps a per-shell Set<number>.
   * The ports:changed event fires when that set grows and with an empty set
   * when the shell exits or its active process is interrupted.
   */
  'shells:ports':       { request: undefined; response: { entries: Array<{ projectId: number; shellIndex: number; ports: number[] }> } };
  /**
   * One-shot resource snapshot for every alive shell. Samples `ps` per pid
   * so we get real %CPU / RSS from the OS (not a Node approximation). idleMs
   * is derived from PtyManager's lastDataAt clock — high idle + tiny CPU +
   * long uptime is the "hanging" heuristic the UI uses to flag rows red.
   */
  'shells:live-stats':  {
    request: undefined;
    response: {
      shells: Array<{
        projectId: number;
        shellIndex: number;
        projectName: string;
        pid: number;
        cpuPercent: number;   // 0..~100+, from ps
        memMB: number;        // resident set, MB
        uptimeMs: number;
        idleMs: number;       // ms since last pty:data event
        launchName: string;   // e.g. "Claude", "Terminal"
        hanging: boolean;
      }>;
    };
  };

  // settings
  'settings:get': { request: { key: keyof SettingsMap };                        response: { value: SettingsMap[keyof SettingsMap] } };
  'settings:set': { request: { key: keyof SettingsMap; value: SettingsMap[keyof SettingsMap] }; response: { ok: true } };
  'settings:set-font': { request: { key: FontSettingKey; value: unknown }; response: { value: FontFamilyPreference } };
  'settings:set-terminal-font-size': { request: { value: unknown; onlyIfUnset?: boolean }; response: { value: number; changed: boolean } };
  /** Validated write of the terminal font weight W; main also sets the bold weight to derivedBoldWeight(W), both in one transaction. changedKeys lists the keys whose stored value changed (empty = nothing written); emits settings:changed once per changed key. */
  'settings:set-terminal-font-weight': { request: { value: unknown }; response: { weight: TerminalFontWeight; boldWeight: TerminalFontWeight; changedKeys: Array<keyof SettingsMap> } };
  /** Validated write of the terminal bold weight; rejects a weight not heavier than the font weight in use (resolveTerminalWeights). changed=false when equal to the stored value. Emits settings:changed { key: 'terminal_bold_weight' } on change. */
  'settings:set-terminal-bold-weight': { request: { value: unknown }; response: { value: TerminalFontWeight; changed: boolean } };
  /** Validated replace of the whole app env map; rejects naming the key only; emits settings:changed { key: 'app_env' }. */
  'settings:set-app-env': { request: { env: Record<string, string> }; response: { env: Record<string, string> } };
  'settings:set-claude-permission-mode': { request: { mode: ClaudePermissionMode }; response: { mode: ClaudePermissionMode; changedKeys: Array<keyof SettingsMap> } };

  // notifications
  /**
   * The main window reports which shells it currently shows (active tab, plus
   * the right split pane when set; empty when no project or the Files tab is
   * showing). Main uses it to hold back Claude notifications for a shell the
   * user is viewing. Popouts are known to main already and are not reported.
   */
  'notifications:viewed-shells': { request: { shells: Array<{ projectId: number; shellIndex: number }> }; response: { ok: true } };

  // files (read-only)
  'files:tree':      { request: { projectId: number; relPath?: string };                    response: { entries: Array<{ name: string; isDir: boolean; relPath: string }> } };
  'files:read':      { request: { projectId: number; relPath: string; forceText?: boolean }; response: { content: string; kind: 'text' | 'binary'; sizeBytes: number } };
  'files:list-all':  { request: { projectId: number; limit?: number; filter?: string };     response: { files: Array<{ relPath: string; name: string }>; total: number; truncated: boolean } };
  'files:write':     { request: { projectId: number; relPath: string; content: string };    response: { ok: true; sizeBytes: number } };
  'files:mkdir':     { request: { projectId: number; relPath: string };                     response: { ok: true } };
  'files:rename':    { request: { projectId: number; from: string; to: string };            response: { ok: true } };
  'files:delete':    { request: { projectId: number; relPath: string };                     response: { ok: true } };
  'files:reveal':    { request: { projectId: number; relPath: string };                     response: { ok: true } };
  /**
   * Kick off a native OS drag session for one or more project-relative
   * paths. The renderer calls `preventDefault()` on its own dragstart so
   * Chromium's HTML5 drag doesn't fight ours, then invokes this channel;
   * the main process resolves absolute paths and calls
   * `webContents.startDrag(...)`. Users get a real file drag they can drop
   * into Finder, VS Code, iMessage, Mail, etc.
   */
  'files:start-drag':{ request: { projectId: number; paths: string[] };                      response: { ok: true } };
  'files:peek':      { request: { projectId: number; relPath: string; maxLines?: number };  response: { relPath: string; found: boolean; kind: 'text' | 'binary'; head: string; sizeBytes: number; totalLines: number | null } };
  'search:project':  { request: { projectId: number; query: string; caseSensitive?: boolean; regex?: boolean; maxFiles?: number; maxMatchesPerFile?: number }; response: { matches: Array<{ relPath: string; line: number; col: number; preview: string }>; filesScanned: number; truncated: boolean } };

  // Git — surfaced for the sidebar, status bar and Diff tab: status, staging, commit, push/pull.
  'git:status':      { request: { projectId: number }; response: { isRepo: boolean; branch: string | null; ahead: number; behind: number; files: Record<string, GitFileStatus>; dirty: boolean } };
  /** Detailed status for the git panel and Diff tab: staged vs unstaged split. */
  'git:panel-status': {
    request: { projectId: number };
    response: {
      isRepo: boolean;
      branch: string | null;
      ahead: number;
      behind: number;
      staged: GitChangeEntry[];
      unstaged: GitChangeEntry[];
      untracked: string[];
      /** git's error text when status could not be read (non-zero exit, timeout, output too large). Lists are then empty. */
      error?: string;
    };
  };
  'git:stage':       { request: { projectId: number; paths: string[] }; response: { ok: true } };
  'git:unstage':     { request: { projectId: number; paths: string[] }; response: { ok: true } };
  'git:commit':      { request: { projectId: number; message: string }; response: { ok: true } };
  'git:push':        { request: { projectId: number }; response: { ok: true; output: string } };
  'git:pull':        { request: { projectId: number }; response: { ok: true; output: string } };

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
  /** Returns the absolute path of the current electron-log file so users can attach it to a bug report. */
  'app:get-log-path':       { request: undefined; response: { path: string } };
  /** Returns the app version (`app.getVersion()`) for the status-bar footer / About dialog. */
  'app:get-version':        { request: undefined; response: { version: string } };
  /** Reveals the log file in Finder / File Explorer. */
  'app:reveal-log-file':    { request: undefined; response: { ok: true } };
  /**
   * Renderer→main handshake: "I'm mounted and listening for file-open
   * events". Main flushes anything buffered from a cold launch (e.g. the
   * .py the user double-clicked to start the app).
   */
  'app:renderer-ready-for-files': { request: undefined; response: { ok: true } };
  /** Reveals an arbitrary absolute file path in Finder / File Explorer. */
  'app:reveal-in-folder':   { request: { path: string }; response: { ok: true } };

  /* ─── metaproject chat (Flask-SocketIO backed) ─── */
  'metaproject:login':          { request: { username: string; password: string; remember?: boolean }; response: { userId: number; userName: string } };
  // Credentials persisted in the OS keychain (Keychain on macOS, libsecret on
  // Linux, Credential Vault on Windows). Never round-trip through the renderer.
  'metaproject:credentials-load':  { request: undefined; response: { username: string | null; hasPassword: boolean } };
  'metaproject:credentials-clear': { request: undefined; response: { ok: true } };
  'metaproject:auto-login':        { request: undefined; response: { ok: boolean; userName?: string; reason?: string } };
  'metaproject:status':         { request: undefined; response: { loggedIn: boolean; connected: boolean; userName: string | null; userId: number | null } };
  'metaproject:logout':         { request: undefined; response: { ok: true } };
  'metaproject:list-channels':  { request: { projectId: number }; response: { channels: Array<{ id: number; project_id: number; name: string; is_private: boolean }> } };
  /**
   * Workspace-scoped channel list. `scope` is either 'all' (every channel the
   * user can see across every project + globals), 'global' (org-wide only),
   * or a project_id number (that project + globals).
   */
  'metaproject:list-all-channels': { request: { scope: 'all' | 'global' | number }; response: { channels: Array<{ id: number; project_id: number | null; name: string; is_private: boolean }> } };
  /** Lists metaproject projects the current user can access — used by the "link project" picker. */
  'metaproject:list-projects':     { request: undefined; response: { projects: Array<{ id: number; name: string; identifier?: string | null }> } };
  /** Lists active users — used by the @-mention autocomplete in the composer. */
  'metaproject:list-users':        { request: undefined; response: { users: Array<{ id: number; username: string; email?: string; avatar_url?: string | null }> } };
  /** Creates a new metaproject project (kanban by default). */
  'metaproject:create-project':    { request: { name: string; description?: string; projectType?: 'kanban' | 'sprint' | 'dcad' }; response: { project: { id: number; name: string; identifier?: string | null } } };
  /**
   * Sets `project_id: <n>` in the local project's `.metaproject.yaml`. Creates
   * the file with sensible defaults if it doesn't exist, or does a regex
   * upsert on the `project_id` line otherwise. Also refreshes the projects
   * repo so Project.config.linkedMetaprojectProjectId reflects the change
   * without needing a full root rescan.
   */
  'metaproject:link-local-project': { request: { projectId: number; metaprojectProjectId: number }; response: { ok: true } };
  'metaproject:list-messages':  {
    request: { channelId: number; limit?: number; projectId?: number };
    response: {
      messages: Array<{
        id: number;
        channel_id: number;
        project_id?: number | null;
        user_id: number;
        user_name?: string;
        user?: { id: number; username: string; display_name?: string; avatar_url?: string | null };
        message: string;
        created_at: string;
        parent_message_id: number | null;
        attachments?: Array<{ id: number; filename: string; file_size: number; mime_type?: string | null }>;
      }>;
    };
  };
  'metaproject:join-channel':   { request: { channelId: number }; response: { ok: true } };
  'metaproject:send-message':   { request: { channelId: number; message: string; parentMessageId?: number | null }; response: { ok: true } };
  'metaproject:mark-read':      { request: { channelId: number; lastMessageId: number }; response: { ok: true } };
  'metaproject:edit-message':   { request: { channelId: number; messageId: number; message: string }; response: { ok: true } };
  'metaproject:delete-message': { request: { channelId: number; messageId: number }; response: { ok: true } };
  /**
   * Downloads a chat message attachment to the user's Downloads folder and
   * returns the absolute path we wrote to. Adds a ` (N)` suffix if the file
   * already exists so we never silently overwrite anything.
   */
  'metaproject:download-attachment': {
    request: { projectId: number; attachmentId: number; filename: string };
    response: { path: string };
  };

  /* ─── Prompt library (Claude / CLI snippets) ─── */
  /**
   * Lists globals ∪ project-scoped snippets. Pass `projectId: null` to see
   * only globals (used in the app-wide "manage prompts" surface when no
   * project is picked).
   */
  'prompts:list':   { request: { projectId: number | null }; response: { prompts: Array<{ id: string; projectId: number | null; title: string; body: string; tags: string[]; updatedAt: string }> } };
  /** Insert or update. Callers mint the id; empty title/body is rejected. */
  'prompts:save':   { request: { prompt: { id: string; projectId: number | null; title: string; body: string; tags?: string[] } }; response: { prompt: { id: string; projectId: number | null; title: string; body: string; tags: string[]; updatedAt: string } } };
  'prompts:delete': { request: { id: string }; response: { ok: true } };
  /**
   * Type text into a live shell as if the user pasted it. When
   * `submit: true` we append a carriage return so the shell runs it.
   * Callers should confirm with the user before submitting destructive
   * prompts.
   */
  'prompts:paste':  { request: { projectId: number; shellIndex: number; text: string; submit?: boolean }; response: { ok: true } };

  /* ─── Task runner (npm scripts / Makefile targets / compose services) ─── */
  'tasks:discover': { request: { projectId: number }; response: { tasks: Array<{ id: string; source: 'npm' | 'make' | 'compose'; name: string; command: string[]; description?: string }> } };
  /** Spawns the task as a new shell tab (auto-picked shellIndex). */
  'tasks:run':      { request: { projectId: number; taskId: string }; response: { shellIndex: number } };

  /* ─── Git diff (per-file) ─── */
  /**
   * Returns the unified diff for a single file. `staged: true` diffs the
   * index vs HEAD (what's in the "Staged" section of the panel); false
   * diffs the working copy vs the index. For untracked files, returns the
   * whole file as an add-diff so the viewer works uniformly. `origPath` is
   * the old path of a staged rename. `tooLarge` is set (and `diff` is '')
   * when git's output exceeded the 1 MiB cap.
   */
  'git:file-diff':  { request: { projectId: number; path: string; origPath?: string; staged?: boolean; untracked?: boolean }; response: { diff: string; tooLarge?: true } };
  /**
   * Side-by-side data for one Diff tab entry: the unified diff plus each
   * side's full content for highlighting. `unchanged` is returned when
   * sha1(diff) equals `ifDiffHashNot`; `too-large` when the diff exceeds
   * 1 MiB (no content is read).
   */
  'git:diff-sides': {
    request: { projectId: number; kind: GitDiffKind; path: string; origPath?: string; ifDiffHashNot?: string };
    response:
      | { status: 'ok'; diff: string; diffHash: string; oldSide: GitSideContent; newSide: GitSideContent }
      | { status: 'unchanged' }
      | { status: 'too-large' };
  };

  /* ─── Global scrollback search ─── */
  'shells:search-scrollback': {
    request: { query: string; caseSensitive?: boolean; regex?: boolean; contextLines?: number };
    response: {
      matches: Array<{
        projectId: number;
        shellIndex: number;
        projectName: string;
        launchName: string;
        pid: number;
        line: string;
        lineNumber: number;
        contextBefore: string[];
        contextAfter: string[];
      }>;
      shellsScanned: number;
    };
  };

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
  'ports:changed':          { projectId: number; shellIndex: number; ports: number[] };
  /** A shell's Claude state changed; sent to every window on real transitions only. */
  'claude-state:changed':   ClaudeShellStateEntry;
  /**
   * Fired when the user clicks an OS notification for a live shell — the
   * generic "command finished" one or a Claude "needs input" / "finished"
   * one. The renderer should switch to the named project, focus the shell
   * tab, and bring the window forward.
   */
  'shell:focus-request':    { projectId: number; shellIndex: number };
  /**
   * OS asked metaIDE to open a file (double-click in Finder, drop on the
   * Dock icon, "Open With…", or a second `metaide <path>` invocation).
   * Renderer routes to the matching project's Files tab, or offers to
   * add the file's parent as a new root if nothing matches.
   */
  'app:open-file-request':  { path: string };
}
export type IpcEventName = keyof IpcEvents;
