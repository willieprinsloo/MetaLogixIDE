# Architecture

## Overview

MetaLogix IDE is an Electron desktop app with a main process (`src/main/`),
a preload script (`src/preload/`) and a React renderer (`src/renderer/`). The
renderer calls the main process through the IPC API that the preload script
exposes as `window.api` (`src/renderer/api.ts:4`).

This document is incomplete. At this time it describes only the Markdown
preview pipeline, terminal focus, Claude notifications and the Claude status
dots. The product design is in
`docs/superpowers/specs/2026-07-18-metaide-design.md`.

## Components

### Markdown preview pipeline

The Files tab shows a rendered preview for `.md`, `.markdown` and `.mdx`
files. `FilesTab.tsx` mounts `MarkdownPreview` only when the file is not in
Edit mode (`src/renderer/components/FilesTab.tsx:610`).

| Layer | File | Responsibility |
|---|---|---|
| Presentation | `src/renderer/components/MarkdownPreview.tsx` | Sets the rendered HTML, starts diagram rendering, and routes link clicks. |
| Presentation | `src/renderer/hooks/useDocumentTheme.ts` | Gives the effective light or dark theme. |
| Logic | `src/renderer/markdown/markdownRenderer.ts` | Owns the one `markdown-it` instance. Converts Markdown to an HTML string. |
| Logic | `src/renderer/markdown/fenceRule.ts` | Changes `mermaid` fences into placeholders and `math` fences into display math. |
| Logic | `src/renderer/markdown/math/mathPlugin.ts` | `markdown-it` plugin for the math delimiters. |
| Logic | `src/renderer/markdown/math/renderMath.ts` | Calls KaTeX. Changes a KaTeX error into an escaped error span. |
| Logic | `src/renderer/markdown/previewLinks.ts` | Decides if a link click opens externally or does nothing. |
| Logic | `src/renderer/markdown/mermaid/useMermaidDiagrams.ts` | Finds the placeholders and renders them one at a time. |
| Adapter | `src/renderer/markdown/mermaid/mermaidRenderer.ts` | Wraps the `mermaid` library behind the `DiagramRenderer` interface. Chooses the app palette or the diagram's own theme. |
| Adapter | `src/renderer/markdown/mermaid/themeTokens.ts` | Reads the live theme tokens from the computed style of `<html>`. |
| Logic | `src/renderer/markdown/mermaid/mermaidPalette.ts` | Turns the theme tokens into Mermaid `themeVariables`. Pure; never reads the DOM. |
| Logic | `src/renderer/markdown/mermaid/categoricalColours.ts` | Picks distinct pie, gitGraph and journey colours from the app's hues. |
| Logic | `src/renderer/markdown/mermaid/colour.ts` | Colour parsing, compositing, WCAG contrast and lightness adjustment. |
| Contract | `src/renderer/markdown/mermaid/paletteContract.ts` | Token names, reference materials and contrast thresholds shared by the palette and the E2E suite. |
| Contract | `src/renderer/markdown/contract.ts` | Class names, attributes, messages and types that the other files and the E2E suite share. |

### Terminal focus

When a window gains OS focus, or the user switches project, the visible
shell terminal takes keyboard focus, so typing goes to the Claude Code
prompt without a click. One
coordinator per window makes the decision. Each renderer window is its own
JS realm, so a module-level instance gives one owner per window.

| Layer | File | Responsibility |
|---|---|---|
| Logic | `src/renderer/terminal-focus.ts` | Classifies the active element, holds the focus rules, and builds the coordinator. DOM-free. |
| Adapter | `src/renderer/hooks/useWindowTerminalFocus.ts` | Creates the window's one `terminalFocus` coordinator. Owns the `window` `focus` and `blur` listeners and passes the overlay flag in a layout effect. This is defensive: it keeps the flag current before any later task, such as an awaited IPC reply, issues a request. React 18 already flushes passive effects at the end of a click or key commit, so the existing tests pass with either effect. |
| Presentation | `src/renderer/components/ShellTab.tsx` | Registers its terminal, and reports when it opens, when it is used, and when it unmounts. |
| Presentation | `src/renderer/App.tsx` | Computes the overlay flag, marks the left pane and the popout terminal as `primary`, forwards `shell:focus-request`, popout open and scrollback-search jumps to `requestFocus`, and project switches (sidebar, switcher, new-project dialog) to `requestProjectFocus`. |

