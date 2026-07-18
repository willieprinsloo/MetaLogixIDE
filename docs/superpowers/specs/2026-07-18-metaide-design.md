# metaIDE — Functional Specification

**Date:** 2026-07-18
**Version:** v0.2
**Status:** Draft for review — incorporates senior-developer peer review
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
   team chat, tickets, documents, and a live **Kanban board** are all
   available inside the same window and swappable with a single keystroke.
5. Keep the CLI agent binary up to date and let the user switch models
   without leaving the app.
6. Provide a competent Markdown editor (with light multi-language file
   viewing) so specs and notes live next to the shell.

### 1.2 Non-Goals (v1)

- Full IDE features: LSP, IntelliSense, refactor tools, debugger, git UI.
- Multiple shells per project **in the UI**. (Schema is pre-keyed for v2 —
  see §4.1.)
- Persistent shell reattach across metaIDE restarts (Claude's `--continue`
  is sufficient for v1). v2 will support attaching to *user-managed* tmux
  sessions rather than metaIDE managing its own.
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
│ Roots &  │  ┌─ Shell ─┬ Board ─┬ Editor ─┬ Chat ─┬ Files ─┬ Docs ─┐│
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
- **Main pane**: Tabs — **Shell** (default landing tab), **Board**, **Editor**,
  **Chat**, **Files**, **Docs**. The Shell tab is always mounted and never
  destroyed while the project is active; switching tabs is a visibility
  toggle. **Cmd+B** toggles between Shell and Board — the two most-used
  views — for one-keystroke context swap.
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
| `Cmd+1..6`     | Switch to Shell / Board / Editor / Chat / Files / Docs tab |
| `Cmd+B`        | Toggle Shell ↔ Board (fast context swap)                  |
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

**PRAGMAs on open:** `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`.
Daily automatic backup to `~/.metaide/backups/metaide-YYYYMMDD.db`, 7-day
rotation. Migrations tracked via a `schema_version` table; each release ships
forward-only migrations in numbered `.sql` files.

