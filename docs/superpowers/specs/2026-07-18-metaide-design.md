# metaIDE — Functional Specification

**Date:** 2026-07-18
**Status:** Draft for review
**Owner:** willie@metalogix.solutions

---

## 1. Product Summary

**metaIDE** is a desktop application for developers whose primary workflow is
pair-programming with a CLI coding agent (Claude Code today; codex, gemini,
and other agents in the future). It is **not** a general-purpose IDE — it is
a **CLI-agent shell manager** that provides just enough project management,
Markdown editing, and team collaboration to let a developer stay in one
window across many projects.

The **Claude shell is the centerpiece of every screen**. Every other feature
(project sidebar, editor, chat, files) exists to make the shell more useful,
not to compete with it for attention.

### 1.1 Goals

1. Remember every project the user works on and make switching between them
   friction-free.
2. Auto-launch the correct CLI-agent command per project, with a global
   default and per-project overrides.
3. Let the user run multiple projects in parallel with keep-alive shells,
   pop-out windows, and a Wall Mode grid.
4. Integrate with the MetaLogix `metaproject` board so that per-project
   team chat, tickets, and documents are available inside the same window.
5. Keep the CLI agent binary up to date and let the user switch models
   without leaving the app.
6. Provide a competent Markdown editor (with light multi-language file
   viewing) so specs and notes live next to the shell.

### 1.2 Non-Goals (v1)

- Full IDE features: LSP, IntelliSense, refactor tools, debugger, git UI.
- Multiple shells per project.
- Persistent shell reattach across metaIDE restarts (Claude's `--continue`
  is sufficient for v1).
- Plugin/extension system.
- Mobile or web version.
- Voice/video in chat.
- First-class integrations (beyond `launch_cmd`) for non-Claude agents.

---

## 2. Foundational Decisions