Rules:

- On window focus, a terminal takes focus only when no overlay is open and
  focus is on nothing or on a non-text control. Focus in a text field, the
  editor, the find box or the chat panel stays where it is.
- The target is the last-used terminal, then the `primary` terminal, then
  the only terminal. A target that has not opened yet takes focus when it
  opens, and the rule is checked again at that moment.
- A notification click, a popout open or a jump from scrollback search
  requests a specific shell. A project switch requests the target
  project's `primary` (left-pane) terminal, whichever shell it shows. There
  is one pending request; a newer one replaces it, and starting a new
  switch or scrollback jump cancels it. A switch that lands on the Files
  tab requests nothing.
- A request expires after `FOCUS_REQUEST_TTL_MS`. It is honoured when no
  overlay is open and no text-entry element has focus, checked when the
  terminal opens, or at once when it is already open. A window blur drops
  it.
- The focus call runs synchronously in the window `focus` handler. On
  Windows and Linux, an activating click on a text field therefore keeps that
  field focused. On macOS the activating click does not reach the page,
  because `acceptFirstMouse` is off. The terminal takes focus, and a second
  click moves focus to the field.
- In-app shell tab switches and main-tab (Files ↔ Shell) switches do not
  move focus.

### Claude notifications

The app shows an OS notification when Claude Code, running in an app
shell, needs the user's input or finishes its turn. Claude Code reports
these events through its own hooks. The app does not read terminal output
or escape sequences for this.

| Layer | File | Responsibility |
|---|---|---|
| IO | `src/main/claude-hooks/receiver.ts` | Loopback HTTP server. Checks the request, authenticates it, answers `204`, then passes a typed event on. |
| IO | `src/main/claude-hooks/settings-file.ts` | Builds, writes and removes the app-owned Claude Code settings file. |
| Logic | `src/main/claude-hooks/hook-event.ts` | Parses a hook payload into a `HookEvent`. Keeps only the event name, notification type, message and the number of background tasks. Classifies an event as `needs-input`, `finished` or `ignored`, and maps it to a state transition (`stateTransitionFor`). |
| Logic | `src/main/claude-hooks/hook-fanout.ts` | Registers the receiver's one listener and delivers each hook to several listeners. A failure in one listener is logged and does not stop the others. |
| Logic | `src/main/claude-hooks/session-registry.ts` | Issues, verifies and releases the per-spawn id and secret. Records which shells are hook-confirmed. |
| Logic | `src/main/claude-hooks/launch-decorator.ts` | Adds `--settings <file>` and the id and secret to the environment of a Claude launch, just before spawn. |
| Logic | `src/main/claude-hooks/runtime.ts` | Starts the receiver, then writes the settings file. Stops both on quit. |
| Contract | `src/main/claude-hooks/protocol.ts` | Hook path, header name and environment variable names. |
| Logic | `src/main/notifications/claude-notifier.ts` | Decides if an applied hook shows a notification, from the state before and after the tracker applied it. Builds the text and keeps one notification per shell. Also `withoutHookConfirmed`, the filter for the generic notifier. |
| Logic | `src/main/notifications/viewed-shells.ts` | Holds the shells the main window shows. Decides if the user is viewing a shell. |
| Adapter | `src/main/notifications/os-notifications.ts` | Wraps Electron `Notification`. Keeps each instance referenced until it is clicked or closed. |
| Composition | `src/main/notifications/install.ts` | Connects the Claude state tracker's `onHookApplied` stream, the notifier, windows and PTY exit events. Builds the click navigation. |
| Presentation | `src/renderer/viewed-shells.ts`, `src/renderer/hooks/useReportViewedShells.ts` | Derive the shells on screen and report them on `notifications:viewed-shells`. |
| Presentation | `src/renderer/components/Settings.tsx` | The two toggles in Settings → General. |