```sql
CREATE TABLE schema_version (
  version    INTEGER NOT NULL,
  applied_at DATETIME NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (version)
);

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
  first_launched_at           DATETIME,           -- NULL = never launched
  config_json                 TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE recent_projects (
  project_id  INTEGER PRIMARY KEY REFERENCES projects(id),
  opened_at   DATETIME NOT NULL
);

CREATE TABLE shells (
  project_id       INTEGER NOT NULL REFERENCES projects(id),
  shell_index      INTEGER NOT NULL DEFAULT 0,   -- pre-keyed for v2 multi-shell
  model            TEXT,
  launch_argv_json TEXT NOT NULL,                 -- JSON array of args
  started_at       DATETIME NOT NULL,
  last_active_at   DATETIME NOT NULL,
  pinned           INTEGER NOT NULL DEFAULT 0,    -- exempt from LRU eviction
  PRIMARY KEY (project_id, shell_index)
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

Launch commands are stored as **argv arrays**, not shell strings, to
prevent command injection through project paths and to make substitution
explicit. Templates may contain interpolation tokens: `${HOME}`,
`${PROJECT_PATH}`, `${PROJECT_NAME}`, and any env var name in
`${env.VAR}`. Substitution happens after argv splitting, so tokens can
never introduce new arguments.

```json
{
  "launch_cmd": {
    "first":      { "argv": ["claude", "--dangerously-skip-permissions"], "env": {} },
    "subsequent": { "argv": ["claude", "--dangerously-skip-permissions", "--continue"], "env": {} }
  },
  "cwd_override": null,
  "env": { "OPENAI_API_KEY": "..." },
  "model": "opus",
  "first_launched_at": null,
  "linked_metaproject_project_id": "PROJ-42",
  "notes": "freeform text"
}
```

`first_launched_at` is a nullable timestamp (not a boolean) so a user can
"Reset first-launch state" from the project settings — useful after clearing
`~/.claude/` state or moving the project directory.

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
  client_message_id  UUID NOT NULL,             -- for optimistic-UI dedup
  body               TEXT NOT NULL,
  sent_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at          TIMESTAMPTZ,
  deleted_at         TIMESTAMPTZ,
  parent_message_id  UUID REFERENCES project_chat_messages(id),
  UNIQUE (channel_id, client_message_id)
);
CREATE INDEX ON project_chat_messages (channel_id, sent_at DESC);
CREATE INDEX ON project_chat_messages (author_user_id, sent_at DESC);

-- Enforce single-level threading at the tool layer:
-- when parent_message_id is set, the parent's parent_message_id MUST be NULL.

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
- One PTY per project in v1, keyed by `(project_id, shell_index)` where
  `shell_index = 0` always. The composite key exists in the schema so v2
  multi-shell adds do not require a migration.
- Each PTY object holds: `pid`, `cols`, `rows`, authoritative scrollback ring
  buffer (server-side headless emulator, so any viewport can render the
  current screen at any time), read/write streams, exit handler.
- Renderer connects to a PTY via IPC channel
  `pty:{project_id}:{shell_index}` over Electron `MessagePort`.
- **Backpressure**: PTY output is chunked at 16 KiB and paused when the
  MessagePort queue exceeds 4 MiB unread. Resumed when the renderer drains.
  Prevents a runaway `find /` from OOM'ing the renderer.

**Multi-viewport arbitration (pop-out + Wall Mode + main-tab):**

Because multiple BrowserWindows can attach to the same PTY, the main
process enforces:

- **Exactly one input owner** per PTY at a time — the most-recently focused
  viewport. Only the input owner's keystrokes reach the PTY; other
  viewports render as read-only mirrors with a subtle "read-only" chip.
  Focusing another viewport transfers ownership atomically (announced via
  IPC event `pty:{id}:input_owner_changed`).
- **Resize policy**: PTY dimensions = **smallest `cols` × smallest `rows`
  across all attached viewports**. Ensures no viewport clips output.
  Debounced 100ms to avoid resize storms during window drags.
- **Scrollback rendering**: primary viewport (input owner) controls scroll
  position broadcast to mirrors. Mirrors can locally scroll into
  scrollback (read-only) — a "return to live" button re-follows.
- **Selection**: local to each viewport; not synchronized.

### 5.2 Launch flow

When the user clicks a project (or `Cmd+K` selects one):

1. If `shells[project_id, 0]` PTY is alive, focus its viewport in the
   current window. **Done.**
2. Otherwise resolve the launch command in this precedence:
   `projects.config_json.launch_cmd.<variant>` → `settings.default_launch_cmd.<variant>`
   where `<variant>` is `first` if `projects.first_launched_at IS NULL`,
   else `subsequent`.
3. Interpolate tokens (`${HOME}`, `${PROJECT_PATH}`, `${PROJECT_NAME}`,
   `${env.X}`) in the argv array. Interpolation is applied per-element —
   never as a shell string, so a project path with spaces or shell
   metacharacters cannot escape argv.
4. Spawn PTY with `command = argv[0]`, `args = argv[1..]`,
   `cwd = project.config_json.cwd_override || project.path`,
   `env = merge(process.env, template.env, config.env)`. Uses
   `node-pty.spawn(command, args, opts)` — no shell involved.
5. If PTY stays alive for >2s, set `projects.first_launched_at = now()`.
6. Insert a `shells` row, start keep-alive tracking.
7. Update `recent_projects` and `projects.last_opened_at`.

### 5.3 Keep-alive & eviction

Users juggle 15–20 projects; a confirmation modal on every switch would be
hostile. Instead:

- Configurable cap in `settings.keep_alive_cap`, default `5`.
- An **Alive Shells panel** (opens from the status bar or `Cmd+Shift+A`)
  lists every currently-alive PTY with project name, last-activity age,
  and per-row Pin / Close buttons. This is the visible surface for
  managing the pool — users don't get surprised.
- When spawning a new shell would exceed the cap, silently LRU-evict the
  oldest unpinned shell (ordered by `shells.last_active_at ASC`,
  skipping `pinned = 1`). Show a toast **"Closed shell for X (idle 47m).
  Pin it next time to keep it alive."** Toast is dismissable and has an
  Undo action (respawns via `subsequent` variant).
- **Warn instead of silent-evict** if the LRU candidate has activity in
  the last 60s (Claude was mid-response, or user typed recently): show
  the modal `"Close busy shell for X? [Keep / Close / Pin]"`. Prevents
  killing an in-flight response the user cares about.
- If all shells are pinned and cap reached, show `"Pinned-shell cap
  reached — unpin one or raise the cap in settings."` and abort spawn.

