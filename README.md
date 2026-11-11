# MetaLogix IDE

A CLI-agent-first workspace for working with Claude Code, Codex, Ollama, and
every other coding CLI that lives in a terminal. metaIDE wraps those agents
with the IDE layer they've been missing: a shared project view, live file
editor, structured activity log across shells, P2P discovery of your other
dev machines, and a built-in bridge to [metaproject].

Built on Electron 32 + React 18 + TypeScript.

## What it does

### Terminal-first project workspace
- Multi-tab shells per project, each running Claude, OpenAI Codex or
  opencode, or a custom command you save per-project. Agent shells resume
  their last session in the project when reopened.
- Project switcher, file finder, prompt library, cross-shell scrollback
  search, port detection, hot/hanging shell watchdog.
- Shared agent memory: every CLI tool call, user prompt, and turn-end is
  appended to `<project>/.metaide/activity.jsonl` so multiple shells on
  one project see each other's work in a single live timeline. Tail it
  from any terminal with `tail -f .metaide/activity.jsonl`.

### Rich file viewers
- Markdown editor + preview with `⌘+` / `⌘-` / `⌘0` zoom and
  `⌘⇧Enter` native fullscreen.
- Image viewer (PNG / JPG / GIF / SVG / WebP / AVIF / BMP / ICO) — fit-to-
  window, wheel zoom, drag to pan, checkerboard transparency.
- PDF viewer backed by pdfjs — themed toolbar, continuous scroll, lazy
  render per page, page-number nav.

### Fleet view
Top-level pane showing every machine you've paired with — your own, every
remote, the lot. Click a live shell to jump; the local ones switch project
and shell, the remote ones open a remote pane.

### P2P across your machines
- Pair two metaIDE instances with a short code (via the embedded relay or
  your own `mrsignald`).
- WebRTC data channels carry RPC between paired peers; keepalive + request
  timeout + auto-reconnect keep links alive through NAT and sleep cycles.
- Long-lasting connections: known devices are dialled eagerly on startup
  with exponential backoff; one side revoking is an explicit `peer_revoked`
  wire message.

### metaproject integration
First-class bridge to the MetaLogix metaproject board: project linking,
chat pane fed by the metaproject socket, status-bar badges for the active
project.

### `.metaide/` project convention
Check into git to make the project "just work" on every teammate's machine:

```
<project-root>/.metaide/
├── env                    # dotenv overlay merged into every shell spawn
├── cli-profiles.json      # per-project CLI catalog (JSON array of {name, argv, env?, icon?})
└── activity.jsonl         # written by the IDE — append-only, agent-shared timeline
```

Precedence: `inherited env < app settings < .metaide/env < template env <
project settings`. CLI profiles from `.metaide/cli-profiles.json` shadow
globals and are shadowed by per-user project profiles.

## Development

```bash
pnpm install            # one-time
pnpm dev                # dev + HMR
pnpm typecheck          # TypeScript check across node + web
pnpm test               # vitest
pnpm dist:mac           # package a signed DMG + zip (arm64 + x64)
```

If better-sqlite3 complains about `NODE_MODULE_VERSION`:
- `pnpm rebuild better-sqlite3` — for CLI node (tests)
- `pnpm postinstall` or `./node_modules/.bin/electron-rebuild -f -w better-sqlite3`
  — for Electron (dev + packaging)

## Project layout

```
src/
├── main/                  # Electron main process
│   ├── activity/          # Shared agent-memory log (hooks → .metaide/activity.jsonl)
│   ├── agent-status/      # Agent-state tracker (idle/thinking/needs-input)
│   ├── claude-hooks/      # Loopback receiver for Claude Code's `http` hooks
│   ├── db/                # better-sqlite3 handle + migrations
│   ├── domain/            # Pure logic (launch resolution, spawn env, …)
│   ├── drops/             # Drag-and-drop staging
│   ├── git/               # Git integration
│   ├── ipc/register.ts    # IPC channel wiring
│   ├── metaproject/       # metaproject client
│   ├── notifications/     # OS notifications for Claude needs-input / finished
│   ├── p2p/               # Relay client + RPC + WebRTC worker
│   ├── pty/               # node-pty management, keep-alive, scrollback
│   ├── repos/             # SQLite repositories
│   └── startup/           # Boot rescan + receivers
├── renderer/              # React 18 UI
│   ├── components/        # Views + shared UI
│   ├── hooks/             # Shared React hooks
│   ├── markdown/          # Markdown renderer + mermaid + math
│   └── p2p/               # Renderer-side p2p + remote-shell bridge
├── preload/               # contextBridge APIs
└── shared/                # Types + contracts used by both sides

migrations/                # SQLite schema migrations (0001..NNNN)
tests/                     # vitest unit + e2e
```

## Shortcut cheat sheet

| Keys          | Action                                        |
|---------------|-----------------------------------------------|
| `⌘K`          | Project switcher                              |
| `⌘P`          | Find file in project                          |
| `⌘⇧F`         | Find in project                               |
| `⌘⇧P`         | Command palette                               |
| `⌘⇧N`         | New project                                   |
| `⌘⇧K`         | Prompt library                                |
| `⌘T`          | New shell tab (with `⇧` → new window)        |
| `⌘W`          | Close active tab                              |
| `⌘⇧O`         | Search across every alive shell's scrollback  |
| `⌘F`          | Find in terminal                              |
| `⌘B`          | Toggle sidebar                                |
| `⌘⇧Enter`     | Toggle native fullscreen                      |
| `⌘=` `⌘-` `⌘0`| Zoom in / out / reset (shell + md + image + pdf) |
| `⌘,`          | Settings                                      |
| `⌘/`          | This cheat sheet (in-app)                     |

## License

Proprietary — © MetaLogix Solutions.