Rules:

- A Claude shell is a shell whose launch argv starts with `claude`,
  `claude.exe` or `claude.cmd` (`isClaudeArgv`). Other shells spawn
  unchanged. A launch that already has `--settings` also spawns unchanged.
- On Windows, a launch that runs through `cmd.exe /c` (an npm `.cmd`
  shim) spawns unchanged when the settings path contains whitespace.
  node-pty quotes the shim path and the settings path, and `cmd /c` then
  removes the outer quotes and cannot start Claude. That shell keeps the
  generic notifier.
- The stored launch argv is never decorated. `PtyManager` applies the
  decorator to a copy inside `spawn`.
- Notifications follow the Claude state (see "Claude status dots"). The
  notifier reads each hook after the tracker applied it, with the shell's
  state before and after.
- Needs input is a `Notification` event with `notification_type`
  `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog` or
  `agent_needs_input` that leaves the shell blocked. Claude Code's question
  prompt also arrives as `permission_prompt`. A stale needs-input event
  leaves the shell as it is and shows nothing.
- Finished is a `Stop` event with no background tasks that moves the shell
  from busy to idle. A `Stop` with background tasks, a `Stop` on an idle
  shell, and an idle state from the stale-busy guard, `idle_prompt`,
  `StopFailure` or a PTY exit show nothing.
- All other events show nothing, but any confirmed event marks the shell
  hook-confirmed. The tracker confirms the session.
- The generic "Command finished" notifier skips hook-confirmed shells.
  Before a shell is confirmed, the generic notifier is its fallback.
- The user is viewing a shell when its popout window has focus, or when
  the main window has focus, shows the shell, and the shell is not popped
  out. In split view, both panes are shown.
- A new notification for a shell closes the previous one. A PTY exit
  releases the shell's session and closes its notification, unless a
  respawn has already replaced that PTY.

### Claude status dots

Each live dot shows the Claude state of its shell: idle (green), busy
(amber) or blocked (red). The main process derives the state and pushes it
to every window. Renderers never read terminal text for it.

| Layer | File | Responsibility |
|---|---|---|
| Contract | `src/shared/claude-state.ts` | `ClaudeShellState`, the state entry, the text label per state and the DOM test hooks. |
| IO | `src/main/ipc/register.ts` | `claude-state:list` returns every shell that is not idle. |
| Service | `src/main/claude-status/state-tracker.ts` | The state machine per shell. Confirms each hook session. Emits `onChange` on real transitions and `onHookApplied` for every confirmed hook. |
| Logic | `src/main/claude-status/answer-input.ts` | `isAnsweringInput`: Enter, a lone Esc, Ctrl-C or a single digit 1-9. |
| Composition | `src/main/claude-status/install.ts` | Connects the hook fan-out, PTY `input` and `exit` events and a 1 s guard tick to the tracker. Broadcasts `claude-state:changed`. |
| Adapter | `src/main/pty/manager.ts` | `write()` emits `input` for every write to a shell. |
| Logic | `src/renderer/claude-state.ts` | Pure snapshot and delta reducers, and the worst state of a shell, a project or all shells. |
| Presentation | `src/renderer/hooks/useClaudeStates.ts` | One store per window. Fetches the snapshot on first use, applies deltas, and fetches again on `alive-shells:changed`. |
| Presentation | `src/renderer/components/StatusDot.tsx` | The dot: colour from `data-claude-state`, `title` and `aria-label` from the state label. |
| Style | `src/renderer/styles.css` | `--claude-idle`, `--claude-busy` and `--claude-blocked` per theme, and the 1 px white ring on the active Project Switcher row. |