### 5.4 Shell UI (xterm.js)

- WebGL renderer (`xterm-addon-webgl`) — falls back to canvas on failure.
- Unicode 11 addon.
- Link addon: `Cmd+click` opens URLs, `Cmd+click` on a file path opens in
  editor (if the path is inside the project root).
- Search addon: `Cmd+F` within the shell.
- Kitty graphics protocol passthrough for Claude's inline images.
- Scrollback: `settings.scrollback_lines` (default 10,000).

### 5.5 Model switcher (`Cmd+Shift+M`)

- Opens a mini-picker over the shell listing models declared for the
  current agent in `settings.agent_registry` (Claude ships with Opus,
  Sonnet, Haiku).
- Model switching is **agent-declared**, not hard-coded. Each agent entry in
  the registry may declare:
  ```json
  {
    "model_switch_cmd": "/model {name}\n",
    "idle_prompt_regex": "\\n\\s?> $",
    "supported_versions": ">=1.0.0"
  }
  ```
- Before injecting, metaIDE runs `check_cmd` to get the current agent
  version and checks it against `supported_versions`. On mismatch, the
  switcher is disabled with tooltip: `"Model switch not supported for
  {agent} {version} — update the agent registry or upgrade the agent."`
- The idle-prompt regex is user-editable per agent so users can adapt
  to Claude Code TUI prompt changes without waiting for a metaIDE release.
- If Claude is mid-response (regex not matched), queue the command; on
  next idle, inject.
- **Fail loudly, not silently**: if the queued injection does not fire
  within 10s of queueing, cancel it and show a toast:
  `"Model switch timed out — try /model manually in the shell."` Do NOT
  leave zombie queued injections.
- Selected model is written to `shells.model` and reflected in the status
  bar only after we detect the injected command was echoed (grep the next
  PTY chunk for the model name we sent).

### 5.6 Agent binary upgrade flow

- Persisted `last_upgrade_check_at` per agent in `settings`; skip check if
  the previous run was <6h ago. On app start and every 6h thereafter,
  run version check for every agent in `settings.agent_registry`.
- Agent registry entry:
  ```json
  {
    "name": "claude",
    "check_cmd": ["claude", "--version"],
    "package_name": "@anthropic-ai/claude-code",
    "package_registry": "npm",
    "model_switch_cmd": "/model {name}\n",
    "idle_prompt_regex": "\\n\\s?> $"
  }
  ```
- **Install-method detection**: run `which claude` to get the resolved
  path, then classify:
  - Path under `~/.nvm/`, `~/.volta/`, `~/.fnm/`, `~/n/` → node-version-manager
    scenario, use that manager's global install
  - Path under `/opt/homebrew/`, `/usr/local/Cellar/` → Homebrew,
    suggest `brew upgrade claude`
  - Path under `/usr/local/lib/node_modules/` → system npm, may need
    `sudo` — do NOT auto-run `sudo`; surface the exact command
  - Anything under a `pnpm`/`yarn` global folder → suggest that manager's
    upgrade command
- Command is proposed in the confirmation modal — never blindly executed.
  User sees `"Detected install: nvm at ~/.nvm/versions/node/v20/. Run:
  npm i -g @anthropic-ai/claude-code@1.2.3 (Y/N)"` and confirms.
- Failure output streamed into the modal in full; version badge stays
  until next check.
- **Do not interrupt active shells**: before prompting "Restart Claude
  shells now?", check `last_active_at` for each — shells with activity
  in the last 60s are un-checked by default in the "Choose" list. Also
  refuse `electron-updater` restart when any shell has activity in the
  last 60s; show a "Update available — restart when convenient" banner
  instead.
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