| Decision            | Choice                                                          |
| ------------------- | --------------------------------------------------------------- |
| Runtime             | Electron (Node.js main + Chromium renderer)                     |
| UI framework        | React + TypeScript                                              |
| Terminal            | xterm.js with WebGL, unicode, link, search addons               |
| Editor              | CodeMirror 6                                                    |
| PTY layer           | `node-pty` in main process                                      |
| Local storage       | SQLite (via `better-sqlite3`) at `~/.metaide/metaide.db`        |
| Credentials         | macOS Keychain via `keytar`                                    |
| Metaproject reads/writes | Existing metaproject MCP server (reuses Claude Code's config) |
| Metaproject real-time | WebSocket to metaproject backend, short-lived ticket auth    |
| Auto-updater        | `electron-updater` against a GitHub Releases feed              |
| Packaging           | Signed & notarized `.dmg` (macOS), MSI (Windows), AppImage (Linux) |

---

## 3. Window Layout

### 3.1 Main window

```
┌─────────────────────────────────────────────────────────────┐
│ [Root: Documents/my projects  ▼]  │  [Project: metaIDE  ▼]  │
├──────────┬──────────────────────────────────────────────────┤
│ Roots &  │  ┌─ Shell ─┬ Editor ─┬ Chat ─┬ Files ─┬ Docs ─┐  │
│ Projects │  │                                             │  │
│  ├ ~/... │  │           CLAUDE SHELL (xterm.js)           │  │
│  │  ├P1  │  │           always mounted, always primary    │  │
│  │  ├P2* │  │                                             │  │
│  │  └P3  │  │                                             │  │
│  └ ~/... │  │                                             │  │
│    ├P4   │  └─────────────────────────────────────────────┘  │
│    └P5   │  status: model=Opus  perms=skip  session=cont    │
│ [Recents]│                                                  │
├──────────┴──────────────────────────────────────────────────┤
│ Presence: 3 online │ Unread: 2 mentions │ Claude v1.2.3 ↑  │
└─────────────────────────────────────────────────────────────┘
```

- **Left sidebar**: Registered root directories with projects nested and
  collapsible. Filter box on top. Bottom: **Recents** — last 10 opened
  projects across all roots, each with a small root chip.
- **Main pane**: Tabs — **Shell** (default landing tab), **Editor**, **Chat**,
  **Files**, **Docs**. The Shell tab is always mounted and never destroyed
  while the project is active; switching tabs is a visibility toggle.
- **Status bar**: model, permission mode, session state, presence count for
  the linked project, unread mentions across all projects, current CLI-agent
  version with update indicator.

### 3.2 Multi-window shell modes

Because PTYs live in the main process keyed by `project_id`, any renderer
window can attach as a viewport. This enables:

- **Pop-out** — Every shell tab has a detach button (also `Cmd+Shift+D`).
  Detaches the shell into its own borderless BrowserWindow with a minimal
  title bar showing project name, model, and session state. Close the window
  → shell re-docks into the main window's tab. Pop-out windows survive main
  window minimize/resize and can live on secondary monitors.

- **Wall Mode** — Button in the top bar (also `Cmd+Shift+W`). Enters a
  full-screen grid of every currently-alive shell (up to the keep-alive
  cap). Auto-tiled: 1 → full, 2 → side-by-side, 3–4 → 2×2, 5–6 → 3×2. Each
  tile shows project name, live output, and cursor if focused. Click a tile
  → focus it (keystrokes route there). Esc → exit Wall Mode, restore
  previous window state.

- **Session identity is independent of window** — You can pop out a shell,
  close the pop-out, enter Wall Mode, and the same PTY is there. No
  reconnect required.

### 3.3 Global keyboard shortcuts

| Shortcut       | Action                                                    |
| -------------- | --------------------------------------------------------- |
| `Cmd+K`        | Project switcher (fuzzy over all projects)                |
| `Cmd+1..5`     | Switch to Shell / Editor / Chat / Files / Docs tab        |
| `Cmd+,`        | Settings (project-scoped if a project is focused)         |
| `Cmd+Shift+M`  | Model switcher                                            |
| `Cmd+Shift+D`  | Detach current shell into pop-out                         |
| `Cmd+Shift+W`  | Toggle Wall Mode                                          |
| `Cmd+Shift+F`  | Find in project (ripgrep-backed)                          |
| `Cmd+/`        | Toggle comment (editor)                                   |
| `Cmd+S`        | Save (editor)                                             |

All shortcuts customizable in Settings → Keyboard Shortcuts.

---

## 4. Data Model

### 4.1 Local (SQLite: `~/.metaide/metaide.db`)

```sql
CREATE TABLE roots (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  added_at      DATETIME NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE projects (
  id                          INTEGER PRIMARY KEY,
  root_id                     INTEGER NOT NULL REFERENCES roots(id),
  path                        TEXT NOT NULL UNIQUE,
  name                        TEXT NOT NULL,
  metaproject_project_id      TEXT,               -- from .metaproject.yaml
  linked_chat_channel_id      TEXT,
  last_opened_at              DATETIME,
  pinned                      INTEGER NOT NULL DEFAULT 0,
  hidden                      INTEGER NOT NULL DEFAULT 0,
  first_launched              INTEGER NOT NULL DEFAULT 0,
  config_json                 TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE recent_projects (
  project_id  INTEGER PRIMARY KEY REFERENCES projects(id),
  opened_at   DATETIME NOT NULL
);

CREATE TABLE shells (
  project_id       INTEGER PRIMARY KEY REFERENCES projects(id),
  model            TEXT,
  launch_cmd_used  TEXT NOT NULL,
  started_at       DATETIME NOT NULL,
  last_active_at   DATETIME NOT NULL,
  pinned           INTEGER NOT NULL DEFAULT 0     -- exempt from LRU eviction
);

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL                            -- JSON
);

CREATE TABLE chat_cache (
  channel_id   TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  author_id    TEXT NOT NULL,
  body         TEXT NOT NULL,
  sent_at      DATETIME NOT NULL,
  cached_at    DATETIME NOT NULL,
  PRIMARY KEY (channel_id, message_id)
);
```

`shells` rows persist even after the PTY dies, to remember the last-used
model and launch command per project.

### 4.2 Per-project config (`projects.config_json`)

```json
{
  "launch_cmd": {
    "first": "claude --dangerously-skip-permissions",
    "subsequent": "claude --dangerously-skip-permissions --continue"
  },
  "cwd_override": null,
  "env": { "OPENAI_API_KEY": "..." },
  "model": "opus",
  "linked_metaproject_project_id": "PROJ-42",
  "notes": "freeform text"
}
```

Any `null` or missing field falls back to the corresponding global default
in `settings`.

### 4.3 Global settings keys

| Key                          | Value                                                 |
| ---------------------------- | ----------------------------------------------------- |
| `default_launch_cmd.first`   | `"claude --dangerously-skip-permissions"`             |
| `default_launch_cmd.subsequent` | `"claude --dangerously-skip-permissions --continue"` |
| `keep_alive_cap`             | `5`                                                   |
| `scan_depth`                 | `1`                                                   |
| `scrollback_lines`           | `10000`                                               |
| `theme`                      | `"dark"`                                              |
| `agent_registry`             | array of agents (see §6.3)                            |
| `mcp_metaproject_override`   | `null` or URL                                         |
| `telemetry_opt_in`           | `false`                                               |

### 4.4 Metaproject backend additions

New tables (in the metaproject Postgres database):

```sql
CREATE TABLE project_chat_channels (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('general', 'thread')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE project_chat_messages (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id         UUID NOT NULL REFERENCES project_chat_channels(id),
  author_user_id     TEXT NOT NULL,
  body               TEXT NOT NULL,
  sent_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at          TIMESTAMPTZ,
  deleted_at         TIMESTAMPTZ,
  parent_message_id  UUID REFERENCES project_chat_messages(id)
);
CREATE INDEX ON project_chat_messages (channel_id, sent_at DESC);

CREATE TABLE project_chat_mentions (
  message_id          UUID NOT NULL REFERENCES project_chat_messages(id) ON DELETE CASCADE,
  mentioned_user_id   TEXT NOT NULL,
  PRIMARY KEY (message_id, mentioned_user_id)
);

CREATE TABLE project_chat_reactions (
  message_id  UUID NOT NULL REFERENCES project_chat_messages(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  emoji       TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE project_chat_read_state (
  user_id                TEXT NOT NULL,
  channel_id             UUID NOT NULL REFERENCES project_chat_channels(id),
  last_read_message_id   UUID REFERENCES project_chat_messages(id),
  last_read_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel_id)
);
```

Presence is **not** persisted — Redis key
`presence:project:{project_id} → SET of user_ids` with per-connection TTL
60s (refreshed by heartbeat).

All tables respect the existing metaproject Row-Level Security policy
(user must have access to `project_id` to see any of its chat data).

---

## 5. Claude Shell Subsystem

The shell is the product's centerpiece; the rest of this spec exists to
support it.

### 5.1 PTY layer

- `node-pty` in the main process.
- One PTY per project, keyed by `project_id`.
- Each PTY object holds: `pid`, `cols`, `rows`, read/write streams, exit handler,
  scrollback ring buffer (server-side, for reattach after tab switch).
- Renderer connects to a PTY via IPC channel `pty:{project_id}` (bidirectional
  stream over Electron `MessagePort`).

### 5.2 Launch flow

When the user clicks a project (or `Cmd+K` selects one):

1. If `shells[project_id]` PTY is alive, focus its viewport in the current
   window. **Done.**
2. Otherwise resolve the launch command in this precedence:
   `projects.config_json.launch_cmd.<variant>` → `settings.default_launch_cmd.<variant>`
   where `<variant>` is `first` if `projects.first_launched = 0`,
   else `subsequent`.
3. Spawn PTY: `cwd = project.config_json.cwd_override || project.path`,
   `env = merge(process.env, config.env)`.
4. If PTY stays alive for >2s, set `projects.first_launched = 1`.
5. Insert a `shells` row, start keep-alive tracking.
6. Update `recent_projects` and `projects.last_opened_at`.

### 5.3 Keep-alive & eviction

- Configurable cap in `settings.keep_alive_cap`, default `5`.
- When spawning a new shell would exceed the cap, LRU-select an eviction
  candidate ordered by `shells.last_active_at ASC`, skipping `pinned = 1`
  and the just-clicked project.
- Show a confirmation: **"Close shell for `X`? [Yes / No / Pin]"**.
- "Pin" flips `shells.pinned = 1` and picks the next candidate.
- If no evictable candidates exist, show a "Keep-alive cap reached — pin one
  to make room" message and abort the switch.

### 5.4 Shell UI (xterm.js)

- WebGL renderer (`xterm-addon-webgl`) — falls back to canvas on failure.
- Unicode 11 addon.
- Link addon: `Cmd+click` opens URLs, `Cmd+click` on a file path opens in
  editor (if the path is inside the project root).
- Search addon: `Cmd+F` within the shell.
- Kitty graphics protocol passthrough for Claude's inline images.
- Scrollback: `settings.scrollback_lines` (default 10,000).

### 5.5 Model switcher (`Cmd+Shift+M`)

- Opens a mini-picker over the shell listing available models (Opus,
  Sonnet, Haiku).
- If the launch command starts with `claude`, sends `/model <name>\n` into
  the PTY (Claude Code accepts `/model` as an in-session command). No
  restart.
- If the launch command is a different agent (`codex`, `gemini`, etc.), the
  switcher is disabled with tooltip "Model switching not supported for this
  agent."
- If Claude is mid-response (detected by "no prompt for >500ms"), queue the
  command until the next idle prompt appears (detected by trailing
  `\n> ` or configurable regex per agent).
- Selected model is written to `shells.model` and reflected in the status bar.

### 5.6 Agent binary upgrade flow

- On app start and every 6 hours thereafter, run version check for every
  agent in `settings.agent_registry`:
  ```json
  {
    "name": "claude",
    "check_cmd": "claude --version",
    "npm_package": "@anthropic-ai/claude-code",
    "install_cmd": "npm i -g @anthropic-ai/claude-code@{version}"
  }
  ```
- Query npm registry HTTP API for `latest`.
- If newer than installed: status-bar badge **"claude v1.2.3 available ↑"**.
- Click → confirmation modal → run `install_cmd` in a spawned terminal,
  stream stdout/stderr into the modal.
- On success, prompt: **"Restart Claude shells now? [All / Choose / Later]"**.
  Chosen shells are killed and re-launched with the `subsequent` variant
  (which contains `--continue`, preserving session).
- Generalizes to any CLI agent registered in `agent_registry`.

### 5.7 Failure modes

| Failure                                | Handling                                                       |
| -------------------------------------- | -------------------------------------------------------------- |
| Launch cmd not on PATH                 | Shell tab shows error card + "Edit launch command" button.     |
| PTY exits within 2s of spawn           | Treated as crash. Do not flip `first_launched`. Show "Shell crashed — retry?" card with last 200 lines of stderr. |
| Model switch while Claude is not idle  | Queue the `/model` command; fire on next detected prompt.      |
| Model switch when PTY unresponsive     | Timeout after 10s, show toast "Model switch failed — try /model manually". |
| Upgrade `install_cmd` fails            | Modal shows full error; version badge stays until next check.  |
| Keep-alive cap reached and no evictable candidates | Refuse spawn, show message.                        |

---

## 6. Project Workspace

### 6.1 Root directories

- User adds roots via **Settings → Roots → Add**, picking an absolute path
  with the OS native folder picker.
- On first-run, metaIDE prompts to add a root, suggesting `~/Documents/my projects/`
  or `~/code/` if either exists.
- Roots are rescanned on app start, on window focus (debounced), and on
  manual **Refresh** button.
- `chokidar` watches each root shallowly for folder add/remove; new folders
  are auto-classified per §6.2.

### 6.2 Project discovery rules

A folder directly inside a root is treated as a project if **any**:

- Contains `.git/`
- Contains `.metaproject.yaml`
- Contains `package.json`, `pyproject.toml`, `Cargo.toml`, or `go.mod`
- Was explicitly added by the user via right-click → "Add as project"

Folders failing all rules are hidden by default. Right-click on a root header
→ **"Show unrecognized folders"** reveals them (grayed out) and allows manual
add.

Scan depth is configurable (`settings.scan_depth`, default `1`). Setting it
to `2` scans one level deeper (`~/roots/*/**/`), useful for monorepos where
projects live in subfolders.

### 6.3 Sidebar behavior

- Roots are collapsible headers, showing project count:
  `~/Documents/my projects (17)`.
- Projects within a root sort by: pinned first, then last-opened desc, then
  name.
- Roots are re-orderable by drag.
- Filter box at top of sidebar fuzzy-matches project name and root path.
- Right-click on a project → Open / Pin / Hide / Settings / Reveal in
  Finder / Remove.
- Right-click on a root → Rescan / Rename display / Remove.

### 6.4 Recents

- `recent_projects` updated on every shell spawn or focus.
- Sidebar "Recents" section shows top 10 recents, each with a colored dot
  matching its root's assigned color.
- `Cmd+K` project switcher ranks by: pinned → recent → fuzzy score.

### 6.5 `.metaproject.yaml` linkage

- On discovery, metaIDE parses `.metaproject.yaml` at the project root:
  ```yaml
  project_id: PROJ-42
  board_url: https://metaproject.internal
  ```
- `project_id` populates `projects.metaproject_project_id`.
- With linkage present, **Chat** and **Docs** tabs unlock.
- Without linkage, both tabs show an empty state: **"Link this project to a
  metaproject board"** with a picker that calls
  `mcp__metaproject__board_list_projects` and writes the choice back to
  `.metaproject.yaml`.

### 6.6 Settings panels

- **Project settings** — right-click a project → Settings, or `Cmd+,` while
  the project is focused. Form fields for every key in `config_json`. Each
  field has a **"Reset to global default"** action.
- **Global settings** — `Cmd+,` from the "no project selected" state, or
  from the menu bar. Tabs: General, Roots, Launch Commands, Agent Registry,
  Metaproject Connection, Appearance, Keyboard Shortcuts, Advanced.
- **Import/Export** — Global settings can be exported to and imported from a
  single JSON file for backup or sharing defaults across machines.

---

## 7. Editor & File Tree

### 7.1 Editor engine

- CodeMirror 6, single shared instance, virtual-DOM-friendly reuse across
  open tabs.
- Language modes via extension → mode map. Files with unknown extensions
  open as plain text.
- Explicitly excluded from v1: LSP, IntelliSense, autocomplete, refactor
  tools, debugger, git blame/gutters. The Claude shell is where intelligence
  lives.

Supported languages in v1:

| Extension                              | Mode            |
| -------------------------------------- | --------------- |
| `.md`, `.markdown`                     | Markdown        |
| `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`   | TypeScript/JS   |
| `.py`                                  | Python          |
| `.json`, `.jsonc`                      | JSON            |
| `.yaml`, `.yml`                        | YAML            |
| `.html`, `.htm`, `.css`, `.scss`       | HTML / CSS      |
| `.sh`, `.bash`, `.zsh`                 | Shell           |
| everything else                        | plain text      |

### 7.2 Markdown UX

- Split view: source (left) ↔ rendered preview (right). Toggleable to
  source-only or preview-only via a top-right button.
- Inline formatting decorations in source: bold shows bold, headers larger,
  links underlined and clickable with `Cmd+click`.
- Live preview refresh on keystroke, debounced 100ms.
- Rendered with `markdown-it` + `highlight.js` + GFM (tables, task lists,
  strikethrough, autolinks).
- Task list checkboxes are clickable in preview and toggle the source
  bidirectionally.
- Image paste → saved to `<project>/attachments/YYYY-MM-DD-HHMMSS-<hash>.png`,
  inserts `![](attachments/…)`.
- File drag-drop → same treatment, keeps original filename with a suffix on
  collision.

### 7.3 Editor commands

- `Cmd+S` save (dirty tab dot in title clears).
- `Cmd+Shift+P` inline command palette.
- `Cmd+/` toggle comment (mode-aware).
- `Cmd+F` find within file.
- `Cmd+Shift+F` find in project — spawns `rg` in the project root, results
  shown in a bottom panel, click to open.

### 7.4 Files tab

- File tree of the project root, backed by `chokidar` for live updates.
- Right-click actions: new file, new folder, rename, reveal in Finder,
  delete (moves to `.metaide/trash/`, **not** `rm -rf`), copy path.
- `.gitignore` respected: ignored files are grayed out and behind a
  "Show hidden" toggle.
- Double-click file → open in editor.
- Middle-click file → open in editor in a new tab (existing tabs preserved).

### 7.5 Docs tab (metaproject integration)

Two collapsible sections:

- **Ticket documents** — Lists tickets from the linked metaproject project
  via `mcp__metaproject__tickets_search(project_id=...)`. Expanding a
  ticket lists its docs via `ticket_document_get`. Click a doc → opens in
  editor with tab title `metaproject: PROJ-42/TICKET-X`.
- **Standalone documents** — Lists via
  `mcp__metaproject__standalone_documents_list(project_id)`. Click → open
  in editor.

Save-back:

- On doc open, capture the version/etag returned by `_get_raw`.
- On save, submit via `ticket_document_put_raw` / `standalone_documents_update`
  with the captured version.
- On 409 (version conflict), open a 3-way merge view: current buffer,
  server version, common ancestor if available. User picks: **Keep mine**
  (force overwrite), **Keep theirs** (discard local), or **Merge manually**.

### 7.6 Unsaved changes

- Dirty indicator (colored dot) in tab title.
- `Cmd+W` with dirty tab → prompt Save / Discard / Cancel.
- On app quit with any dirty tabs → single consolidated prompt listing all
  dirty tabs with per-tab checkboxes.

---

## 8. Metaproject Integration

### 8.1 Transport strategy

- **All reads/writes** for tickets, comments, documents, project lists, chat
  history, chat sends → **MCP calls to the metaproject MCP server**.
- **Real-time push** (new chat message, presence, typing) → direct WebSocket
  to metaproject backend, authenticated with a short-lived ticket obtained
  via a new MCP tool.
- Rationale: reuse the auth the user already has for Claude Code; no new
  auth flow, no PAT/OAuth infra. Cost: metaIDE requires the metaproject MCP
  server to be configured.

### 8.2 MCP client

- Runs in the main process using an MCP SDK (Anthropic's TypeScript MCP
  client library).
- On startup:
  1. Read `settings.mcp_metaproject_override` if set.
  2. Otherwise scan `~/.claude.json`, `~/.claude/mcp.json`, and
     `~/.config/claude/mcp.json` for a server entry named `metaproject`.
  3. Connect using the same URL and auth as Claude Code (bearer token or
     OAuth token, whichever the config specifies).
- Connection state exposed in status bar: **Connected / Connecting / Offline /
  Auth error**.
- Exponential backoff reconnect: 1s, 2s, 4s, 8s, 30s cap.
- If config is missing, first-run wizard walks the user through
  `claude mcp add metaproject <url>` (§9.1).

### 8.3 New MCP tools (added to metaproject MCP server)

| Tool                              | Purpose                                                     |
| --------------------------------- | ----------------------------------------------------------- |
| `chat_channels_list(project_id)`  | Return channels for a project. Auto-creates `#general` if none exist. |
| `chat_channel_create(project_id, name, kind)` | Create a channel (kind = `general` or `thread`). |
| `chat_messages_list(channel_id, before?, limit?)` | Paginated history, newest first.        |
| `chat_messages_send(channel_id, body, mentions?, parent_message_id?)` | Send a message. Returns full message row. |
| `chat_messages_edit(message_id, body)` | Edit own message.                                       |
| `chat_messages_delete(message_id)`     | Soft-delete own message.                                |
| `chat_reactions_toggle(message_id, emoji)` | Add or remove a reaction.                           |
| `chat_read_mark(channel_id, last_message_id)` | Update read state.                               |
| `chat_ws_ticket(project_id)`      | Return `{ws_url, token, expires_in}` (5 min).               |

All tools respect existing metaproject RLS.

### 8.4 WebSocket layer

- Endpoint: `wss://<metaproject-host>/ws/projects/{project_id}/chat`.
- Auth: `?ticket=<token>` query param on connect. Server validates ticket
  server-side, closes with code 4001 if invalid/expired.
- Client sends `{type: "ping"}` every 30s; server responds `{type: "pong"}`.
  Missed pong for 90s → force-close and reconnect (fetch fresh ticket first).
- Server → client events:
  ```json
  {"type": "message.new",     "channel_id": "…", "message": {…}}
  {"type": "message.edited",  "channel_id": "…", "message": {…}}
  {"type": "message.deleted", "channel_id": "…", "message_id": "…"}
  {"type": "presence.update", "project_id": "…", "online_user_ids": [...]}
  {"type": "typing.start",    "channel_id": "…", "user_id": "…"}
  {"type": "typing.stop",     "channel_id": "…", "user_id": "…"}
  {"type": "reaction.added"   | "reaction.removed", "message_id": "…", "user_id": "…", "emoji": "…"}
  ```
- Client → server events: `ping`, `typing.start`, `typing.stop`.
- Message sends still go through the MCP tool (single write path); WS is
  push-only for the client.

### 8.5 Failure modes

| Failure                          | Behavior                                                     |
| -------------------------------- | ------------------------------------------------------------ |
| MCP server unreachable           | Status bar shows Offline. Chat/Docs tabs show retry banner. Chat cache remains browsable read-only. |
| WS ticket rejected               | Refetch via MCP once; if refetch fails, drop to polling mode (list every 5s) with a "Reduced connectivity" banner. |
| MCP auth expired                 | Status bar shows Auth error. Modal prompts user to re-run `claude mcp add metaproject`. |
| Send fails on flaky network      | Retry 3× with 1s/2s/4s backoff. On final failure, message shown as failed in composer with "Retry" button. |

---

## 9. Chat UI

### 9.1 Layout

```
┌──────────┬──────────────────────────────────────┬──────────┐
│ Channels │   Messages                           │ Presence │
│          │                                      │          │
│ #general │   [@alice] 10:32                     │ ● alice  │
│ #design  │   Look at the shell layout mock —    │ ● bob    │
│ + New    │   [thread ▸ 3 replies]               │ ○ carol  │
│          │                                      │          │
│ Threads  │   [@you] 10:34                       │          │
│  ▸ shell │   Approved, moving on.               │          │
│  ▸ chat  │   😀 +2   ↳ Reply                    │          │
│          │                                      │          │
│          │   [Composer with @, emoji, attach]   │          │
└──────────┴──────────────────────────────────────┴──────────┘
```

### 9.2 Channel list

- Fetched on Chat tab open via `chat_channels_list`.
- If empty, `#general` auto-created on first tool call.
- New channel button → modal for name (validates unique per project) and
  kind (`general` only for v1; `thread` created implicitly from a message).
- Selection state persists per project.

### 9.3 Message list

- Virtualized via `react-virtual`.
- Grouped by author + minute (Slack-style collapse).
- Threaded replies rendered as an inline "N replies" link that expands.
- Reactions rendered as a horizontal bar under the message; click to
  toggle.
- Hover on a message reveals actions: React / Reply / Edit (own only) /
  Delete (own only) / Copy link.
- Historical loading: on scroll to top, fetch previous 50 via
  `chat_messages_list(channel_id, before=oldest_id, limit=50)`.

### 9.4 Composer

- Markdown-lite formatting: bold (`Cmd+B`), italic (`Cmd+I`), inline code
  (`Cmd+E`), link (`Cmd+K`), code block (triple-backtick or button).
- `@` triggers user picker: fuzzy over `users_list(project_id)` results.
- `:` triggers emoji picker.
- Drag-drop or paste of images/files → upload via
  `mcp__metaproject__attachments_upload` → inserted as
  `![name](attachment-id)`.
- `Cmd+Enter` sends; `Enter` inserts newline (configurable).

### 9.5 Notifications & unread state

- Unread count per channel = messages after `last_read_message_id`.
- Mentions of the current user are tracked separately; sidebar badges show
  mention count in red, non-mention unread in gray.
- OS-native notification (via Electron `Notification`) fires on `@mention`
  when metaIDE window is unfocused. Click → focuses window and jumps to
  the message.
- macOS dock icon shows a red badge with total mention count across all
  projects.
- `chat_read_mark` fires on scroll-to-bottom + on window blur if user was
  at bottom.

---

## 10. Auth & First Run

### 10.1 First-run wizard

1. **Welcome** screen with a one-paragraph pitch.
2. **Metaproject connection** — check for existing metaproject MCP config.
   - **Found** → verify by calling `metaproject_healthcheck`. Green check.
   - **Not found** → show instructions to run
     `claude mcp add metaproject <url>` in a system terminal, with a
     "Test connection" button that re-scans. Optionally provide a
     dry-run form to enter URL + token and metaIDE runs the command on
     the user's behalf (with `spawn`).
3. **Add first root** — folder picker. Suggest common defaults.
4. **Discovered projects** — show the projects found in that root, all
   toggle-enabled by default. User confirms.
5. **Ready** — closes wizard, opens the first project.

### 10.2 Settings surfaces

- **General** — theme (system/dark/light), telemetry opt-in, log level.
- **Roots** — add/remove/rescan.
- **Launch Commands** — global defaults for `first` and `subsequent`,
  editable multi-line.
- **Agent Registry** — table of known agents (`claude`, `codex`, `gemini`),
  each with `check_cmd`, `npm_package`, `install_cmd`. Add/edit/remove.
- **Metaproject Connection** — shows detected MCP server, override URL
  field, test button.
- **Appearance** — font family and size for shell and editor separately.
- **Keyboard Shortcuts** — full remap table.
- **Advanced** — DB path, log path, "Reset to defaults" (with backup
  export), config JSON export/import.

---

## 11. Non-Functional Requirements

### 11.1 Platforms & distribution

| Platform     | Version target      | Priority     | Package        |
| ------------ | ------------------- | ------------ | -------------- |
| macOS        | 12 Monterey or newer | Primary     | Signed & notarized `.dmg` |
| Windows      | 10 or newer         | Best-effort  | MSI installer  |
| Ubuntu       | 22.04 LTS or newer  | Best-effort  | AppImage       |

Auto-update via `electron-updater` against a GitHub Releases feed.

### 11.2 Performance targets

| Metric                                      | Target                     |
| ------------------------------------------- | -------------------------- |
| Cold start to sidebar                       | ≤ 2s                       |
| Project switch (shell already alive)        | ≤ 150ms                    |
| Project switch (spawning new shell)         | ≤ 800ms + agent startup    |
| Shell keystroke → visible echo              | ≤ 16ms (one frame @ 60Hz)  |
| Chat message send → visible in list         | ≤ 300ms                    |
| Memory with 5 idle keep-alive shells        | ≤ 400MB total              |

### 11.3 Reliability

- Crash reporter (opt-in) via Sentry, main + renderer processes.
- Rotating logs in `~/.metaide/logs/`, 7-day retention.
- No shell content, chat message body, or file content ever leaves the
  machine except through the user-configured metaproject connection.

### 11.4 Testing

- **Unit** — Vitest, main + renderer.
- **E2E** — Playwright driving headless Electron, coverage for: first-run
  wizard, adding a root, launching a shell, switching projects, model
  switcher, upgrade banner (with a mocked npm registry), send/receive
  chat message (against mock MCP + WS server), pop-out and Wall Mode.
- **Integration** — Mock metaproject MCP server (in-repo, TS) implementing
  the tool subset used, and a mock WS server that echoes fixture events.

### 11.5 Accessibility

- All actions reachable by keyboard.
- Screen reader labels on all interactive elements.
- High-contrast theme opt-in.
- Configurable font sizes for shell and editor independently.
- Respects OS reduce-motion preference (no animations when on).

### 11.6 Security

- Credentials in macOS Keychain (Windows Credential Manager / libsecret
  fallback); never in SQLite or config files on disk.
- All spawned subprocesses use fully-qualified argument arrays (no shell
  interpolation) to avoid command injection through project paths.
- MCP config file read paths are user-scoped only; symlinks are not
  followed.
- Electron: `nodeIntegration: false`, `contextIsolation: true`, strict CSP
  in renderer, preload script whitelists IPC channels.

---

## 12. Out of Scope for v1

The following are intentionally deferred:

- LSP / IntelliSense / debug / refactor tools in the editor.
- Multiple simultaneous shells per project.
- `tmux` / `dtach` shell reattach across metaIDE process restarts (Claude
  `--continue` is the v1 substitute).
- Voice or video in chat.
- Mobile or web version.
- Plugin/extension system.
- First-class git UI (use the shell).
- Terminal multiplexing (splits/tabs) inside a single shell tab.
- Model switcher integrations beyond Claude for v1 (launch-command config
  for other agents is supported; deep in-session controls are not).
- Multi-tenant metaproject switching in one metaIDE instance.
- **`metaide` CLI** (see §13 for the idea) — deferred to a later phase.

---

## 13. Open Questions

None blocking v1 as specified. Items to revisit before v2:

- Do we want to allow multiple shells per project once user demand shows
  it's needed? If yes, keying by `project_id` becomes `(project_id, shell_index)`.
- Should the chat backend support external identity providers (Slack,
  Discord bridges) or stay metaproject-only?
- Is a `tmux`-based session persistence layer worth the complexity for
  v2, or does `--continue` remain sufficient?
- **Companion `metaide` CLI** (future): a first-class command-line tool
  that operates on the same SQLite state as the desktop app, so the user
  (and the Claude shell itself) can manage projects without leaving the
  terminal. Sketch:
  - `metaide ls` — list roots and projects, with alive-shell markers.
  - `metaide open <fuzzy>` — spawn or focus a shell for the matched project;
    when invoked from inside metaIDE, opens in the current window; when
    invoked from an external terminal, brings metaIDE to the foreground.
  - `metaide switch <fuzzy>` — same as `open` but stays on current tab.
  - `metaide status` — current project, alive shells, unread mentions.
  - `metaide roots add <path>` / `metaide roots ls`.
  - `metaide config get|set <key> [<value>]` — read/write global or
    per-project settings.
  - `metaide wall` — enters Wall Mode in the running metaIDE.
  - `metaide chat send <project> <message>` — send a chat message to a
    project's `#general` from the CLI.
  This makes metaIDE scriptable and lets Claude itself call the CLI as a
  tool to reorganize the workspace during a session. Requires deciding
  whether the CLI talks to a running metaIDE via a local Unix socket, or
  writes directly to the SQLite state with a file lock.

---

## 14. Delivery Phases

Suggested cut-lines for incremental delivery, in order:

**Phase 1 — Shell-first MVP**
- Electron scaffold, xterm.js, PTY per project.
- SQLite schema, roots + projects + discovery.
- Sidebar, project switcher, keep-alive with cap.
- Global settings for launch commands.
- No chat, no editor, no Docs. Files tab read-only.

**Phase 2 — Editor & Files**
- CodeMirror integration, Markdown UX, split preview.
- Files tab full CRUD.
- Find in project.

**Phase 3 — Metaproject Integration**
- MCP client, Docs tab (view/edit ticket + standalone docs).
- First-run wizard flow.

**Phase 4 — Chat**
- Backend: new tables, MCP tools, WS endpoint.
- Client: Chat tab, presence, notifications, mentions.

**Phase 5 — Polish & Power Features**
- Pop-out shells and Wall Mode.
- Model switcher, upgrade flow.
- Auto-updater, telemetry, crash reporting.
- Full E2E suite.

Each phase is releasable to internal users on its own.

---

**End of specification.**