Rules:

- A shell with no current hook session is always idle. The tracker keeps a
  state only while its session is the shell's current session, so a
  respawn or a release reads idle.
- `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and `PostToolUseFailure`
  set busy. `PermissionRequest` and a needs-input `Notification` set
  blocked.
- `Stop` with no background tasks and `StopFailure` set idle. `idle_prompt`
  sets idle unless the shell waits on background work.
- `Stop` with background tasks sets busy and marks the shell as waiting on
  background work. Claude Code resumes when that work reports back.
  `session_crons` does not count.
- An answering keystroke moves a blocked shell to busy. Terminal reports,
  such as focus and cursor-position replies, and arrow keys do not.
- A needs-input `Notification` that arrives after an answering keystroke,
  with no hook since, is stale and is ignored.
- A busy shell with no PTY output for 15 s becomes idle, unless it waits on
  background work. Blocked never expires.
- Per-shell dots show the shell's state. Project dots show the worst state
  of the project's live shells. The "In use" header shows the worst state
  of all live shells. An inactive shell tab is grey when idle.

### Project environment variables

Each project can store environment variables. Every shell the app starts
for the project gets them: the primary launch (first, subsequent and the
no-session fallback), plain shells, CLI profiles, custom commands and task
runs. The user edits them in the project's Env tab, next to Shell and
Files. The sidebar context menu item "Environment variables…" selects the
project and opens that tab.

| Layer | File | Responsibility |
|---|---|---|
| Contract | `src/shared/project-env.ts` | Name and value rules (`envNameProblem`, `envValueProblem`) and `parseProjectEnv`, used by the editor and the IPC handler. |
| Logic | `src/main/domain/spawn-env.ts` | `resolveSpawnEnv`: the environment overlay for one spawn, and the lookup for `${env.NAME}` in launch argv. Never reads `process.env`. |
| Logic | `src/main/domain/launch.ts` | `resolveLaunch` takes the inherited environment and uses `resolveSpawnEnv` for the primary launch. |
| IO | `src/main/ipc/register.ts` | `projectSpawnEnv` for the plain shell, CLI and task sites. `validatedConfigPatch` checks `projects:update-config` before it writes. That channel emits `projects:changed`. |
| Logic | `src/renderer/project-env-rows.ts` | The editor's row model: rows from the stored map, per-row problems, `canSave` and rows back to a map. |
| Logic | `src/renderer/project-env-rows.ts` → `isDraftDirty` | Decides if a draft differs from the stored map: the ordered non-blank rows against the ordered stored entries. |
| Presentation | `src/renderer/hooks/useEnvDrafts.ts` | Holds unsaved drafts per project, in memory only. A draft lasts until Save, Discard or app close. |
| Presentation | `src/renderer/components/ProjectEnvTab.tsx` | The Env tab body. Reads the project fresh through `projects:list` when it mounts, edits the draft, and saves only `{ env }`. Save stays disabled until the stored values have loaded. |
| Contract | `src/renderer/main-tab.ts` | `MainTab` (`shell`, `files`, `env`) and `isMainTab`, the validator for the persisted tab. |
| Contract | `src/renderer/project-env-copy.ts` | Every string and test id of the editor. |

Rules:

- Precedence, lowest to highest: the app's inherited environment, the
  template env (the launch command, CLI profile or custom command env),
  the project variables, and the Claude hook variables. `PtyManager`
  layers the inherited environment underneath and the launch decorator
  layers the hook variables on top.
- A valid name matches `^[A-Za-z_][A-Za-z0-9_]*$`, has at most 255
  characters, does not start with `METAIDE_` (any case) and is not
  `__proto__`, which a plain object would drop on save. A value must
  not contain a NUL character. An empty value sets the variable to the
  empty string. Stored entries that break these rules are skipped at spawn.
- Project values can use `${HOME}`, `${PROJECT_PATH}`, `${PROJECT_NAME}`
  and `${env.NAME}`. `${env.NAME}` reads the inherited environment with the
  template env on top, in one pass. A project variable cannot read another
  project variable. An unset name gives the empty string.
- `${env.NAME}` in launch argv reads the final environment: inherited,
  then template env, then project variables. On a name clash, argv sees
  the project value. Template env values reach argv after interpolation,
  so `X=${HOME}/t` gives argv the expanded path, not the literal token.
- Template env values are interpolated as before this feature, against
  the stored project map and the template env, without the inherited
  environment.
- CLI profile and custom command env is passed as it is, without
  interpolation.
- Saving replaces the whole map, so a removed row is gone. Shells that
  already run keep their environment. Changes apply to the next spawn.
- Unsaved edits stay as a draft for each project when the user switches
  tab or project. The Env tab label shows `•` while a draft differs from
  the stored values. Discard drops the draft.
- The Env tab does not count as viewing a shell for notifications.
  Switching from Env back to Shell does not focus the terminal, the same
  as switching from Files. The sidebar handler sets the tab before it
  selects the project, so the project switch queues no terminal focus.
- On Windows, the inherited environment can hold `Path` instead of `PATH`.
  `${env.PATH}` is case-sensitive and then gives the empty string. This is
  a known limitation.

## Data Flow

1. `MarkdownPreview` calls `renderMarkdown(source)`. This is synchronous.
2. `markdown-it` parses the source. The math plugin renders math through
   KaTeX during the parse. The fence rule emits one placeholder per `mermaid`
   fence, with the escaped source and `data-mermaid-state="pending"`.
3. React sets the HTML string into the preview container.
4. `useMermaidDiagrams` finds the placeholders. It renders each one through
   `mermaidRenderer`, in document order. It yields to the event loop between
   diagrams (`useMermaidDiagrams.ts:47`).
5. For each diagram, the hook adds an output element or an error element to
   the block. It sets the block state to `rendered` or `error`. The source
   element stays in the block. CSS hides it when the state is `rendered`.
6. A theme change or a new HTML string starts the hook again. The effect
   cleanup cancels the previous run. The run also stops when a block is no
   longer in the document (`useMermaidDiagrams.ts:64-79`).

A link click in the preview always calls `preventDefault`
(`MarkdownPreview.tsx:22`). The handler reads `href`, then `xlink:href`.
Links inside a diagram do nothing. `http`, `https`, `mailto` and `file`
links outside a diagram open through the `app:open-external` IPC channel.

### Claude notification event

1. At app start, `runtime.ts` starts the receiver on an ephemeral
   `127.0.0.1` port. It then writes
   `~/.metaide/claude-hooks/settings-<port>.json`. The file registers
   `http` hooks for `Notification`, `Stop`, `UserPromptSubmit`,
   `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`
   and `StopFailure`, with a timeout of 1 second.
2. When a Claude shell spawns, the decorator issues a session id and a
   secret. It adds `--settings <file>` after `argv[0]`, and
   `METAIDE_HOOK_SHELL` and `METAIDE_HOOK_TOKEN` to the environment.
3. Claude Code posts each hook event. It fills the `X-Metaide-Shell` and
   `Authorization: Bearer` headers from those environment variables.
4. The receiver checks method, path, `Host`, content type, the id and
   secret, and then the body size (1 MiB at most). It answers `204` with no
   body, and only then passes the event on through the fan-out. Claude Code
   never gets a decision from the app.
5. The tracker confirms the session, marks the shell hook-confirmed and
   applies the event. It broadcasts `claude-state:changed` when the state
   changed, and emits the applied hook with its before and after state.
6. The notifier classifies the applied hook. It reads the toggle, checks
   that notifications are supported, and checks if the user is viewing the
   shell. Then it shows the notification.
7. A click on a popped-out shell's notification focuses the popout.
   Otherwise the main window is restored and focused, and
   `shell:focus-request` is sent only while the shell is still alive.

### Project environment variables at spawn

1. The user saves the Env tab. `projects:update-config` runs
   `parseProjectEnv` on `env`. An invalid map is rejected before any write,
   with an error that names the key and never the value.
2. `ProjectsRepo.updateConfig` merges the patch shallowly, so `env`
   replaces the stored map. The handler emits `projects:changed`.
3. A spawn site builds its template env and calls `resolveSpawnEnv` with
   the project, the template env and `process.env`.
4. `resolveSpawnEnv` interpolates the valid project variables against the
   inherited environment with the template env on top. It returns the
   template env with the project variables on top.
5. `PtyManager.spawn` starts the PTY with `process.env` underneath that
   overlay. For a Claude shell, the launch decorator adds the hook
   variables last.

## Authorization Model

Not applicable to the preview. It reads only the local file buffer.

The Claude hook receiver accepts requests only on `127.0.0.1`, with a
`Host` header that matches its port. Each Claude spawn gets its own
32-byte secret. The receiver compares it with `timingSafeEqual`. The
secret is in the PTY environment only, never in argv, in the settings file
or in logs. Processes that Claude starts inherit the secret, so they can
raise notifications and change the dot colour for that shell only. A
released session no longer authenticates. Authentication runs before the
body is read, so an unauthenticated request never has its body buffered.

The `claude-state:list` reply and the `claude-state:changed` event carry
only `projectId`, `shellIndex` and `state`. No hook message, tool input,
tool response or background task leaves the parser. The tracker never logs
PTY input.

Project variable values are stored in plain text in the project's
`config_json` in SQLite, and the database backups copy them as they are.
They reach the renderer with every project in `projects:list`. The editor
says that values are stored unencrypted. Values are never logged and never
shown in a notification or toast. One exception: when the user's own launch
command uses `${env.NAME}` for a project variable in its argv, the resolved
argv is stored in the shell row, as every resolved launch argv is. The
Env tab says so. An inherited value that argv reads through `${env.NAME}`
is stored there the same way.

## Infrastructure Dependencies

| Dependency | Version | Use |
|---|---|---|
| `markdown-it` | 14.3.0 | Markdown parser. `html` is `false`. |
| `highlight.js` | lockfile | Code block highlighting. |
| `katex` | 0.16.47, exact pin | Math. Also the version `mermaid` depends on, so the bundle has one copy. |
| `mermaid` | 11.17.2, exact pin | Diagrams. Version 12 requires Node 22, and the repo uses Node 20. |

## Architectural Decisions

- **Mermaid loads lazily.** `mermaidRenderer.ts` reaches `mermaid` only
  through `import('mermaid')` (`mermaidRenderer.ts:52`). Vite puts it in a
  separate chunk. A document without diagrams does not load it.
- **Mermaid security configuration.** The adapter calls `initialize` with
  `securityLevel: 'strict'`, `suppressErrorRendering: true` and
  `startOnLoad: false` (`mermaidRenderer.ts:91-94`), in both the palette and
  the directive-theme branch. It does not set
  `secure`, so the Mermaid default secure keys apply and an `%%{init}%%`
  directive cannot change `securityLevel`.
- **Mermaid renders into a scratch element.** `mermaid.render` clears the
  element it receives. The adapter gives it a temporary child of the block
  and removes that child after the render (`mermaidRenderer.ts:180`). The
  child is absolutely positioned and hidden, so it does not change the block
  height while Mermaid lays out the diagram. This
  keeps the block source for the next render.
- **Diagram results are cached.** The adapter keeps up to 50 SVG results,
  keyed by theme, the theme token values and source
  (`mermaidRenderer.ts:139`, `:211`). A token change misses the cache. The
  derived palette is memoised per theme and token set, up to four entries
  (`mermaidRenderer.ts:39`).
- **Diagram palette comes from the live tokens.** Every render reads the
  theme tokens listed in `paletteContract.ts` from the computed style of
  `<html>`, so System mode and both explicit themes need no extra logic.
  `mermaidPalette.ts` derives Mermaid `base`-theme `themeVariables` from them.
  There is no second, hand-copied colour list. Text uses the exact `--text`
  token. Node and box fills are `--panel-strong` and `--panel` composited over
  the lighter reference background (the plan's near bound). Lines, borders
  and the accent roles keep their token's hue and are
  moved in lightness until they reach 3:1 against both reference backgrounds.
  Categorical colours start from the icon and highlight.js hues, avoid
  `--danger`, and are at least CIEDE2000 15 apart. Every emitted value is an
  opaque `#rrggbb`, because Mermaid's colour library cannot parse `var()` or
  `color-mix()` and keeps alpha. A token that cannot be parsed fails every
  diagram with an error that names the token; there is no fallback palette.
  The same holds when the tokens leave no feasible categorical palette: if no
  hue turn or lightness shift of a seed meets the contrast rules, or none
  stands far enough from the earlier categories and `--danger`, every
  diagram fails with a `CategoricalColourError` naming the seed's token and
  the unmet rule (`categoricalColours.ts`).
  The unit suite runs the real `styles.css` token blocks through the palette.