**Watched-path cap**: total watched directories across all roots capped at
`settings.max_watched_paths` (default `500`). When exceeded, watching is
disabled for the newest-added root and a status-bar indicator shows
**"Watching 500/500 paths — file changes may be missed"** with a link to
the roots settings. Users can raise the cap knowingly.

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
- On 409 (version conflict), open a **2-way merge view** for v1: current
  buffer (left) vs. server version (right). User picks: **Keep mine**
  (force overwrite with the new version), **Keep theirs** (discard local),
  or **Merge manually** (opens a plain editor with both versions
  concatenated as `<<<<<<< / ======= / >>>>>>>` conflict markers).
- 3-way merge with a common ancestor is deferred to v2, contingent on
  metaproject exposing a `documents_history` endpoint that returns the
  ancestor blob. Attempting 3-way without a real ancestor is worse than
  a clear 2-way choice.

### 7.6 Unsaved changes

- Dirty indicator (colored dot) in tab title.
- `Cmd+W` with dirty tab → prompt Save / Discard / Cancel.
- On app quit with any dirty tabs → single consolidated prompt listing all
  dirty tabs with per-tab checkboxes.

---

## 7A. Board Tab (metaproject Kanban embed)

The Board tab is **not** a re-implementation of a Kanban UI. It embeds the
existing metaproject board web app in an Electron `BrowserView`. Users get
the exact same board they use in a browser — same features, same
navigation, same drag-drop — with zero UI drift between metaIDE and the
web experience.

### 7A.1 Behavior

- Tab available only when `projects.metaproject_project_id` is set (same
  gating as Chat and Docs).
- On tab activation, a `BrowserView` is mounted covering the main pane
  and navigated to `<metaproject_base_url>/board/<metaproject_project_id>`
  (base URL resolved from the MCP server config or
  `settings.metaproject_web_url` override).
- Cmd+B toggles between Shell and Board. If Board has never been opened
  for this project in this session, activating it lazily creates the
  BrowserView; subsequent toggles are instant.
- Reload button and "Open in browser" button live in the top-right of
  the tab, alongside the metaproject board's own controls.
- On network failure, an overlay shows **"Board offline — retry"** with
  a manual retry.

### 7A.2 Auth

- The BrowserView shares a persistent session partition
  (`persist:metaproject`) so the user's normal login session survives
  across metaIDE restarts.
- On first activation, if the loaded page detects "not logged in", the
  metaproject web app handles login itself (SSO redirect flow). metaIDE
  is not involved.
- Optional: metaIDE can call a new MCP tool `web_session_cookie()` that
  returns a short-lived cookie the app can inject before load, for
  single-sign-on convenience. If the tool is unavailable, fall back to
  the standard web login. This is a v2 enhancement — v1 uses the user's
  existing browser session flow.

### 7A.3 Security

- BrowserView runs with `contextIsolation: true`, no Node integration.
- Only the metaproject origin is allowed; navigation attempts to any
  other origin open in the OS default browser instead of inside the
  BrowserView.
- The BrowserView cannot access metaIDE's IPC channels or main-process
  APIs.

### 7A.4 Explicitly not in scope

metaIDE does **not** re-render metaproject's board data, filter it,
customize it, or add any board features. Anything the board team ships
appears automatically; anything they remove disappears automatically.
Board changes are handled entirely by the metaproject web app team.

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
- **Long-lived** connection, held open for the app's lifetime — not
  reconnected per call. Chat message throughput would suffer with
  per-call reconnect.
- On startup:
  1. Read `settings.mcp_metaproject_override` if set.
  2. Otherwise scan `~/.claude.json`, `~/.claude/mcp.json`, and
     `~/.config/claude/mcp.json` for server entries with `name: "metaproject"`.
  3. If multiple `metaproject` entries exist (e.g., dev + prod), prompt the
     user to select one on first-run and persist the choice to
     `settings.mcp_metaproject_selected_name`.
  4. Connect using the same URL and auth as Claude Code (bearer token or
     OAuth token, whichever the config specifies).
- **Config drift detection**: metaIDE watches all three config files with
  `chokidar`. On change, re-parse and, if the metaproject entry changed
  or was removed, show a status-bar chip **"Metaproject config
  changed — reconnect"** with a one-click reconnect action. If the entry
  was removed entirely, chat/docs/board tabs enter the Offline state
  with a first-run wizard entry point.