- **Directive-themed diagrams get no app palette.** Mermaid merges the
  `themeVariables` given to `initialize` into a directive's theme. The adapter
  therefore calls `mermaid.parse` first (`mermaidRenderer.ts:217`). If the
  source's own directive or frontmatter sets `theme` to one of Mermaid's theme
  names, it calls `initialize` with no `theme` and no `themeVariables`
  (`mermaidRenderer.ts:64-88`). The names are every value of Mermaid's own
  `MermaidConfig['theme']` type in 11.17.2: `default`, `base`, `dark`,
  `forest`, `neutral`, `neo`, `neo-dark`, `redux`, `redux-dark`,
  `redux-color`, `redux-dark-color` and `null`. The list is checked against
  that type with `satisfies`, so a Mermaid upgrade that adds or drops a theme
  fails the build. `base` counts, so an author's own `base` palette is left
  as it is. Any other value, such as `Dark` or a typo, is ignored by Mermaid
  too, so the diagram keeps the app palette. Otherwise it uses
  `theme: 'base'` with the app palette. Only the `theme` and
  `themeVariables` keys of the parsed config are read.
- **Directive `themeVariables` without a `theme` re-derive what they feed.**
  Mermaid does not re-derive the theme for such a directive, so an explicit
  palette `mainBkg` would hide an author's `primaryColor`.
  `withAuthorVariables` (`mermaidPalette.ts`) adds the author keys to the
  `initialize` palette and drops every palette colour that Mermaid's `base`
  theme derives from them, so Mermaid derives those from the author's value.
  All other roles keep the app palette. Only plain keys are folded in, and
  only when the value passes Mermaid's own directive filter and is written in
  a form that Mermaid's colour library and the palette both read the same
  way: unpadded `#rgb`, `#rrggbb` or `#rrggbbaa`, or comma-separated
  `rgb()`/`rgba()`. Mermaid's colour library throws on other forms under
  `base` (`none`, a typo such as `#ff00f`, a padded value, four-part space
  syntax), which would fail the whole diagram;
  such a value is left out, and Mermaid still overlays it from the directive
  at render time without re-deriving, as it did before the palette.
- **Reference backgrounds.** The preview pane paints no background of its
  own: Tailwind 3.4 emits no rule for `bg-[--panel]/40`, because it drops a
  `var()` colour with an opacity modifier. A diagram therefore lands on
  `--bg`, painted by both `html` and `body`, over the window's vibrancy
  material. `capturePage` cannot see that material, so the palette checks
  contrast against `--bg` painted twice over black and over white
  (`REFERENCE_MATERIALS`, `BG_LAYERS` in `paletteContract.ts`).
- **KaTeX runs untrusted.** `renderMath.ts:5-10` sets `trust: false`,
  `maxSize: 20` and `maxExpand: 1000`.
- **Own math plugin.** No maintained plugin supports `markdown-it` 14 and all
  five delimiters. The inline rule runs before the `escape` rule
  (`mathPlugin.ts:238`), so it sees `\(` and `\[`.
- **Theme comes from the document.** `useDocumentTheme` reads
  `<html data-theme>`, then the `prefers-color-scheme` media query
  (`useDocumentTheme.ts:13-15`). It does not use `useTheme`, because each
  `useTheme` call holds its own state.
- **Fonts are never inlined.** The CSP has no `font-src`, so a `data:` font
  is blocked. The renderer build excludes font files from asset inlining
  (`electron.vite.config.ts:63`). The KaTeX stylesheet is imported in
  `src/renderer/main.tsx:5`.