- **Health probes**: every 30s the client calls `metaproject_healthcheck`.
  Failure → status bar → Offline.
- Connection state exposed in status bar: **Connected / Connecting /
  Offline / Auth error / Config changed**.
- Exponential backoff reconnect: 1s, 2s, 4s, 8s, 30s cap.
- If config is missing, first-run wizard walks the user through it (§10.1).

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
| `chat_ws_ticket(project_id)`      | Return `{ws_url, token, expires_in}` (5 min). Token is opaque, single-use, bound to the requesting user's session. See §8.4 for delivery. |
| `web_session_cookie()`            | (v2) Return a short-lived cookie for BrowserView SSO into the metaproject web app. |

All tools respect existing metaproject RLS.

### 8.4 WebSocket layer

- Endpoint: `wss://<metaproject-host>/ws/projects/{project_id}/chat`.
- **Auth via first-frame message, not URL query.** Ticket query params leak
  into server access logs, HTTPS proxy logs, and any error-tracker
  breadcrumbs. Instead:
  1. Client opens WS with no auth params.
  2. Server accepts the socket in an unauthenticated state and waits ≤5s
     for a `{"type": "auth", "ticket": "<token>"}` frame.
  3. Server validates ticket, replies `{"type": "auth.ok", "user_id": ...}`
     or closes with code 4001 (`"invalid ticket"`) / 4008 (`"auth timeout"`).
  4. Only after `auth.ok` does the server send any project data.
- Alternative accepted: pass ticket via `Sec-WebSocket-Protocol` header.
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
- **Per-channel notification mute** with three levels: All / Mentions only
  (default) / None. Right-click a channel → Mute. Muted channels still
  update unread badges but do not fire OS notifications.
- **Global rate limit**: max 5 OS notifications per rolling 60s window,
  configurable. Excess notifications are coalesced into a single
  **"N new mentions"** notification.
- **Do-not-disturb**: user can set DND via a status-bar toggle or a
  schedule (e.g., 22:00–08:00). Notifications are queued (not suppressed)
  and shown as an "unread" summary on next focus.
- macOS dock icon shows a red badge with total mention count across all
  projects (not affected by rate limit or DND — badge is always accurate).
- `chat_read_mark` fires on scroll-to-bottom + on window blur if user was
  at bottom.

---

## 10. Auth & First Run

### 10.1 First-run wizard

1. **Welcome** screen with a one-paragraph pitch.
2. **Metaproject connection** — check for existing metaproject MCP config.
   - **Found** → verify by calling `metaproject_healthcheck`. Green check.
   - **Not found** → offer two paths:
     - **"Show me the CLI command"** — displays
       `claude mcp add metaproject <url>` with a copy button and a "Test
       connection" button that re-scans. User runs it themselves in a
       terminal. Safest.
     - **"Configure directly"** — form for URL + auth token. metaIDE
       **writes directly to `~/.claude.json`** using a documented,
       version-checked schema. Before writing, metaIDE validates the
       existing file's schema version (top-level `version` key) and
       aborts with the manual-instructions path if unfamiliar. This
       avoids fragility of `spawn`ing another tool's CLI while giving
       users a smooth path when the schema is known.
     - Neither option is skipped — user picks explicitly.
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
- All spawned subprocesses receive **argv arrays**, never shell strings.
  `launch_cmd` is stored as `{argv: string[], env: {...}}` in config.
  The settings UI for editing launch commands shows the tokenized argv
  so users can see exactly what will be executed. Command injection via
  project paths is thereby impossible: interpolation is per-element and
  cannot introduce new arguments.
- **RLS test suite**: chat MCP tools ship with an explicit integration
  test suite that exercises cross-tenant and cross-project access
  attempts. Requirement: cross-tenant reads MUST return empty results,
  not 4xx (returning a 404-vs-403 distinction leaks existence). Tests
  block Phase 4 sign-off.
- MCP config file read paths are user-scoped only; symlinks are not
  followed. Config file writes (§10.1) are atomic (temp file + rename)
  and preserve prior content on parse failure.