- **Terminal focus uses the renderer `window` focus event.** On macOS,
  webContents `focus` and `blur` do not fire when the user switches between
  windows, so the coordinator listens on the renderer `window` instead.
  Unit tests cover the coordinator in the node environment. The E2E suite
  (`tests/e2e/terminal-window-focus.spec.ts`) dispatches a synthetic
  `focus` event on `window`. A real `BrowserWindow.blur()`/`focus()` cannot
  drive it: Playwright enables focus emulation on every page it attaches,
  and with emulation off, `blur()` does not resign key while no other window
  or app can take focus. Real macOS app activation delivers the event; this
  was verified by hand, not by the suite.
- **Claude events come from hooks, not terminal output.** By default,
  Claude Code sends no bell and no notification escape sequence to an
  xterm.js terminal. A bell also does not tell which event happened. The
  hook payload gives the event type and message. Tools that read the
  terminal title spinner or the screen text break when Claude Code changes
  its interface. The status dots use the PTY only for two things: answering
  keystrokes, because no hook fires when the user answers a prompt, and
  output silence, because no hook fires when the user interrupts a turn.
- **A `Stop` with background tasks is not the end of the work.** Claude
  Code fires `Stop` when the main agent stops responding, also while
  background shells, subagents or teammates still run. The `background_tasks`
  list in the payload tells the two cases apart. Only its length is kept.
- **One state drives the dots and the notifications.** The notifier reads
  the tracker's applied hooks, not the receiver. A stream of state changes
  alone is not enough: `PermissionRequest` sets blocked, and the
  `permission_prompt` notification about 6 s later does not change the
  state but must still notify.
- **Hooks are `http`, not `command`.** An `http` hook needs no shell,
  `curl` or `node` on the PATH, so the same file works on Windows. HTTP
  errors and timeouts do not block Claude Code.
- **Hooks are injected with `--settings`.** Hook lists from `--settings`
  merge with the user's and the project's hooks. The app does not write to
  `~/.claude`, `~/.claude.json` or the project's `.claude/` directory.
- **One settings file per app instance.** The file name has the receiver
  port in it. Two instances that share one home directory, for example a
  packaged app and a development build, do not redirect each other's
  shells.
- **`UserPromptSubmit` confirms the shell early.** `SessionStart` does not
  support `http` hooks. `UserPromptSubmit` fires before each turn, so the
  shell is confirmed before the generic notifier can fire during the turn.
- **Notifications stay referenced.** Electron can garbage-collect a
  `Notification` that only a local variable holds, and its `click` event
  then does not fire (electron/electron#21610).
- **Windows needs an AppUserModelID.** `index.ts` calls
  `app.setAppUserModelId('com.metalogix.metaide')` on Windows. Windows and
  Linux notifications were checked by code review only.
- **One resolver for every spawn site.** Before this feature, only the
  primary launch applied project env, and its argv lookup used the reverse
  precedence of its env. `resolveSpawnEnv` computes both for every site, so
  the precedence cannot drift between sites again.
- **The editor reads the project fresh.** The App's `projects:changed`
  listener ignores `config.env`, so the Env tab loads the project through
  `projects:list` each time it mounts instead of using cached state.