- **Auto-update artifact signing**: the release feed itself is signed
  (macOS notarization + Windows Authenticode + `electron-updater` code
  signature verification). An unsigned update is refused, even manually.
- Electron: `nodeIntegration: false`, `contextIsolation: true`, strict CSP
  in renderer, preload script whitelists IPC channels.
- **IPC contract**: an explicit typed IPC surface is defined (see §11.7).
  Ad-hoc `ipcRenderer.invoke` on undeclared channels is a lint error.
- **WS ticket handling**: tickets never appear in URLs (§8.4). They live
  only in the first WS frame and are never logged.
- **BrowserView origin lock**: the Board tab BrowserView (§7A) refuses
  navigation to non-metaproject origins; off-origin links open in the OS
  default browser.

### 11.7 IPC contract

A single TypeScript module `src/shared/ipc-contract.ts` declares every
IPC channel with its request and response types. The preload script
exposes only functions defined in this contract; the main-process
handler map is code-generated from it. Renderer code cannot use
`ipcRenderer.invoke` directly — a lint rule (`no-restricted-imports`)
forbids the raw API.

Channel categories:

- `pty:{project_id}:{shell_index}:*` — attach, detach, resize, input,
  input_owner_changed, backpressure, exit.
- `project:*` — list, open, switch, pin, hide, settings-update.
- `roots:*` — add, remove, rescan.
- `mcp:*` — call (typed by tool name), connection-state.
- `chat:ws:*` — connect, disconnect, event (typed).
- `dialogs:*` — folder picker, save picker.
- `updater:*` — check, download, install-and-restart.

Adding a channel requires editing the contract file, which triggers CI
type-check and lints. No silent channels.

---

## 12. Out of Scope for v1

The following are intentionally deferred:

- LSP / IntelliSense / debug / refactor tools in the editor.
- Multiple shells per project **in the UI** (schema is pre-keyed for v2).
- `tmux` / `dtach` reattach managed by metaIDE. v2 will detect and attach
  to *user-managed* tmux sessions instead of metaIDE managing its own.
- Voice or video in chat.
- Mobile or web version.
- Plugin/extension system.
- External IdP bridges for chat (Slack/Discord) — metaproject-only, now
  and later. If needed at all, only one-way outbound webhooks
  (metaproject → external) will ever be considered.
- First-class git UI (use the shell).
- Terminal multiplexing (splits/tabs) inside a single shell tab.
- Model switcher integrations beyond agent-declared entries (any agent
  that declares `model_switch_cmd` + `idle_prompt_regex` works out of
  the box; deeper per-agent controls are v2).
- Multi-tenant metaproject switching in one metaIDE instance (v2 —
  multiple MCP entries currently prompt selection at first-run).
- **`metaide` CLI** (see §13) — deferred to Phase 6+.
- Custom Kanban rendering — Board tab embeds the metaproject web board
  (§7A); we never build our own board.
- 3-way document merge — v1 is 2-way (§7.5); 3-way waits for a
  metaproject `documents_history` endpoint.

---

## 13. Open Questions

None blocking v1 as specified.

**Resolved in review** (recorded here for traceability — see §15 revision
history):

- *Multiple shells per project*: **v2 with schema pre-keyed now.** The
  schema uses `(project_id, shell_index)` composite PK from v1; UI is
  single-shell in v1; multi-shell UI in v2 is a UI-only change.
- *External IdP bridges (Slack/Discord)*: **never inbound.** Consider
  one-way outbound webhooks only if there's real demand.
- *tmux managed by metaIDE*: **no.** v2 detects and attaches to
  *user-managed* tmux sessions instead.
- *`metaide` CLI transport*: **Unix domain socket (UDS) to a running
  metaIDE.** SQLite file-lock loses on three counts — no event push,
  logic duplication, and cached-state ghost writes. UDS gives a single
  source of truth. Fallback: CLI can spawn a headless metaIDE
  (`--headless`) and connect if none is running.

**Remaining open questions to revisit before v2:**

- Should the Board tab support side-by-side split with the Shell (not
  just Cmd+B toggle) once we have multi-viewport arbitration solid?
- What is the exact IPC protocol for the `metaide` CLI over UDS —
  JSON-RPC, protobuf, or hand-rolled? Decision deferred until Phase 6
  scoping.
- Should sub-agent output (Claude sub-agents launched inside the shell)
  be surfaced as separate mirror viewports in Wall Mode? Requires
  Claude Code to expose sub-agent PTY streams via a stable protocol.

**Companion `metaide` CLI sketch** (Phase 6+):
- `metaide ls` — list roots and projects, with alive-shell markers.
- `metaide open <fuzzy>` — spawn or focus a shell for the matched project.
- `metaide switch <fuzzy>` — same as `open` but stays on current tab.
- `metaide status` — current project, alive shells, unread mentions.
- `metaide roots add <path>` / `metaide roots ls`.
- `metaide config get|set <key> [<value>]` — read/write global or
  per-project settings.
- `metaide wall` — enters Wall Mode in the running metaIDE.
- `metaide chat send <project> <message>` — send a chat message to a
  project's `#general` from the CLI.
- Transport: Unix socket at `~/.metaide/metaide.sock`. CLI is a thin
  RPC client; all business logic stays in the running metaIDE.

---

## 14. Delivery Phases

Suggested cut-lines for incremental delivery, in order:

**Phase 1 — Shell-first MVP**
- Electron scaffold, xterm.js with WebGL, `node-pty` per project.
- SQLite schema (WAL, migrations, backups), roots + projects + discovery.
- Sidebar, project switcher, keep-alive with cap, Alive Shells panel.
- Global + per-project launch command templates (argv-based).
- Typed IPC contract module (§11.7).
- No chat, no editor, no Docs, no Board. Files tab read-only.

**Phase 2 — Editor & Files**
- CodeMirror 6 integration, Markdown UX, split preview.
- Files tab full CRUD, find in project (ripgrep).
- 2-way document conflict resolution UI (used later in Phase 3).

**Phase 3 — Metaproject Integration (reads)**
- MCP client with long-lived connection + config-file watcher.
- Docs tab (view/edit ticket + standalone documents).
- **Board tab** (BrowserView embedding metaproject web board, `Cmd+B` toggle).
- First-run wizard (with direct-write to `~/.claude.json` gated on
  schema version check).

**Phase 4 — Chat**
- Backend: new tables, MCP tools, WS endpoint with first-frame auth.
- **RLS test suite** for cross-tenant isolation — gates Phase 4 sign-off.
- Client: Chat tab, presence, mention-only-by-default notifications with
  rate limit and DND.

**Phase 5 — Polish & Power Features**
- Pop-out shells + Wall Mode + multi-viewport input arbitration.
- Model switcher (agent-declared) + upgrade flow with install-method
  detection.
- Auto-updater with active-shell guard.
- Telemetry (opt-in), crash reporting (Sentry).
- Full E2E suite.

**Phase 6+ — Deferred**
- `metaide` CLI over Unix socket.
- User-managed tmux attach.
- Multi-shell per project in the UI (schema already ready).
- 3-way document merge (if metaproject ships `documents_history`).

Each phase is releasable to internal users on its own.

---

## 15. Revision History

| Version | Date       | Notes                                                            |
| ------- | ---------- | ---------------------------------------------------------------- |
| v0.1    | 2026-07-18 | Initial draft from brainstorming session.                        |
| v0.2    | 2026-07-18 | Peer-review pass by architecture-reviewer agent + Board tab addition (embeds metaproject web board via BrowserView, not custom Kanban). Key changes: shell schema pre-keyed by `(project_id, shell_index)`; `launch_cmd` stored as argv (not shell string); WAL + backups + migrations; multi-viewport input arbitration; softened LRU eviction UX with Alive Shells panel; agent-declared model switcher (versioned + fail-loudly); upgrade flow with install-method detection + active-shell guard; MCP long-lived connection + config-file watcher; WS ticket delivered via first-frame message (not URL); notification rate limit + per-channel mute + DND; direct-write first-run wizard with schema check; watched-path cap; 2-way doc merge for v1; typed IPC contract module (§11.7); RLS test suite gates Phase 4; §13 open questions trimmed to items still unanswered. |

---

**End of specification.**
